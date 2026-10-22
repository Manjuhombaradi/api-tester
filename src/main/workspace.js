"use strict";
// Workspace persistence of the desktop app: suites (sidebar order), globals, settings, request history and
// UI state, kept in memory and saved to <userData>/workspace.json. Pure Node.js (no Electron imports), so the
// CLI can reuse the settings defaults.
//
// Saving: every change bumps a version number and queues one atomic write (temp file + fsync + rename).
// Writes are serialised; when several changes arrive while a write is running, the next write stores all of
// them at once. A failed write rejects the promise of the change that triggered it, so the renderer can tell
// the user (disk full, permissions).
//
// Secrets at rest: files are written 0600 in a 0700 folder. With a secret store (Electron safeStorage: macOS
// Keychain, Windows DPAPI, Linux Secret Service / KWallet, given by main.js) secret variable values, Auth-tab
// passwords / tokens / client secrets / API key values, credential headers / query parameters (same name rule as
// masking, core/secrets.js) and URLs with user:password@ or ?token=... (requests, history, the proxy) are saved as
// { "$enc": "<base64>" } and decrypted on load. Without one (Linux without a keyring) they stay plaintext.
//
// File approvals: per suite id ("" = unsaved requests) the absolute paths of local files the user allowed to be
// uploaded (picked with the file chooser or confirmed in the "Allow upload" dialog). Local to this computer: they
// are never part of a suite, so an exported or shared suite never carries them.
const fs = require("fs");
const path = require("path");
const { normalizeSuite } = require("../core/model");
const { isCredentialHeader, redactRequest, MASK } = require("../core/secrets");

// 2: echo server no longer starts with the app by default (1.0.1), file approvals, encrypted secrets
const WORKSPACE_VERSION = 2;
const THEMES = ["system", "light", "dark"];
// a history entry keeps a copy of the request; very large bodies are cut so 100 entries stay small
const HISTORY_REQUEST_MAX_CHARS = 256 * 1024;
const MAX_APPROVED_FILES = 1000; // per suite
// permissions of everything the app writes into its data folder (POSIX; Windows ignores them)
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

const DEFAULT_SETTINGS = Object.freeze({
    timeoutMs: 30000,
    followRedirects: true,
    verifyTls: true,
    // true: "Do not verify" of requests, imported suites and Postman's strictSSL:false is ignored
    enforceTlsVerification: false,
    // PEM file with company root certificates (TLS-inspecting proxies, internal CAs); "" = none
    extraCaFile: "",
    proxy: Object.freeze({ enabled: false, url: "", noProxy: "localhost,127.0.0.1" }),
    maxResponseMB: 20,
    historySize: 100,
    // off: the echo server only runs when the user starts it (status bar, Settings, adding the sample suite)
    echoServer: Object.freeze({ autoStart: false, port: 3999 }),
    theme: "system"
});

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function defaultSettings() {
    return clone(DEFAULT_SETTINGS);
}

