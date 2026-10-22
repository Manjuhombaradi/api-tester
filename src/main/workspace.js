"use strict";
// Workspace persistence of the desktop app: suites (sidebar order), globals, settings, request history and
// UI state, kept in memory and saved to <userData>/workspace.json. Pure Node.js (no Electron imports), so the
// CLI can reuse the settings defaults.
//
// Saving: every change bumps a version number and queues one atomic write (temp file + fsync + rename).
// Writes are serialised; when several changes arrive while a write is running, the next write stores all of
// them at once. A failed write rejects the promise of the change that triggered it, so the renderer can tell
// the user (disk full, permissions).
const fs = require("fs");
const path = require("path");
const { normalizeSuite } = require("../core/model");

const WORKSPACE_VERSION = 1;
const THEMES = ["system", "light", "dark"];
// a history entry keeps a copy of the request; very large bodies are cut so 100 entries stay small
const HISTORY_REQUEST_MAX_CHARS = 256 * 1024;

const DEFAULT_SETTINGS = Object.freeze({
    timeoutMs: 30000,
    followRedirects: true,
    verifyTls: true,
    proxy: Object.freeze({ enabled: false, url: "", noProxy: "localhost,127.0.0.1" }),
    maxResponseMB: 20,
    historySize: 100,
    echoServer: Object.freeze({ autoStart: true, port: 3999 }),
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

/** Copy of a request for the history; huge bodies are shortened. */
function historyRequestCopy(request) {
    if (!isObject(request)) return null;
    const copy = clone(request);
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

// ------------------------------------------------------------------ atomic file writes

async function writeFileAtomic(file, data) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const handle = await fs.promises.open(tmp, "w");
    try {
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
            await fs.promises.writeFile(file, data);
        } finally {
            await fs.promises.unlink(tmp).catch(() => {});
        }
    }
}

function writeFileAtomicSync(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.sync.tmp`;
    const fd = fs.openSync(tmp, "w");
    try {
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    try {
        fs.renameSync(tmp, file);
    } catch (_) {
        try { fs.writeFileSync(file, data); } finally { try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ } }
    }
}

// ------------------------------------------------------------------ workspace

class Workspace {
    /** dir: folder of workspace.json (Electron's userData); log: { info, warn, error } */
    constructor(dir, { log } = {}) {
        this.dir = dir;
        this.file = path.join(dir, "workspace.json");
        this.log = log || { info() {}, warn() {}, error() {} };
        this.suites = [];
        this.globals = [];
        this.settings = defaultSettings();
        this.history = [];
        this.ui = {};
        this.loaded = false;
        this.fileExisted = false;
        this.warning = null;
        this.version = 0; // bumped by every change
        this.writtenVersion = 0; // last version on disk
        this.chain = Promise.resolve();
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
            warning: this.warning
        };
    }

    readFromDisk() {
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
            return;
        }
        this.fileExisted = true;
        let data;
        try {
            data = JSON.parse(text);
            if (!isObject(data)) throw new Error("not a JSON object");
        } catch (err) {
            const kept = this.quarantine();
            this.warning = `The workspace file was damaged (${err.message}) and has been reset.${kept ? ` The old file was kept as ${kept}.` : ""}`;
            this.log.error(this.warning);
            this.fileExisted = false;
            return;
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
        this.settings = normalizeSettings(data.settings);
        this.history = (Array.isArray(data.history) ? data.history : []).filter(isObject).slice(0, this.settings.historySize);
        this.ui = isObject(data.ui) ? data.ui : {};
        if (problems.length) {
            this.warning = `Some suites could not be loaded and were skipped (${problems.join("; ")}).`;
            this.log.warn(this.warning);
        }
        // one backup per start: the last state that loaded fine (written from memory: no race with later saves)
        writeFileAtomic(path.join(this.dir, "workspace.backup.json"), text).catch(() => {});
    }

    quarantine() {
        const target = path.join(this.dir, `workspace.corrupt-${Date.now()}.json`);
        try {
            fs.renameSync(this.file, target);
            return target;
        } catch (_) {
            return null;
        }
    }

    serialize() {
        return JSON.stringify({
            version: WORKSPACE_VERSION,
            suites: this.suites,
            globals: this.globals,
            settings: this.settings,
            history: this.history,
            ui: this.ui
        });
    }

    /** Queues a save of the current state; resolves when it (or a later state) is on disk. */
    persist() {
        if (!this.loaded) this.readFromDisk(); // never overwrite a file that was not read
        const wanted = ++this.version;
        const step = this.chain.catch(() => {}).then(async () => {
            if (this.writtenVersion >= wanted) return; // an earlier queued write already stored this change
            const version = this.version;
            try {
                await writeFileAtomic(this.file, this.serialize());
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
            writeFileAtomicSync(this.file, this.serialize());
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
        if (this.suites.length !== before) await this.persist();
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
        this.history.unshift({ ...entry, request: historyRequestCopy(entry.request) });
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
    writeFileAtomicSync
};
