"use strict";
// IPC methods of the desktop app (spec §3.1 and meta.get from §4.1). The renderer calls
// window.api.call(method, ...args) -> one generic "api" channel; methods are dispatched by name and answer
// { ok, result } or { ok: false, error } (the preload turns that into a rejected Error(message)).
//
// State kept here (not persisted): per suite id the runtime variables (captures), the cookie jar and the
// OAuth2 token cache; the running suite runs; the last run result; the local echo server.
//
// Local files: the page only names files, main decides what it may touch. A path from the page is accepted only
// when the user chose it in this session (file dialogs, files opened with the app) or the app wrote it (reports,
// exported suites). Uploads of local files (multipart file fields, binary bodies) need the user's approval per
// suite (workspace.fileApprovals): files picked with the app's file chooser are approved; any other file, e.g.
// one named by an imported suite, is not sent until the user allows it in a native dialog shown by main
// ("files.approve"), so neither a shared suite nor a compromised page can upload files on its own.
const fs = require("fs");
const path = require("path");
const { app, dialog, shell, BrowserWindow, nativeTheme } = require("electron");
const model = require("../core/model");
const { createScope, DYNAMIC_VARIABLES } = require("../core/variables");
const { writeFileAtomic } = require("./workspace");

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_DATA_FILE_BYTES = 20 * 1024 * 1024;
// "Allow once" covers the next send / run of the suite started within this time
const ONCE_APPROVAL_MS = 2 * 60 * 1000;
// files.openPath opens only reports this session saved (never programs or scripts)
const OPENABLE_REPORT = /\.(html?|xml|json)$/i;
// runs with many requests: results after this many keep a shorter response body (memory, IPC size)
const FULL_BODY_RESULTS = 100;
const TRIMMED_BODY_CHARS = 64 * 1024;

// Core modules load on first use, so a problem in one of them breaks only that feature, with a readable message.
const coreModules = new Map();
function core(name) {
    if (!coreModules.has(name)) {
        try {
            coreModules.set(name, require(`../core/${name}`));
        } catch (err) {
            throw new Error(`Internal module "${name}" could not be loaded: ${err.message.split("\n")[0]}`);
        }
    }
    return coreModules.get(name);
}

const clone = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** Default name of a saved report: "<suite name, cleaned like an exported suite> report 2026-10-22 16-41" (local time). */
function reportFileBase(suiteName, startedAt) {
    const suiteFile = core("suiteFile");
    const name = suiteFile.suiteFileName({ name: suiteName || "API Tester" }).slice(0, -(suiteFile.SUITE_EXTENSION.length + 1));
    let d = new Date(startedAt || Date.now());
    if (Number.isNaN(d.getTime())) d = new Date();
    const two = (n) => String(n).padStart(2, "0");
    return `${name} report ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}-${two(d.getMinutes())}`;
}