function isObject(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Number within [min, max], rounded when `integer`; anything else gives the default. */
function numberIn(value, fallback, min, max, integer = true) {
    if (value === "" || value === null || value === undefined || typeof value === "boolean") return fallback;
    let n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    if (integer) n = Math.round(n);
    return Math.min(max, Math.max(min, n));
}

/** Fills defaults and clamps values; unknown keys (added by newer UI versions) are kept. */
function normalizeSettings(input) {
    const d = defaultSettings();
    const s = isObject(input) ? input : {};
    const proxy = isObject(s.proxy) ? s.proxy : {};
    const echo = isObject(s.echoServer) ? s.echoServer : {};
    return {
        ...s,
        timeoutMs: numberIn(s.timeoutMs, d.timeoutMs, 0, 3600000), // 0 = no timeout
        followRedirects: typeof s.followRedirects === "boolean" ? s.followRedirects : d.followRedirects,
        verifyTls: typeof s.verifyTls === "boolean" ? s.verifyTls : d.verifyTls,
        enforceTlsVerification: typeof s.enforceTlsVerification === "boolean" ? s.enforceTlsVerification : d.enforceTlsVerification,
        extraCaFile: typeof s.extraCaFile === "string" ? s.extraCaFile.trim() : d.extraCaFile,
        proxy: {
            enabled: typeof proxy.enabled === "boolean" ? proxy.enabled : d.proxy.enabled,
            url: proxy.url == null ? "" : String(proxy.url).trim(),
            noProxy: proxy.noProxy == null ? d.proxy.noProxy : String(proxy.noProxy)
        },
        maxResponseMB: numberIn(s.maxResponseMB, d.maxResponseMB, 1, 1024, false),
        historySize: numberIn(s.historySize, d.historySize, 0, 1000),
        echoServer: {
            autoStart: typeof echo.autoStart === "boolean" ? echo.autoStart : d.echoServer.autoStart,
            port: numberIn(echo.port, d.echoServer.port, 1, 65535)
        },
        theme: THEMES.includes(s.theme) ? s.theme : d.theme
    };
}

function normalizeVariables(list) {
    return (Array.isArray(list) ? list : []).filter(isObject).map((v) => ({
        key: v.key == null ? "" : String(v.key),
        value: v.value == null ? "" : String(v.value),
        enabled: v.enabled !== false,
        secret: !!v.secret,
        description: v.description == null ? "" : String(v.description)
    }));
}

/**
 * Copy of a request for the history, without credentials: Auth-tab secrets left out and credential headers masked
 * (core/secrets.js redactRequest; ipc.js already passes core's redacted copy), and the URL's password, credential
 * query values (?token=...) and credential parameters / form fields (password=...) masked. Huge bodies are shortened.
 */
function redactHistoryRequest(request) {
    if (!isObject(request)) return null;
    const copy = redactRequest(request);
    if (typeof copy.url === "string") copy.url = maskUrl(copy.url);
    const body = isObject(copy.body) ? copy.body : {};
    for (const list of [copy.params, body.form, body.multipart]) {
        for (const p of Array.isArray(list) ? list : []) {
            if (isObject(p) && p.type !== "file" && worthSealing(p.value) && isCredentialHeader(p.key)) p.value = MASK;
        }
    }
    return copy;
}

function historyRequestCopy(request) {
    if (!isObject(request)) return null;
    const copy = redactHistoryRequest(request);
    if (JSON.stringify(copy).length > HISTORY_REQUEST_MAX_CHARS && copy.body) {
        const cut = (s) => (typeof s === "string" && s.length > HISTORY_REQUEST_MAX_CHARS / 2 ? s.slice(0, HISTORY_REQUEST_MAX_CHARS / 2) : s);
        copy.body.raw = cut(copy.body.raw);
        if (copy.body.graphql) {
            copy.body.graphql.query = cut(copy.body.graphql.query);
            copy.body.graphql.variables = cut(copy.body.graphql.variables);
        }
        copy.truncated = true;
    }
    return copy;
}

/** A history entry as kept: request copy without credentials, URL masked; credentialsRemoved tells the page. */
function historyEntry(entry) {
    const out = { ...entry };
    if (typeof out.url === "string") out.url = maskUrl(out.url);
    if (isObject(entry.request)) {
        out.request = historyRequestCopy(entry.request);
        const redacted = redactHistoryRequest(entry.request);
        if (entry.credentialsRemoved === true || JSON.stringify(redacted) !== JSON.stringify(entry.request)) out.credentialsRemoved = true;
    }
    return out;
}

// ------------------------------------------------------------------ atomic file writes

/**
 * Writes `data` to `file` atomically. options.mode: permissions of the new file (e.g. 0o600 for the app's own
 * data; a missing folder is then created 0700). Without it the usual default applies (exported suites, reports).
 */
async function writeFileAtomic(file, data, { mode } = {}) {
    await fs.promises.mkdir(path.dirname(file), mode ? { recursive: true, mode: PRIVATE_DIR_MODE } : { recursive: true });
    const tmp = `${file}.tmp`;
    const handle = await fs.promises.open(tmp, "w", mode || 0o666);
    try {
        if (mode) await handle.chmod(mode).catch(() => {}); // a temp file left over from a crash keeps its old mode otherwise
        await handle.writeFile(data);
        await handle.sync();
    } finally {
        await handle.close();
    }
    try {
        await fs.promises.rename(tmp, file);
    } catch (_) {
        // Windows: the target can be locked for a moment (virus scanner, indexer); write it directly
        try {
            await fs.promises.writeFile(file, data, mode ? { mode } : undefined);
            if (mode) await fs.promises.chmod(file, mode).catch(() => {});
        } finally {
            await fs.promises.unlink(tmp).catch(() => {});
        }
    }
}

function writeFileAtomicSync(file, data, { mode } = {}) {
    fs.mkdirSync(path.dirname(file), mode ? { recursive: true, mode: PRIVATE_DIR_MODE } : { recursive: true });
    const tmp = `${file}.sync.tmp`;
    const fd = fs.openSync(tmp, "w", mode || 0o666);
    try {
        if (mode) try { fs.fchmodSync(fd, mode); } catch (_) { /* not supported */ }
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    try {
        fs.renameSync(tmp, file);
    } catch (_) {
        try {
            fs.writeFileSync(file, data, mode ? { mode } : undefined);
            if (mode) try { fs.chmodSync(file, mode); } catch (_) { /* ignore */ }
        } finally { try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ } }
    }
}

/** Creates `dir` if needed and limits it to the current user (0700, POSIX only). Never throws. */
function ensurePrivateDir(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
        if (process.platform !== "win32") fs.chmodSync(dir, PRIVATE_DIR_MODE);
        return true;
    } catch (_) {
        return false;
    }
}

// ------------------------------------------------------------------ secrets at rest

// Header / query parameter / form field names whose values are credentials (encrypted like Auth-tab secrets): the
// same rule as masking in results and reports (core/secrets.js: Authorization, Cookie, X-API-Key, X-Auth-Token,
// Ocp-Apim-Subscription-Key, access_token, password, ...).
const AUTH_SECRET_FIELDS = { basic: ["password"], bearer: ["token"], apikey: ["value"], oauth2: ["clientSecret", "password"] };
// "{{password}}" only names a variable: nothing secret in it (the variable itself is encrypted when secret)
const ONLY_VARIABLE = /^\s*\{\{[^{}]+\}\}\s*$/;

// { "$enc": "<base64>" }, optionally with "$masked": the value with its secret parts masked, used when the
// ciphertext cannot be decrypted any more (a URL then keeps its host and path instead of becoming empty)
const isSealed = (v) => isObject(v) && typeof v.$enc === "string"
    && Object.keys(v).every((k) => k === "$enc" || (k === "$masked" && typeof v.$masked === "string"));
const worthSealing = (v) => typeof v === "string" && v !== "" && !ONLY_VARIABLE.test(v);
const hasCredentials = (url) => /^[a-z][a-z\d+.-]*:\/\/[^/?#]*@/i.test(String(url || ""));

const decodeName = (s) => {
    try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch (_) { return s; }
};
/** [start, end] of each query parameter value whose name is a credential name (?token=..., &api_key=...). */
function credentialQueryValues(url) {
    const u = String(url || "");
    const q = u.indexOf("?");
    if (q < 0) return [];
    const hash = u.indexOf("#", q);
    const end = hash < 0 ? u.length : hash;
    const out = [];
    let pos = q + 1;
    for (const part of u.slice(q + 1, end).split("&")) {
        const eq = part.indexOf("=");
        if (eq > 0) {
            const value = part.slice(eq + 1);
            if (worthSealing(decodeName(value)) && isCredentialHeader(decodeName(part.slice(0, eq)))) out.push([pos + eq + 1, pos + part.length]);
        }
        pos += part.length + 1;
    }
    return out;
}

/** Does this URL hold a credential: user:password@ or a query parameter like ?token=...? */
const urlHasSecrets = (url) => worthSealing(url) && (hasCredentials(url) || credentialQueryValues(url).length > 0);

/** The URL with the password of user:password@ and credential query values replaced by "•••••". */
function maskUrl(url) {
    let u = String(url || "");
    const spans = credentialQueryValues(u);
    for (let i = spans.length - 1; i >= 0; i--) u = `${u.slice(0, spans[i][0])}${MASK}${u.slice(spans[i][1])}`;
    return u.replace(/^([a-z][a-z\d+.-]*:\/\/)([^/?#]*)@/i, (all, scheme, info) => {
        const colon = info.indexOf(":");
        return colon < 0 ? all : `${scheme}${info.slice(0, colon + 1)}${MASK}@`;
    });
}

/**
 * JSON.stringify replacer that passes every secret string through `seal(plain) -> replacement` (copies are
 * returned, the objects in memory stay as they are): secret variables, Auth secrets (requests, folders, suites,
 * history copies, unsaved tabs), credential headers / query parameters / form fields, and URLs with user:password@
 * or a credential query parameter (requests, history entries, the proxy).
 */
function secretReplacer(seal) {
    const s = (v) => (worthSealing(v) ? seal(v) : v);
    const sealUrl = (url) => {
        const sealed = s(url);
        return isObject(sealed) ? { ...sealed, $masked: maskUrl(url) } : sealed;
    };
    return function replacer(key, value) {
        if (!isObject(value) || isSealed(value)) return value;
        if (typeof value.key === "string" && typeof value.value === "string" && (value.secret === true || isCredentialHeader(value.key))) {
            return { ...value, value: s(value.value) };
        }
        let copy = null;
        if (typeof value.url === "string" && urlHasSecrets(value.url)) copy = { ...value, url: sealUrl(value.url) };
        for (const [part, fields] of Object.entries(AUTH_SECRET_FIELDS)) {
            const obj = value[part];
            if (!isObject(obj) || !fields.some((f) => worthSealing(obj[f]))) continue;
            copy = copy || { ...value };
            copy[part] = { ...obj };
            for (const f of fields) copy[part][f] = s(obj[f]);
        }
        return copy || value;
    };
}

/** JSON.parse that leaves "" (or the masked form) where a { "$enc" } value is and lists them: [{ holder, key, cipher }]. */
function parseWithSealed(text) {
    const sealed = [];
    const data = JSON.parse(text, function reviver(key, value) {
        if (!isSealed(value)) return value;
        sealed.push({ holder: this, key, cipher: value.$enc });
        return typeof value.$masked === "string" ? value.$masked : "";
    });
    return { data, sealed };
}

// ------------------------------------------------------------------ workspace

/** { [suite id or ""]: absolute paths } from the file; approvals of suites that no longer exist are dropped. */
function normalizeApprovals(input, suiteIds) {
    const out = Object.create(null); // suite ids come from files: "__proto__" must stay a plain key
    if (!isObject(input)) return out;
    for (const [key, list] of Object.entries(input)) {
        if (key !== "" && !suiteIds.has(key)) continue;
        const paths = [...new Set((Array.isArray(list) ? list : []).filter((p) => typeof p === "string" && path.isAbsolute(p)))];
        if (paths.length) out[key] = paths.slice(-MAX_APPROVED_FILES);
    }
    return out;
}

const approvalKey = (suiteId) => (typeof suiteId === "string" ? suiteId : "");

class Workspace {
    /**
     * dir: folder of workspace.json (Electron's userData); log: { info, warn, error };
     * secretStore (optional): { available() -> Promise<boolean>, encrypt(text) -> Promise<base64>,
     *   decrypt(base64) -> Promise<text>, availableSync?(), encryptSync?(text), decryptSync?(base64) }
     */
    constructor(dir, { log, secretStore = null } = {}) {
        this.dir = dir;
        this.file = path.join(dir, "workspace.json");
        this.log = log || { info() {}, warn() {}, error() {} };
        this.secretStore = secretStore;
        this.suites = [];
        this.globals = [];
        this.settings = defaultSettings();
        this.history = [];
        this.ui = {};
        this.fileApprovals = Object.create(null);
        this.loaded = false;
        this.loading = null; // promise of loadAsync()
        this.fileExisted = false;
        this.warning = null;
        this.version = 0; // bumped by every change
        this.writtenVersion = 0; // last version on disk
        this.chain = Promise.resolve();
        this.ciphers = new Map(); // plaintext -> ciphertext already on disk (unchanged secrets keep theirs)
        // what the last save did with secrets: "none" (there were none), "encrypted", "plaintext" (no keychain)
        this.secretState = "none";
    }

    /** Reads workspace.json once (later calls return the state in memory, which may be newer than the file). */
    load() {
        if (!this.loaded) this.readFromDisk();
        return {
            suites: this.suites,
            globals: this.globals,
            settings: this.settings,
            history: this.history,
            ui: this.ui,
            firstRun: !this.fileExisted && this.suites.length === 0,
            warning: this.warning,
            secretStorage: this.secretState
        };
    }

    /**
     * Like load(), but decrypts with the asynchronous secret store (desktop start, after the app is ready). Calls
     * while the file is being read wait for it, and so do saves (they must never write a half-loaded state).
     */
    async loadAsync() {
        if (!this.loading) this.loading = this.loaded ? Promise.resolve() : Promise.resolve(this.readFromDisk({ async: true }));
        await this.loading;
        return this.load();
    }

    /** Reads and decrypts the file. Synchronous unless opts.async (then it returns a promise). */
    readFromDisk({ async = false } = {}) {
        this.loaded = true;
        let text;
        try {
            text = fs.readFileSync(this.file, "utf8");
        } catch (err) {
            if (err.code !== "ENOENT") {
                this.warning = `The workspace could not be read (${err.message}). Changes are saved to ${this.file}.`;
                this.log.error(this.warning);
                this.fileExisted = true; // do not show the welcome screen over a real problem
            }
            return async ? Promise.resolve() : undefined;
        }
        this.fileExisted = true;
        let parsed;
        try {
            parsed = parseWithSealed(text);
            if (!isObject(parsed.data)) throw new Error("not a JSON object");
        } catch (err) {
            const kept = this.quarantine();
            this.warning = `The workspace file was damaged (${err.message}) and has been reset.${kept ? ` The old file was kept as ${kept}.` : ""}`;
            this.log.error(this.warning);
            this.fileExisted = false;
            return async ? Promise.resolve() : undefined;
        }
        if (!parsed.sealed.length) return async ? Promise.resolve(this.applyData(text, parsed.data, 0)) : this.applyData(text, parsed.data, 0);
        if (async) {
            return this.decryptAll(parsed.sealed).then((failed) => this.applyData(text, parsed.data, failed));
        }
        return this.applyData(text, parsed.data, this.decryptAllSync(parsed.sealed));
    }

    /** Puts decrypted values in place; -> number of values that could not be decrypted (left empty / masked). */
    async decryptAll(sealed) {
        const store = this.secretStore;
        let failed = 0;
        const available = store ? await Promise.resolve(store.available()).catch(() => false) : false;
        await Promise.all(sealed.map(async (s) => {
            try {
                if (!available) throw new Error("no secret store");
                const plain = await store.decrypt(s.cipher);
                s.holder[s.key] = plain;
                this.ciphers.set(plain, s.cipher);
            } catch (_) {
                failed++;
            }
        }));
        return failed;
    }

    decryptAllSync(sealed) {
        const store = this.secretStore;
        let failed = 0;
        for (const s of sealed) {
            try {
                if (!store || !store.decryptSync || (store.availableSync && !store.availableSync())) throw new Error("no secret store");
                const plain = store.decryptSync(s.cipher);
                s.holder[s.key] = plain;
                this.ciphers.set(plain, s.cipher);
            } catch (_) {
                failed++;
            }
        }
        return failed;
    }

    applyData(text, data, failed) {
        if (failed) {
            // never lose the encrypted values: keep the file as it was, readable again once the keychain allows it
            const kept = path.join(this.dir, `workspace.undecryptable-${Date.now()}.json`);
            try { writeFileAtomicSync(kept, text, { mode: PRIVATE_FILE_MODE }); } catch (_) { /* reported below */ }
            this.warning = `${failed} saved secret value${failed === 1 ? "" : "s"} (passwords, tokens, secret variables, URLs with a password or token) could not be decrypted: `
                + "the system keychain did not allow access, or the workspace comes from another computer or user account. "
                + `They are empty now (a URL shows ••••• in place of its password or token); enter them again. The previous file was kept as ${kept}.`;
            this.log.warn(this.warning);
        }
        const problems = [];
        this.suites = (Array.isArray(data.suites) ? data.suites : []).map((s, i) => {
            try {
                return normalizeSuite(s);
            } catch (err) {
                problems.push(`suite ${i + 1}: ${err.message}`);
                return null;
            }
        }).filter(Boolean);
        // ids must be unique: the sidebar and IPC calls address suites by id
        const seen = new Set();
        this.suites = this.suites.filter((s) => (seen.has(s.id) ? false : seen.add(s.id)));
        this.globals = normalizeVariables(data.globals);
        const fileVersion = Number(data.version) || 1;
        const settings = isObject(data.settings) ? { ...data.settings } : {};
        // 1.0.0 saved autoStart: true for everyone (the old default): the echo server now starts only on request
        if (fileVersion < 2 && isObject(settings.echoServer)) settings.echoServer = { ...settings.echoServer, autoStart: false };
        this.settings = normalizeSettings(settings);
        // entries saved by 1.0.0 still held credentials: removed now (and on every new entry, see addHistory)
        this.history = (Array.isArray(data.history) ? data.history : []).filter(isObject).slice(0, this.settings.historySize).map((e) => historyEntry(e));
        this.ui = isObject(data.ui) ? data.ui : {};
        this.fileApprovals = normalizeApprovals(data.fileApprovals, new Set(this.suites.map((s) => s.id)));
        if (this.ciphers.size) this.secretState = "encrypted";
        if (problems.length) {
            const note = `Some suites could not be loaded and were skipped (${problems.join("; ")}).`;
            this.warning = this.warning ? `${this.warning} ${note}` : note;
            this.log.warn(note);
        }
        const backup = path.join(this.dir, "workspace.backup.json");
        const plaintextSecrets = [...this.secretsToSeal(this.snapshot())].some((p) => !this.ciphers.has(p));
        if (fileVersion < 2 || (plaintextSecrets && this.secretStore)) {
            // a file of 1.0.0 (secrets in plaintext, world-readable) is rewritten right away: encrypted, 0600. The
            // backup is then made from the new file, so no plaintext copy of the secrets is left behind.
            this.persist()
                .then(() => fs.promises.readFile(this.file))
                .then((written) => writeFileAtomic(backup, written, { mode: PRIVATE_FILE_MODE }))
                .catch(() => {});
            return;
        }
        // one backup per start: the last state that loaded fine (written from memory: no race with later saves)
        writeFileAtomic(backup, text, { mode: PRIVATE_FILE_MODE }).catch(() => {});
    }

    quarantine() {
        const target = path.join(this.dir, `workspace.corrupt-${Date.now()}.json`);
        try {
            fs.renameSync(this.file, target);
            try { fs.chmodSync(target, PRIVATE_FILE_MODE); } catch (_) { /* ignore */ }
            return target;
        } catch (_) {
            return null;
        }
    }

    snapshot() {
        return {
            version: WORKSPACE_VERSION,
            suites: this.suites,
            globals: this.globals,
            settings: this.settings,
            history: this.history,
            ui: this.ui,
            fileApprovals: this.fileApprovals
        };
    }

    /** The plaintext secret strings that would be encrypted when saving now. */
    secretsToSeal(data) {
        const found = new Set();
        JSON.stringify(data, secretReplacer((plain) => { found.add(plain); return plain; }));
        return found;
    }

    /** JSON text of the workspace; secrets with a known ciphertext are written as { "$enc" }. */
    sealedJson(data, found) {
        const text = JSON.stringify(data, secretReplacer((plain) => (this.ciphers.has(plain) ? { $enc: this.ciphers.get(plain) } : plain)));
        this.secretState = !found.size ? "none" : [...found].every((p) => this.ciphers.has(p)) ? "encrypted" : "plaintext";
        // forget ciphertexts of secrets that are gone (the map holds plaintext)
        for (const plain of [...this.ciphers.keys()]) if (!found.has(plain)) this.ciphers.delete(plain);
        return text;
    }

    /** Workspace JSON with the secrets encrypted when the secret store can (asynchronous encryption). */
    async serializeAsync() {
        const data = this.snapshot();
        const found = this.secretsToSeal(data);
        const missing = [...found].filter((p) => !this.ciphers.has(p));
        const store = this.secretStore;
        if (missing.length && store && await Promise.resolve(store.available()).catch(() => false)) {
            for (const plain of missing) {
                try {
                    this.ciphers.set(plain, await store.encrypt(plain));
                } catch (err) {
                    this.log.warn(`A secret value could not be encrypted, it is saved unencrypted: ${err.message}`);
                }
            }
        }
        return this.sealedJson(data, found);
    }

    /** Same, synchronous (last write while quitting). */
    serialize() {
        const data = this.snapshot();
        const found = this.secretsToSeal(data);
        const store = this.secretStore;
        const missing = [...found].filter((p) => !this.ciphers.has(p));
        if (missing.length && store && store.encryptSync && (!store.availableSync || store.availableSync())) {
            for (const plain of missing) {
                try { this.ciphers.set(plain, store.encryptSync(plain)); } catch (_) { /* saved unencrypted */ }
            }
        }
        return this.sealedJson(data, found);
    }

    /** Queues a save of the current state; resolves when it (or a later state) is on disk. */
    persist() {
        if (!this.loaded) this.readFromDisk(); // never overwrite a file that was not read
        const wanted = ++this.version;
        const step = this.chain.catch(() => {}).then(async () => {
            if (this.loading) await this.loading.catch(() => {});
            if (this.writtenVersion >= wanted) return; // an earlier queued write already stored this change
            const version = this.version;
            try {
                await writeFileAtomic(this.file, await this.serializeAsync(), { mode: PRIVATE_FILE_MODE });
            } catch (err) {
                this.log.error(`Saving the workspace failed: ${err.message}`);
                throw new Error(`Could not save the workspace (${err.code || err.message}). Check free disk space and permissions of ${this.dir}.`);
            }
            this.writtenVersion = Math.max(this.writtenVersion, version);
        });
        this.chain = step;
        return step;
    }

    /** Waits up to `ms` for queued writes; then writes synchronously if something is still unsaved (quit). */
    async flush(ms = 3000) {
        let timer;
        await Promise.race([
            this.chain.catch(() => {}),
            new Promise((resolve) => { timer = setTimeout(resolve, ms); })
        ]);
        clearTimeout(timer);
        this.flushSync();
    }

    flushSync() {
        if (!this.loaded || this.writtenVersion >= this.version) return;
        try {
            writeFileAtomicSync(this.file, this.serialize(), { mode: PRIVATE_FILE_MODE });
            this.writtenVersion = this.version;
        } catch (err) {
            this.log.error(`Saving the workspace failed: ${err.message}`);
        }
    }

    // ------------------------------------------------------------------ suites

    getSuite(id) {
        return this.suites.find((s) => s.id === id) || null;
    }

    /** Inserts or replaces (by id) a suite; returns the normalised suite. */
    async saveSuite(suite) {
        const normalized = normalizeSuite(suite);
        const index = this.suites.findIndex((s) => s.id === normalized.id);
        if (index >= 0) this.suites[index] = normalized;
        else this.suites.push(normalized);
        await this.persist();
        return normalized;
    }

    async deleteSuite(id) {
        const before = this.suites.length;
        this.suites = this.suites.filter((s) => s.id !== id);
        // a suite imported later with the same id must not inherit these approvals
        const hadApprovals = typeof id === "string" && id !== "" && Object.prototype.hasOwnProperty.call(this.fileApprovals, id);
        if (hadApprovals) delete this.fileApprovals[id];
        if (this.suites.length !== before || hadApprovals) await this.persist();
        return true;
    }

    // ------------------------------------------------------------------ file approvals (uploads of local files)

    /** Absolute paths approved for upload by requests of a suite (null / undefined suite id: unsaved requests). */
    approvedFiles(suiteId) {
        return [...(this.fileApprovals[approvalKey(suiteId)] || [])];
    }

    isFileApproved(suiteId, file) {
        const list = this.fileApprovals[approvalKey(suiteId)];
        return !!list && typeof file === "string" && list.includes(file);
    }

    async approveFiles(suiteId, files) {
        const key = approvalKey(suiteId);
        if (key && !this.getSuite(key)) throw new Error("Suite not found. It may have been deleted.");
        const add = (Array.isArray(files) ? files : [files]).filter((f) => typeof f === "string" && path.isAbsolute(f));
        const list = this.fileApprovals[key] || [];
        const next = [...list.filter((f) => !add.includes(f)), ...add].slice(-MAX_APPROVED_FILES);
        if (next.length === list.length && next.every((f, i) => f === list[i])) return next;
        this.fileApprovals[key] = next;
        await this.persist();
        return [...next];
    }

    async revokeFile(suiteId, file) {
        const key = approvalKey(suiteId);
        const list = this.fileApprovals[key];
        if (!list || !list.includes(file)) return this.approvedFiles(key);
        const next = list.filter((f) => f !== file);
        if (next.length) this.fileApprovals[key] = next;
        else delete this.fileApprovals[key];
        await this.persist();
        return [...next];
    }

    async clearFileApprovals(suiteId) {
        const key = approvalKey(suiteId);
        if (!this.fileApprovals[key]) return true;
        delete this.fileApprovals[key];
        await this.persist();
        return true;
    }

    /** New sidebar order; suites missing from `ids` keep their relative order at the end. */
    async reorderSuites(ids) {
        const order = new Map((Array.isArray(ids) ? ids : []).map((id, i) => [id, i]));
        const rank = (s) => (order.has(s.id) ? order.get(s.id) : order.size + this.suites.indexOf(s));
        this.suites = [...this.suites].sort((a, b) => rank(a) - rank(b));
        await this.persist();
        return this.suites.map((s) => s.id);
    }

    // ------------------------------------------------------------------ globals, settings, UI

    async saveGlobals(vars) {
        this.globals = normalizeVariables(vars);
        await this.persist();
        return this.globals;
    }

    async saveSettings(settings) {
        this.settings = normalizeSettings({ ...this.settings, ...(isObject(settings) ? settings : {}) });
        if (this.history.length > this.settings.historySize) this.history = this.history.slice(0, this.settings.historySize);
        await this.persist();
        return this.settings;
    }

    async saveUi(ui) {
        if (!isObject(ui)) throw new Error("UI state must be an object");
        this.ui = clone(ui);
        await this.persist();
        return true;
    }

    // ------------------------------------------------------------------ history (newest first)

    addHistory(entry) {
        if (this.settings.historySize <= 0) return this.history;
        this.history.unshift(historyEntry(entry));
        if (this.history.length > this.settings.historySize) this.history.length = this.settings.historySize;
        this.persist().catch(() => { /* logged in persist */ });
        return this.history;
    }

    async clearHistory() {
        this.history = [];
        await this.persist();
        return this.history;
    }

    async deleteHistory(id) {
        this.history = this.history.filter((h) => h.id !== id);
        await this.persist();
        return this.history;
    }
}

module.exports = {
    Workspace,
    DEFAULT_SETTINGS,
    defaultSettings,
    normalizeSettings,
    normalizeVariables,
    writeFileAtomic,
    writeFileAtomicSync,
    ensurePrivateDir,
    secretReplacer,
    PRIVATE_FILE_MODE,
    PRIVATE_DIR_MODE
};