function intIn(value, fallback, min, max) {
    const n = Number(value);
    if (value === "" || value === null || value === undefined || !Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/** "https://host:port" of a URL (shown in the upload approval); the text itself when it is no URL. */
function originOf(url) {
    try {
        const u = new URL(String(url));
        return `${u.protocol}//${u.host}`;
    } catch (_) {
        return String(url || "");
    }
}

/**
 * May the app look at this path on disk at all (real path, link target)? An absolute local path. Never a Windows
 * network or device path (\\server\share, //server/share, \\?\..., \\.\...): only touching it makes Windows connect
 * to that computer and log in with the user's Windows (NTLM) credentials, so a shared suite could collect them.
 * Uses core's rule (prepare.isUploadablePath) when it has one, so the app and the upload itself agree.
 */
function isLocalPath(file) {
    if (typeof file !== "string" || !file || file.includes("\0")) return false;
    let prepare = null;
    try { prepare = core("prepare"); } catch (_) { /* own rule below */ }
    if (prepare && typeof prepare.isUploadablePath === "function") {
        try { return !!prepare.isUploadablePath(file); } catch (_) { return false; }
    }
    if (!path.isAbsolute(file)) return false;
    return !(process.platform === "win32" && /^[\\/]{2}/.test(file));
}

/**
 * Real path of a file (symbolic links resolved), or null. Only for files the user chose or allowed (and only
 * local ones): a path named by a suite is never touched before the user said yes.
 */
function realPathOf(file) {
    if (!isLocalPath(file)) return null;
    try {
        return fs.realpathSync(file);
    } catch (_) {
        return null;
    }
}

/** Where a symbolic link points (one step, for the approval dialog; nothing is followed), or null. */
function linkTargetOf(file) {
    if (!isLocalPath(file)) return null;
    try {
        if (!fs.lstatSync(file).isSymbolicLink()) return null;
        return path.resolve(path.dirname(file), fs.readlinkSync(file));
    } catch (_) {
        return null;
    }
}

/** Does the request (as saved or edited) upload a local file? Cheap check before preparing it. */
function hasFileBody(request) {
    const b = request && request.body;
    if (!b) return false;
    if (b.mode === "binary") return !!String(b.binaryPath || "").trim();
    if (b.mode === "multipart") return (b.multipart || []).some((p) => p && p.enabled !== false && p.type === "file" && String(p.filePath || "").trim());
    return false;
}

/** Local files of a prepared request: [{ path, kind, field }] (absolute paths as resolved by prepare.js). */
function uploadsOf(prepared) {
    const out = [];
    const push = (f) => { if (f && typeof f.path === "string" && f.path && !out.some((o) => o.path === f.path)) out.push(f); };
    for (const f of Array.isArray(prepared && prepared.files) ? prepared.files : []) push({ path: f.path, kind: f.kind || "", field: f.field || "" });
    if (prepared && typeof prepared.binaryPath === "string") push({ path: prepared.binaryPath, kind: "binary", field: "" });
    for (const part of (prepared && prepared.multipart) || []) {
        if (part && part.type === "file") push({ path: part.filePath, kind: "multipart", field: part.key || "" });
    }
    return out;
}

/** Request object from the renderer -> normalised request (same id, defaults filled). */
function normalizeRequest(request) {
    if (!isObject(request)) throw new Error("No request given");
    const suite = model.normalizeSuite({ items: [{ ...request, type: "request" }] });
    return suite.items[0];
}

// ------------------------------------------------------------------ variable change tracking
// Requests and runs work on copies of the suite and globals. Afterwards, the environment / global variables that
// captures or scripts changed are merged into the current workspace state (which the user may have edited
// meanwhile), instead of overwriting it with the old copy.

const varSignature = (v) => `${v.value}\u0000${v.enabled !== false}`;
const varsMap = (list) => new Map((list || []).filter((v) => v && v.key).map((v) => [v.key, varSignature(v)]));

function changedVariables(before, afterList) {
    return (afterList || []).filter((v) => v && v.key && before.get(v.key) !== varSignature(v));
}

function upsertVariables(target, changes) {
    for (const c of changes) {
        const existing = target.find((x) => x.key === c.key);
        if (existing) {
            existing.value = c.value == null ? "" : String(c.value);
            existing.enabled = c.enabled !== false;
        } else {
            target.push({ key: c.key, value: c.value == null ? "" : String(c.value), enabled: c.enabled !== false, secret: !!c.secret, description: c.description || "" });
        }
    }
}

/** Snapshot of the variable values of every environment of a suite copy plus the globals copy. */
function takeSnapshot(suite, globals) {
    return {
        environments: new Map((suite.environments || []).map((e) => [e.id, varsMap(e.variables)])),
        globals: varsMap(globals)
    };
}

// ------------------------------------------------------------------ echo server (local test API)

class EchoManager {
    constructor({ log, onChange }) {
        this.log = log;
        this.onChange = onChange;
        this.server = null;
        this.starting = null;
        this.lastError = null;
    }

    status() {
        return this.server
            ? { running: true, port: this.server.port, url: this.server.url }
            : { running: false, port: null, url: null, error: this.lastError };
    }

    async start(port) {
        const wanted = intIn(port, 3999, 1, 65535);
        if (this.starting) await this.starting.catch(() => {});
        if (this.server && this.server.port === wanted) return this.status();
        if (this.server) await this.stop();
        this.starting = core("echoServer").startEchoServer({ port: wanted, host: "127.0.0.1" });
        try {
            this.server = await this.starting;
            this.lastError = null;
            this.log.info(`Echo server started at ${this.server.url}`);
        } catch (err) {
            this.lastError = err.message;
            this.log.warn(`Echo server could not start: ${err.message}`);
            throw err;
        } finally {
            this.starting = null;
            this.onChange(this.status());
        }
        return this.status();
    }

    async stop() {
        const server = this.server;
        this.server = null;
        if (server) {
            await server.close();
            this.log.info("Echo server stopped");
            this.onChange(this.status());
        }
        return this.status();
    }
}

// ------------------------------------------------------------------ the API

/**
 * deps: { workspace, log, dataDir, logDir, cliCommand: () => string, getWindow: (sender) => BrowserWindow|null }
 * Returns { methods, dispatch(sender, method, args), echo, shutdown() }.
 */
// Company root certificates: the Settings file plus NODE_EXTRA_CA_CERTS (ignored by the hardened runtime itself).
let caStatus = { count: 0, sources: [], error: null };
function applyTrustedCa(settings, log) {
    const { applyExtraCaFiles, envCaFiles } = require("../core/tlsTrust");
    const files = [...envCaFiles(), ...(settings && settings.extraCaFile ? [{ path: settings.extraCaFile, label: "Trusted CA certificates file" }] : [])];
    try {
        caStatus = { ...applyExtraCaFiles(files), error: null };
    } catch (err) {
        // keep working with the built-in roots; Settings shows the problem
        try { applyExtraCaFiles([]); } catch (_) { /* bundled roots only */ }
        caStatus = { count: 0, sources: [], error: err.message };
        if (log) log("warn", err.message);
    }
    return caStatus;
}

function createApi({ workspace, log, dataDir, logDir, cliCommand, getWindow }) {
    const sessions = new Map(); // suite id -> { runtime, cookieJar, oauthCache }
    const inflight = new Map(); // webContents id -> Set<AbortController> of single requests
    const runs = new Map(); // run id -> { controller, sender }
    let lastRun = null;
    let lastDir = null; // folder of the last import / export, the next dialog starts there

    function broadcast(channel, payload) {
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
        }
    }
    function sendTo(sender, channel, payload) {
        if (sender && !sender.isDestroyed()) sender.send(channel, payload);
    }

    const echo = new EchoManager({ log, onChange: (status) => broadcast("echo-changed", status) });

    function session(suiteId) {
        const key = suiteId || "";
        let s = sessions.get(key);
        if (!s) {
            s = { runtime: {}, cookieJar: core("cookies").createCookieJar(), oauthCache: core("auth").createOAuthCache() };
            sessions.set(key, s);
        }
        return s;
    }

    const settings = () => workspace.settings;
    const dialogParent = (sender) => getWindow(sender) || undefined;
    const startDir = () => lastDir || app.getPath("documents");
    const remember = (file) => { if (file) lastDir = path.dirname(file); };

    // ------------------------------------------------------------------ local files the page may name
    const pickedFiles = new Set(); // chosen in this session's open dialogs: may be read (data files) and imported
    const openedFiles = new Set(); // opened with the app (file manager, command line, Dock): may be imported
    const writtenFiles = new Set(); // saved by this session's save dialogs: may be opened (reports) and shown in the folder
    const onceApprovals = new Map(); // suite key -> { files: Set, expires }: "Allow once", for the next send / run

    /** Approval key of a suite id: the id of an existing suite, "" for unsaved requests. */
    const suiteKey = (suiteId) => (typeof suiteId === "string" && suiteId && workspace.getSuite(suiteId) ? suiteId : "");
    const peekOnce = (key) => {
        const entry = onceApprovals.get(key);
        if (entry && entry.expires > Date.now()) return entry.files;
        onceApprovals.delete(key);
        return new Set();
    };
    const takeOnce = (key) => {
        const files = peekOnce(key);
        onceApprovals.delete(key);
        return files;
    };
    /**
     * Approved for this suite: the path, and also the file it really is when it is a link (a link changed later is
     * asked again). check.path(file): the same for a path read from a request; the real file is looked up only
     * when the path itself is allowed (a path from a suite is not touched before the user allowed it).
     */
    const approvedWith = (key, once) => {
        const ok = (p) => typeof p === "string" && (once.has(p) || workspace.isFileApproved(key, p));
        const check = (file, details) => {
            const real = details && typeof details.realPath === "string" ? details.realPath : null;
            return ok(file) && (!real || real === file || ok(real));
        };
        check.path = (file) => ok(file) && check(file, { realPath: realPathOf(file) });
        return check;
    };
    /** The paths to remember for an approval (only after the user allowed them): the path and, when it is a link, the real file. */
    const approvalPaths = (files) => {
        const out = new Set();
        for (const f of files) {
            out.add(f);
            const real = realPathOf(f);
            if (real) out.add(real);
        }
        return [...out];
    };

    /**
     * For one send or run: approveFile for core (prepare.js asks it before reading a local file) that uses the
     * suite's approvals plus "Allow once" (taken now), and remembers what it refused.
     */
    function uploadGate(key) {
        const isApproved = approvedWith(key, takeOnce(key));
        const denied = [];
        return {
            denied,
            approveFile(file, details) {
                if (isApproved(file, details)) return true;
                const p = String(file);
                if (!denied.some((d) => d.path === p)) {
                    denied.push({ path: p, kind: (details && details.kind) || "", field: (details && details.field) || "" });
                    log.warn(`Not sent: the upload of the local file ${p} is not allowed yet`);
                }
                return false;
            }
        };
    }

    /**
     * Local files a request would upload with the variables as they are now (nothing is read or sent, no script
     * runs, no token is fetched): [{ path, kind, field, origin, approved }]. A path that still holds a {{variable}}
     * is left out (a script sets it; the file is checked again when it is sent).
     */
    async function plannedUploads({ key, request, suite, parents, scope }) {
        if (!hasFileBody(request)) return [];
        const check = approvedWith(key, peekOnce(key));
        const answers = new Map();
        let prepared;
        try {
            prepared = await core("prepare").prepareRequest(request, {
                suite, parents, scope, settings: settings(), oauthCache: session(key).oauthCache, preview: true,
                approveFile: (file, details) => {
                    const ok = check(file, details);
                    answers.set(file, ok);
                    return ok;
                }
            });
        } catch (err) {
            if (err && err.code === "FILE_NOT_APPROVED" && err.filePath) {
                return [{ path: String(err.filePath), kind: err.kind || "", field: err.field || "", origin: err.host ? originOf(`https://${err.host}`) : "", approved: false }];
            }
            return []; // a problem the send itself reports
        }
        const origin = originOf(prepared.url);
        return uploadsOf(prepared)
            .filter((f) => !f.path.includes("{{"))
            .map((f) => ({ ...f, origin, approved: answers.has(f.path) ? answers.get(f.path) : check.path(f.path) }));
    }

    /** What the page needs to ask for an approval: { suiteId, suiteName, files: [{ path, kind, field, origin, requestName }] } */
    function approvalRequest(key, files) {
        const suite = key ? workspace.getSuite(key) : null;
        return { suiteId: suite ? suite.id : null, suiteName: suite ? suite.name : "", files };
    }

    /** Result of a request that was not sent because it uploads files that are not allowed yet. */
    function notSentResult(rc, key, files) {
        const first = files[0];
        const message = files.length === 1
            ? `This request uploads the local file ${first.path}${first.origin ? ` to ${first.origin}` : ""}. Allow it first.`
            : `This request uploads ${files.length} local files (${files.map((f) => f.path).join(", ")}). Allow them first.`;
        return {
            requestId: rc.request.id,
            name: rc.request.name,
            method: String(rc.request.method || "GET").toUpperCase(),
            url: String(rc.request.url || ""),
            path: rc.parents.map((p) => p.name),
            iteration: 1,
            prepared: null,
            response: null,
            assertions: [],
            captures: [],
            scripts: { pre: null, post: null },
            logs: [{ level: "warn", message, source: "runner" }],
            passed: false,
            error: message,
            errorCode: "FILE_NOT_APPROVED",
            notSent: true,
            startedAt: new Date().toISOString(),
            durationMs: 0,
            variablesChanged: { environment: false, globals: false },
            needsFileApproval: approvalRequest(key, files.map((f) => ({ ...f, requestName: rc.request.name })))
        };
    }

    /**
     * Working context of a request: a copy of the saved suite (or an empty one when the suite is gone, e.g. a
     * history entry), the request (the edited copy when given), its parent folders and the environment.
     */
    function requestContext({ suiteId, requestId, request, environmentId } = {}) {
        const saved = suiteId ? workspace.getSuite(suiteId) : null;
        const suite = saved ? clone(saved) : model.newSuite("Scratch");
        const found = requestId ? model.findItem(suite, requestId) : null;
        const foundRequest = found && found.item.type === "request" ? found : null;
        if (!request && !foundRequest) throw new Error("The request was not found. It may have been deleted.");
        const req = request ? normalizeRequest(request) : foundRequest.item;
        let parents = [];
        if (foundRequest && foundRequest.item.id === req.id) {
            parents = foundRequest.parents;
        } else if (!model.findItem(suite, req.id)) {
            suite.items.push(req); // not saved yet: run it at the top level of the suite
        }
        const envId = environmentId === undefined ? suite.activeEnvironmentId : environmentId || null;
        const environment = envId ? suite.environments.find((e) => e.id === envId) || null : null;
        return { saved, suite, request: req, parents, environmentId: environment ? environment.id : null, environment };
    }

    /** Read-only scope (copies of globals and runtime values) for previews and variable lookups. */
    function scopeFor(ctx) {
        const sess = sessions.get(ctx.saved ? ctx.saved.id : "");
        return createScope({
            globals: clone(workspace.globals),
            suite: ctx.suite,
            parents: ctx.parents,
            environment: ctx.environment,
            runtime: { ...(sess ? sess.runtime : {}) }
        });
    }

    /**
     * Context for variable lookups (URL hover, autocomplete). Lenient: an unknown or unsaved request resolves
     * against the suite only; a folder id includes that folder's own variables.
     */
    function variableContext({ suiteId, requestId, environmentId } = {}) {
        const saved = suiteId ? workspace.getSuite(suiteId) : null;
        const suite = saved || model.newSuite("Scratch");
        const found = requestId ? model.findItem(suite, requestId) : null;
        const parents = found ? (found.item.type === "folder" ? [...found.parents, found.item] : found.parents) : [];
        const envId = environmentId === undefined ? suite.activeEnvironmentId : environmentId || null;
        const environment = envId ? suite.environments.find((e) => e.id === envId) || null : null;
        return { saved, suite, parents, environment };
    }

    /** Merges environment / global changes made on copies into the workspace and tells the renderer. */
    async function mergeChanges(suiteId, workingSuite, workingGlobals, snapshot) {
        const saved = suiteId ? workspace.getSuite(suiteId) : null;
        if (saved) {
            let changed = false;
            for (const env of workingSuite.environments || []) {
                const before = snapshot.environments.get(env.id) || new Map();
                const changes = changedVariables(before, env.variables);
                const target = saved.environments.find((e) => e.id === env.id);
                if (changes.length && target) {
                    upsertVariables(target.variables, changes);
                    changed = true;
                }
            }
            if (changed) {
                try {
                    const stored = await workspace.saveSuite(saved);
                    broadcast("suite-changed", { suiteId: stored.id, suite: stored });
                } catch (err) {
                    log.error(`Saving captured environment values failed: ${err.message}`);
                }
            }
        }
        const globalChanges = changedVariables(snapshot.globals, workingGlobals);
        if (globalChanges.length) {
            const next = clone(workspace.globals);
            upsertVariables(next, globalChanges);
            try {
                const stored = await workspace.saveGlobals(next);
                broadcast("globals-changed", { globals: stored });
            } catch (err) {
                log.error(`Saving captured global values failed: ${err.message}`);
            }
        }
    }

    function trackRequest(sender, controller) {
        const id = sender ? sender.id : 0;
        if (!inflight.has(id)) inflight.set(id, new Set());
        inflight.get(id).add(controller);
        return () => {
            const set = inflight.get(id);
            if (set) {
                set.delete(controller);
                if (!set.size) inflight.delete(id);
            }
        };
    }

    /** Shorter response bodies for results far into big runs (the first ones keep everything). */
    function trimResult(result, index) {
        if (!result || !result.response || index < FULL_BODY_RESULTS) return result;
        const r = result.response;
        if (typeof r.bodyText === "string" && r.bodyText.length > TRIMMED_BODY_CHARS) {
            r.bodyText = r.bodyText.slice(0, TRIMMED_BODY_CHARS);
            r.bodyTrimmed = true;
        }
        if (r.bodyBase64) {
            delete r.bodyBase64;
            r.bodyTrimmed = true;
        }
        return result;
    }

    function failedRun({ runId, suite, environmentId, iterations, startedAt, message }) {
        const env = (suite.environments || []).find((e) => e.id === environmentId);
        const finishedAt = new Date().toISOString();
        return {
            id: runId,
            suiteName: suite.name,
            environmentName: env ? env.name : "",
            startedAt,
            finishedAt,
            durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
            iterations,
            stats: { requests: 0, passed: 0, failed: 0, errors: 1, assertions: 0, assertionsPassed: 0, assertionsFailed: 0, avgResponseMs: 0 },
            results: [],
            stopped: true,
            error: message
        };
    }

    function checkFile(file, maxBytes, what) {
        if (typeof file !== "string" || !file) throw new Error(`No ${what} given`);
        let stat;
        try {
            stat = fs.statSync(file);
        } catch (err) {
            throw new Error(err.code === "ENOENT" ? `File not found: ${file}` : `Cannot open ${file}: ${err.message}`);
        }
        if (!stat.isFile()) throw new Error(`Not a file: ${file}`);
        if (stat.size > maxBytes) throw new Error(`${path.basename(file)} is too large (${Math.round(stat.size / 1048576)} MB, at most ${Math.round(maxBytes / 1048576)} MB)`);
        return stat;
    }

    async function importPath(file) {
        if (typeof file !== "string" || !(pickedFiles.has(file) || openedFiles.has(file))) {
            throw new Error("Choose the file with Import… (or open it with API Tester from the file manager).");
        }
        checkFile(file, MAX_IMPORT_BYTES, "file");
        const result = await core("suiteFile").importFile(file);
        remember(file);
        return { ...result, fileName: path.basename(file), path: file };
    }

    function dataFileSummary(text, fileName) {
        const rows = core("datafile").parseDataFile(text, fileName);
        const columns = [];
        for (const row of rows) for (const key of Object.keys(row || {})) if (!columns.includes(key)) columns.push(key);
        return { rows, columns };
    }

    const methods = {
        // ------------------------------------------------------------------ app
        "app.info": () => ({
            version: app.getVersion(),
            platform: process.platform,
            dataDir,
            logDir,
            isPackaged: app.isPackaged,
            cliCommand: cliCommand(),
            isPortable: process.platform === "win32" && !!process.env.PORTABLE_EXECUTABLE_FILE,
            echoServer: echo.status(),
            trustedCa: caStatus
        }),
        "app.openExternal": async (_ctx, url) => {
            if (typeof url !== "string" || !/^https:\/\//i.test(url)) throw new Error("Only https links can be opened");
            await shell.openExternal(url);
            return true;
        },
        // how saved secrets are stored: "encrypted" (system keychain), "plaintext" (no keychain), "none" (no secrets yet)
        "app.secretStorage": () => workspace.secretState,
        "app.openDataFolder": async () => {
            fs.mkdirSync(dataDir, { recursive: true });
            const error = await shell.openPath(dataDir);
            if (error) throw new Error(error);
            return true;
        },
        "app.openLogFolder": async () => {
            fs.mkdirSync(logDir, { recursive: true });
            const error = await shell.openPath(logDir);
            if (error) throw new Error(error);
            return true;
        },

        "meta.get": () => {
            const assertions = core("assertions");
            const extract = core("extract");
            const sources = assertions.ASSERTION_SOURCES || [];
            const operatorsBySource = {};
            for (const s of sources) {
                try {
                    operatorsBySource[s.value] = (assertions.operatorsForSource(s.value) || []).map((o) => (typeof o === "string" ? o : o.value));
                } catch (_) { /* optional helper */ }
            }
            return {
                assertionSources: sources,
                assertionOperators: assertions.ASSERTION_OPERATORS || [],
                operatorsBySource,
                extractSources: extract.EXTRACT_SOURCES || [],
                dynamicVariables: Object.entries(DYNAMIC_VARIABLES).map(([name, v]) => ({ name, description: v.description })),
                httpMethods: model.HTTP_METHODS,
                bodyModes: model.BODY_MODES,
                authTypes: model.AUTH_TYPES
            };
        },

        // ------------------------------------------------------------------ workspace
        "workspace.load": async () => {
            const loaded = await workspace.loadAsync();
            applyTrustedCa(loaded && loaded.settings, typeof log === "function" ? log : null);
            return loaded;
        },
        "workspace.saveSuite": (_ctx, suite) => workspace.saveSuite(suite),
        "workspace.deleteSuite": async (_ctx, id) => {
            await workspace.deleteSuite(id); // also forgets its file approvals
            sessions.delete(id);
            onceApprovals.delete(id);
            return true;
        },
        "workspace.reorderSuites": (_ctx, ids) => workspace.reorderSuites(ids),
        "workspace.saveGlobals": (_ctx, vars) => workspace.saveGlobals(vars),
        "workspace.saveSettings": async (_ctx, next) => {
            if (next && next.extraCaFile) {
                const before = (workspace.settings && workspace.settings.extraCaFile) || "";
                if (next.extraCaFile !== before && !pickedFiles.has(next.extraCaFile)) {
                    throw new Error("Choose the CA certificate file with “Choose file…”.");
                }
                // check the file before saving, so a wrong file gives a clear message in Settings
                require("../core/tlsTrust").applyExtraCaFiles([{ path: String(next.extraCaFile), label: "Trusted CA certificates file" }]);
            }
            const stored = await workspace.saveSettings(next);
            applyTrustedCa(stored, typeof log === "function" ? log : null);
            nativeTheme.themeSource = stored.theme;
            return stored;
        },
        "workspace.saveUi": (_ctx, ui) => workspace.saveUi(ui),
        "workspace.clearHistory": async () => {
            const history = await workspace.clearHistory();
            broadcast("history-changed", { history, entry: null });
            return history;
        },
        "workspace.deleteHistory": async (_ctx, id) => {
            const history = await workspace.deleteHistory(id);
            broadcast("history-changed", { history, entry: null });
            return history;
        },

        // ------------------------------------------------------------------ requests
        "request.send": async (ctx, args) => {
            const rc = requestContext(args || {});
            const suiteId = rc.saved ? rc.saved.id : null;
            const key = suiteId || "";
            // a local file that is not allowed yet: nothing is sent (no script, no token request); the page asks
            const planned = await plannedUploads({ key, request: rc.request, suite: rc.suite, parents: rc.parents, scope: scopeFor(rc) });
            const missing = planned.filter((f) => !f.approved);
            if (missing.length) return notSentResult(rc, key, missing);
            const sess = session(suiteId);
            const globalsCopy = clone(workspace.globals);
            const snapshot = takeSnapshot(rc.suite, globalsCopy);
            const controller = new AbortController();
            const untrack = trackRequest(ctx.sender, controller);
            const gate = uploadGate(key);
            let result;
            try {
                result = await core("runner").executeRequest({
                    suite: rc.suite,
                    requestId: rc.request.id,
                    request: rc.request,
                    globals: globalsCopy,
                    environmentId: rc.environmentId,
                    runtime: sess.runtime,
                    data: null,
                    settings: settings(),
                    cookieJar: sess.cookieJar,
                    oauthCache: sess.oauthCache,
                    signal: controller.signal,
                    approveFile: gate.approveFile
                });
            } finally {
                untrack();
            }
            const refused = gate.denied.length ? gate.denied
                : result.errorCode === "FILE_NOT_APPROVED" && result.fileApproval && result.fileApproval.filePath
                    ? [{ path: String(result.fileApproval.filePath), kind: result.fileApproval.kind || "", field: result.fileApproval.field || "" }] : [];
            if (refused.length) {
                // the pre-request script pointed the body at another file: not sent (no history entry); the page asks
                const origin = originOf(result.url || "");
                result.needsFileApproval = approvalRequest(key, refused.map((f) => ({ ...f, origin, requestName: rc.request.name })));
                await mergeChanges(suiteId, rc.suite, globalsCopy, snapshot);
                return result;
            }
            const response = result.response || {};
            // core's copy without credentials (Auth-tab secrets left out, credential headers and secrets masked):
            // the history never holds secrets; reopening an entry asks for them again
            const historyRequest = result.historyRequest || core("secrets").redactRequest(rc.request);
            const entry = {
                id: model.newId("h"),
                time: new Date().toISOString(),
                suiteId,
                requestId: rc.request.id,
                name: rc.request.name,
                method: result.method || rc.request.method,
                url: result.url || rc.request.url,
                status: Number(response.status) || 0,
                durationMs: Number.isFinite(result.durationMs) ? result.durationMs : (response.timings && response.timings.total) || 0,
                passed: !!result.passed,
                request: historyRequest,
                credentialsRemoved: JSON.stringify(historyRequest) !== JSON.stringify(rc.request)
            };
            const history = workspace.addHistory(entry);
            broadcast("history-changed", { history, entry: history[0] && history[0].id === entry.id ? history[0] : null });
            await mergeChanges(suiteId, rc.suite, globalsCopy, snapshot);
            return result;
        },
        "request.cancel": (ctx) => {
            const set = inflight.get(ctx.sender ? ctx.sender.id : 0);
            let count = 0;
            if (set) for (const c of set) { c.abort(); count++; }
            return count;
        },
        "request.preview": async (_ctx, args) => {
            const rc = requestContext(args || {});
            const scope = scopeFor(rc);
            // the Code view must not call token endpoints: OAuth2 shows a placeholder (or a token already cached)
            const prepared = await core("prepare").prepareRequest(rc.request, {
                suite: rc.suite,
                parents: rc.parents,
                scope,
                settings: settings(),
                oauthCache: session(rc.saved ? rc.saved.id : "").oauthCache,
                preview: true
            });
            const curl = core("curl");
            const codegen = core("codegen");
            const toCurl = curl.toCurl || codegen.toCurl;
            const snippets = codegen.codeSnippets ? codegen.codeSnippets(prepared) : {};
            const { body, ...withoutBody } = prepared; // Buffer not needed by the UI (bodyText is the preview)
            return { prepared: withoutBody, curl: toCurl ? toCurl(prepared) : snippets.curl || "", snippets };
        },

        // ------------------------------------------------------------------ variables and runtime state
        "variables.resolve": (_ctx, args) => {
            const a = args || {};
            const scope = scopeFor(variableContext(a));
            const r = scope.resolveDetailed(a.text == null ? "" : String(a.text));
            return { value: r.value, unresolved: r.unresolved, used: r.used.map((u) => ({ ...u, secret: scope.isSecret(u.name) })) };
        },
        "variables.snapshot": (_ctx, args) => scopeFor(variableContext(args || {})).snapshot(),
        "runtime.get": async (_ctx, suiteId) => {
            const sess = sessions.get(suiteId || "");
            if (!sess) return { variables: {}, cookies: [] };
            return { variables: { ...sess.runtime }, cookies: (await core("cookies").listCookies(sess.cookieJar)) || [] };
        },
        // what: "variables" (captured values), "cookies", or omitted for both (plus cached OAuth2 tokens)
        "runtime.clear": async (_ctx, suiteId, what) => {
            const sess = sessions.get(suiteId || "");
            if (!sess) return true;
            if (what === "variables" || what === "runtime") {
                for (const key of Object.keys(sess.runtime)) delete sess.runtime[key]; // same object: running requests see it
            } else if (what === "cookies") {
                await core("cookies").clearCookies(sess.cookieJar);
            } else {
                sessions.delete(suiteId || "");
                try { await core("cookies").clearCookies(sess.cookieJar); } catch (_) { /* a new jar is used anyway */ }
            }
            return true;
        },

        // ------------------------------------------------------------------ runner
        "runner.start": async (ctx, args) => {
            const a = args || {};
            const saved = workspace.getSuite(a.suiteId);
            if (!saved) throw new Error("Suite not found. It may have been deleted.");
            const suite = clone(saved);
            const itemIds = Array.isArray(a.itemIds) ? a.itemIds.filter((id) => typeof id === "string") : [];
            const selected = model.collectRequests(suite, itemIds);
            if (!selected.length) throw new Error("Nothing to run: the selection contains no requests.");
            let data = null;
            if (typeof a.dataText === "string" && a.dataText.trim()) {
                data = dataFileSummary(a.dataText, a.dataFileName || "data.csv").rows;
                if (!data.length) throw new Error("The data file has no rows.");
            }
            const iterations = intIn(a.iterations, 1, 1, 100000);
            const delayMs = intIn(a.delayMs, 0, 0, 600000);
            const envId = a.environmentId === undefined ? suite.activeEnvironmentId : a.environmentId || null;
            const environmentId = envId && suite.environments.some((e) => e.id === envId) ? envId : null;
            const globalsCopy = clone(workspace.globals);

            // local files the run would upload that are not allowed yet: the run does not start, the page asks first
            const key = saved.id;
            const environment = environmentId ? suite.environments.find((e) => e.id === environmentId) : null;
            const firstRow = data && data[0] && typeof data[0] === "object" ? Object.fromEntries(Object.entries(data[0]).map(([k, v]) => [k, v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)])) : null;
            const missing = [];
            for (const { request, parents } of selected) {
                if (!hasFileBody(request)) continue;
                const scope = createScope({ globals: clone(globalsCopy), suite, parents, environment, data: firstRow, runtime: { ...session(key).runtime } });
                for (const f of await plannedUploads({ key, request, suite, parents, scope })) {
                    if (!f.approved && !missing.some((m) => m.path === f.path)) missing.push({ ...f, requestName: request.name });
                }
            }
            if (missing.length) return { runId: null, needsFileApproval: approvalRequest(key, missing) };

            const gate = uploadGate(key);
            const snapshot = takeSnapshot(suite, globalsCopy);
            const runId = model.newId("run");
            const controller = new AbortController();
            const sender = ctx.sender;
            runs.set(runId, { controller, sender });
            const startedAt = new Date().toISOString();
            log.info(`Run ${runId} started: suite "${suite.name}", ${iterations} iteration(s)${data ? `, ${data.length} data row(s)` : ""}`);

            (async () => {
                let result = null;
                let doneSent = false;
                let index = 0;
                const finish = async (runResult) => {
                    if (doneSent) return;
                    doneSent = true;
                    // requests whose (script-set) file was not allowed were not sent: the runner offers to allow them
                    if (gate.denied.length) {
                        const names = new Map((runResult.results || []).filter((r) => r && r.errorCode === "FILE_NOT_APPROVED" && r.fileApproval)
                            .map((r) => [r.fileApproval.filePath, { name: r.name, origin: originOf(r.url) }]));
                        runResult.needsFileApproval = approvalRequest(key, gate.denied.map((f) => ({
                            ...f, requestName: (names.get(f.path) || {}).name || "", origin: (names.get(f.path) || {}).origin || ""
                        })));
                    }
                    lastRun = runResult;
                    runs.delete(runId);
                    await mergeChanges(saved.id, suite, globalsCopy, snapshot).catch(() => {});
                    sendTo(sender, "runner-event", { runId, event: { type: "run-done", result: runResult } });
                    const s = runResult.stats || {};
                    log.info(`Run ${runId} finished: ${s.passed || 0} passed, ${s.failed || 0} failed, ${s.errors || 0} errors${runResult.stopped ? " (stopped)" : ""}`);
                };
                try {
                    result = await core("runner").runSuite({
                        suite,
                        itemIds,
                        globals: globalsCopy,
                        environmentId,
                        iterations,
                        data,
                        delayMs,
                        stopOnFailure: !!a.stopOnFailure,
                        settings: settings(),
                        signal: controller.signal,
                        approveFile: gate.approveFile,
                        onEvent: (event) => {
                            if (!event || typeof event !== "object") return;
                            if (event.type === "run-done") return; // sent by finish(), after the variable changes are saved
                            if (event.type === "request-done") trimResult(event.result, index++);
                            sendTo(sender, "runner-event", { runId, event });
                        }
                    });
                } catch (err) {
                    log.error(`Run ${runId} failed: ${err.stack || err.message}`);
                    result = failedRun({ runId, suite, environmentId, iterations, startedAt, message: err.message || String(err) });
                }
                await finish(result || failedRun({ runId, suite, environmentId, iterations, startedAt, message: "The run ended without a result" }));
            })().catch((err) => log.error(`Run ${runId}: ${err.message}`));

            return { runId };
        },
        "runner.stop": (ctx, runId) => {
            let count = 0;
            for (const [id, run] of runs) {
                // without a run id: every run started from this window
                if (runId ? id === runId : run.sender === ctx.sender) { run.controller.abort(); count++; }
            }
            return count;
        },
        "runner.last": () => lastRun,

        // ------------------------------------------------------------------ files
        "files.importDialog": async (ctx) => {
            const res = await dialog.showOpenDialog(dialogParent(ctx.sender), {
                title: "Import",
                defaultPath: startDir(),
                properties: ["openFile"],
                filters: [
                    { name: "Suites, Postman, OpenAPI, cURL", extensions: ["apisuite", "json", "yaml", "yml", "txt"] },
                    { name: "All files", extensions: ["*"] }
                ]
            });
            if (res.canceled || !res.filePaths || !res.filePaths[0]) return null;
            pickedFiles.add(res.filePaths[0]);
            return importPath(res.filePaths[0]);
        },
        "files.importText": (_ctx, text, fileName) => {
            if (typeof text !== "string" || !text.trim()) throw new Error("Nothing to import: the text is empty");
            return core("suiteFile").importText(text, fileName || undefined);
        },
        "files.importPath": (_ctx, file) => importPath(file),
        "files.exportSuite": async (ctx, suiteId, options) => {
            const suite = workspace.getSuite(suiteId);
            if (!suite) throw new Error("Suite not found. It may have been deleted.");
            const o = isObject(options) ? options : {};
            const suiteFile = core("suiteFile");
            const text = suiteFile.exportSuite(suite, { includeEnvironments: o.includeEnvironments !== false, includeSecrets: !!o.includeSecrets });
            const res = await dialog.showSaveDialog(dialogParent(ctx.sender), {
                title: "Export Suite",
                defaultPath: path.join(startDir(), suiteFile.suiteFileName(suite)),
                filters: [{ name: "API Tester Suite", extensions: ["apisuite"] }]
            });
            if (res.canceled || !res.filePath) return null;
            await writeFileAtomic(res.filePath, text);
            writtenFiles.add(res.filePath);
            remember(res.filePath);
            log.info(`Suite "${suite.name}" exported to ${res.filePath}`);
            return res.filePath;
        },
        "files.saveReport": async (ctx, runResult, format) => {
            const run = isObject(runResult) ? runResult : lastRun;
            if (!run) throw new Error("No run result to save yet. Run a suite first.");
            const reporters = core("reporters");
            const kinds = {
                html: { ext: "html", name: "HTML report", render: reporters.toHtml },
                junit: { ext: "xml", name: "JUnit XML", render: reporters.toJUnit },
                json: { ext: "json", name: "JSON", render: reporters.toJson }
            };
            const kind = kinds[String(format || "html").toLowerCase()];
            if (!kind) throw new Error(`Unknown report format "${format}" (use html, junit or json)`);
            const res = await dialog.showSaveDialog(dialogParent(ctx.sender), {
                title: "Save Report",
                defaultPath: path.join(startDir(), `${reportFileBase(run.suiteName, run.startedAt)}.${kind.ext}`),
                filters: [{ name: kind.name, extensions: [kind.ext] }]
            });
            if (res.canceled || !res.filePath) return null;
            await writeFileAtomic(res.filePath, await kind.render(run));
            writtenFiles.add(res.filePath);
            remember(res.filePath);
            return res.filePath;
        },
        // only reports saved in this session (Open after "Report: HTML"), never another file or program
        "files.openPath": async (_ctx, file) => {
            if (typeof file !== "string" || !file) throw new Error("No file given");
            if (!writtenFiles.has(file) || !OPENABLE_REPORT.test(file)) throw new Error("Only reports saved in this session can be opened from here.");
            const error = await shell.openPath(file);
            if (error) throw new Error(error);
            return true;
        },
        "files.showItem": (_ctx, file) => {
            if (typeof file !== "string" || !file) throw new Error("No file given");
            if (!writtenFiles.has(file)) throw new Error("Only files saved in this session can be shown from here.");
            shell.showItemInFolder(file);
            return true;
        },
        /**
         * Native file chooser. options: { title, filters, purpose: "upload" | "data", suiteId }. A file chosen for an
         * upload is allowed for the requests of that suite (suiteId; none: unsaved requests): the user picked it.
         */
        "files.pickFile": async (ctx, options) => {
            const o = isObject(options) ? options : {};
            const filters = (Array.isArray(o.filters) ? o.filters : [])
                .filter((f) => isObject(f) && Array.isArray(f.extensions))
                .map((f) => ({ name: String(f.name || "Files"), extensions: f.extensions.map(String) }));
            const res = await dialog.showOpenDialog(dialogParent(ctx.sender), {
                title: typeof o.title === "string" ? o.title : "Choose a file",
                defaultPath: startDir(),
                properties: ["openFile"],
                filters: filters.length ? [...filters, { name: "All files", extensions: ["*"] }] : []
            });
            if (res.canceled || !res.filePaths || !res.filePaths[0]) return null;
            const file = res.filePaths[0];
            pickedFiles.add(file);
            remember(file);
            if (o.purpose === "upload") {
                const key = suiteKey(o.suiteId);
                await workspace.approveFiles(key, approvalPaths([file]));
                log.info(`Upload of ${file} allowed for ${key ? `suite "${workspace.getSuite(key).name}"` : "unsaved requests"} (chosen in the file dialog)`);
            }
            return file;
        },
        "files.readDataFile": (_ctx, file) => {
            if (typeof file !== "string" || !pickedFiles.has(file)) throw new Error("Choose the data file with “Choose file…” (or drop it on the box).");
            checkFile(file, MAX_DATA_FILE_BYTES, "data file");
            const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
            const fileName = path.basename(file);
            const { rows, columns } = dataFileSummary(text, fileName);
            return { fileName, path: file, text, rows: rows.length, columns };
        },

        // ------------------------------------------------------------------ approvals of local file uploads
        /**
         * Asks the user in a native dialog (shown by main, so the page cannot answer it) whether local files may be
         * uploaded: "Allow once" (next send / run), "Always for this suite" (remembered on this computer) or Cancel.
         * args: { suiteId, files: [{ path, origin, requestName }], context: "send" | "run" } (or { suiteId, path, origin })
         * -> { approved, persist }
         */
        "files.approve": async (ctx, args) => {
            const a = isObject(args) ? args : {};
            const key = suiteKey(a.suiteId);
            const suite = key ? workspace.getSuite(key) : null;
            const files = [];
            for (const f of Array.isArray(a.files) ? a.files : [a]) {
                if (!isObject(f) || typeof f.path !== "string" || !path.isAbsolute(f.path) || files.some((x) => x.path === f.path)) continue;
                if (!isLocalPath(f.path)) {
                    throw new Error(`${f.path} is on a network share or is a device path. Such files cannot be uploaded: copy the file to this computer and choose the copy.`);
                }
                // shown in the dialog; the real file is looked up (and remembered) only once the user allowed it
                const link = linkTargetOf(f.path);
                files.push({
                    path: f.path,
                    real: link && link !== f.path ? link : null,
                    origin: typeof f.origin === "string" ? f.origin.slice(0, 300) : "",
                    requestName: typeof f.requestName === "string" ? f.requestName.slice(0, 200) : ""
                });
            }
            if (!files.length) throw new Error("No local file to allow");
            const one = files.length === 1 ? files[0] : null;
            const line = (f) => `• ${f.path}${f.real ? ` (link to ${f.real})` : ""}${f.origin ? `  →  ${f.origin}` : ""}${f.requestName && !one ? `  (${f.requestName})` : ""}`;
            const list = files.slice(0, 12).map(line);
            if (files.length > 12) list.push(`… and ${files.length - 12} more`);
            const run = a.context === "run";
            const detail = [
                one ? `${one.requestName ? `The request “${one.requestName}”` : "This request"} sends this file from your computer${one.origin ? ` to ${one.origin}` : ""}.${one.real ? ` It is a link to ${one.real}.` : ""}`
                    : `${run ? "This run" : "This request"} sends these files from your computer:\n${list.join("\n")}`,
                "",
                "Only allow files you expect to send. A suite from someone else can name any file on your computer, for example SSH keys or saved passwords.",
                "",
                `Allow once: only for ${run ? "this run" : "this send"}. Always: remembered on this computer for ${suite ? `the suite “${suite.name}”` : "unsaved requests"} (never exported with the suite); remove it in the request's Body tab.`
            ].join("\n");
            const { response } = await dialog.showMessageBox(dialogParent(ctx.sender), {
                type: "warning",
                title: "Allow file upload?",
                message: one ? `Allow upload of ${one.path}${one.origin ? ` to ${one.origin}` : ""}?` : `Allow upload of ${files.length} local files?`,
                detail,
                buttons: ["Allow once", suite ? "Always for this suite" : "Always for unsaved requests", "Cancel"],
                defaultId: 2,
                cancelId: 2,
                noLink: true
            });
            const where = suite ? `suite "${suite.name}"` : "unsaved requests";
            const paths = response === 0 || response === 1 ? approvalPaths(files.map((f) => f.path)) : [];
            if (response === 0) {
                const entry = { files: new Set([...peekOnce(key), ...paths]), expires: Date.now() + ONCE_APPROVAL_MS };
                onceApprovals.set(key, entry);
                log.info(`Upload allowed once (${where}): ${files.map((f) => f.path).join(", ")}`);
                return { approved: true, persist: false };
            }
            if (response === 1) {
                await workspace.approveFiles(key, paths);
                log.info(`Upload always allowed (${where}): ${files.map((f) => f.path).join(", ")}`);
                return { approved: true, persist: true };
            }
            return { approved: false, persist: false };
        },
        /**
         * Approval state of the files a request uploads (for the Body tab):
         * args: { suiteId, requestId, request, environmentId } -> [{ path, kind, field, approved, remembered, variable }]
         */
        "files.approvalState": async (_ctx, args) => {
            const rc = requestContext(args || {});
            const key = rc.saved ? rc.saved.id : "";
            if (!hasFileBody(rc.request)) return [];
            const scope = scopeFor(rc);
            let prepared;
            const answers = new Map();
            const check = approvedWith(key, peekOnce(key));
            try {
                prepared = await core("prepare").prepareRequest(rc.request, {
                    suite: rc.suite, parents: rc.parents, scope, settings: settings(), oauthCache: session(key).oauthCache, preview: true,
                    approveFile: (file, details) => { const ok = check(file, details); answers.set(file, ok); return ok; }
                });
            } catch (_) {
                return [];
            }
            return uploadsOf(prepared).map((f) => ({
                ...f,
                variable: f.path.includes("{{"),
                approved: answers.has(f.path) ? answers.get(f.path) : check.path(f.path),
                remembered: workspace.isFileApproved(key, f.path)
            }));
        },
        /** Removes a remembered approval: args { suiteId, path }. */
        "files.revokeApproval": async (_ctx, args) => {
            const a = isObject(args) ? args : {};
            if (typeof a.path !== "string") throw new Error("No file given");
            const key = suiteKey(a.suiteId);
            // the real file of a link is looked up only for a path that is allowed now
            const paths = workspace.isFileApproved(key, a.path) || peekOnce(key).has(a.path) ? approvalPaths([a.path]) : [a.path];
            for (const p of paths) await workspace.revokeFile(key, p);
            const entry = onceApprovals.get(key);
            if (entry) for (const p of paths) entry.files.delete(p);
            log.info(`Upload approval removed: ${a.path}`);
            return true;
        },
        /** Forgets every approval of a suite (its content was replaced by an imported file). */
        "files.forgetApprovals": async (_ctx, suiteId) => {
            const key = suiteKey(suiteId);
            if (!key) return true;
            onceApprovals.delete(key);
            await workspace.clearFileApprovals(key);
            return true;
        },
        /**
         * An unsaved request was saved into a suite: its files that were allowed for unsaved requests stay allowed
         * there (nothing new is approved). args: { toSuiteId, paths }
         */
        "files.carryApprovals": async (_ctx, args) => {
            const a = isObject(args) ? args : {};
            const to = suiteKey(a.toSuiteId);
            if (!to) return [];
            const carried = (Array.isArray(a.paths) ? a.paths : []).filter((p) => typeof p === "string" && workspace.isFileApproved("", p));
            if (carried.length) await workspace.approveFiles(to, approvalPaths(carried).filter((p) => workspace.isFileApproved("", p)));
            return carried;
        },

        // ------------------------------------------------------------------ tools
        "tools.parseCurl": (_ctx, text) => {
            if (typeof text !== "string" || !text.trim()) throw new Error("Paste a cURL command first");
            return core("curl").parseCurl(text);
        },
        "tools.sampleSuite": () => {
            const status = echo.status();
            const baseUrl = status.running ? status.url : `http://127.0.0.1:${settings().echoServer.port}`;
            return core("sample").createSampleSuite({ baseUrl });
        },

        // ------------------------------------------------------------------ echo server
        "echo.start": (_ctx, port) => echo.start(port === undefined || port === null ? settings().echoServer.port : port),
        "echo.stop": () => echo.stop(),
        "echo.status": () => echo.status()
    };

    /** Runs a method for a renderer; never throws (errors become { ok: false, error }). */
    async function dispatch(sender, method, args) {
        const fn = Object.prototype.hasOwnProperty.call(methods, method) ? methods[method] : null;
        if (!fn) return { ok: false, error: `Unknown method "${method}"` };
        try {
            const result = await fn({ sender }, ...(Array.isArray(args) ? args : []));
            return { ok: true, result: result === undefined ? null : result };
        } catch (err) {
            const message = (err && err.message) || String(err);
            log.warn(`${method}: ${message}`);
            return { ok: false, error: message };
        }
    }

    /** Called before quitting: stops runs and requests and the echo server (bounded by the caller's timeout). */
    async function shutdown() {
        for (const run of runs.values()) run.controller.abort();
        for (const set of inflight.values()) for (const c of set) c.abort();
        await echo.stop().catch(() => {});
    }

    /** Settings say so: start the echo server at app start (a busy port is only logged). */
    async function autoStartEcho() {
        const s = settings().echoServer;
        if (!s.autoStart) return;
        try {
            await echo.start(s.port);
        } catch (_) { /* logged by EchoManager; the Settings dialog shows the error */ }
    }

    /** A file the user opened with the app (file manager, command line, Dock): the page may import it. */
    function allowImport(file) {
        if (typeof file === "string" && file) openedFiles.add(file);
    }

    return { methods, dispatch, echo, shutdown, autoStartEcho, allowImport };
}

module.exports = { createApi, EchoManager, normalizeRequest, changedVariables, upsertVariables };
