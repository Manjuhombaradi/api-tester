"use strict";
// Suite files: export (.apisuite, shareable JSON) and import of everything a tester may receive:
// API Tester suites / environments / workspace backups, Postman collections and environments,
// OpenAPI 3 / Swagger 2 (JSON or YAML), cURL commands and plain URLs.
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const model = require("./model");
const postman = require("./importers/postman");
const openapi = require("./importers/openapi");
const { listNames, plural } = require("./importers/common");

const SUITE_EXTENSION = "apisuite";
const ENVIRONMENT_FORMAT = "api-tester-environment";
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const SECRET_AUTH_FIELDS = [["basic", "password"], ["bearer", "token"], ["apikey", "value"], ["oauth2", "clientSecret"], ["oauth2", "password"]];

function appVersion() {
    try { return require("../../package.json").version || ""; } catch { return ""; }
}

const hasVariable = (value) => /\{\{[^{}]+\}\}/.test(String(value || ""));

// ------------------------------------------------------------------ export

/** Blanks secret variable values; returns how many were blanked. */
function blankSecretVariables(list) {
    let n = 0;
    for (const v of list || []) {
        if (v.secret && v.value) { v.value = ""; n++; }
    }
    return n;
}

/**
 * Blanks credentials typed directly into an Auth tab (password, token, API key, client secret).
 * Values that only reference variables ({{token}}) are kept: they are not secrets themselves.
 */
function blankAuthCredentials(auth) {
    let n = 0;
    if (!auth || auth.type === "none" || auth.type === "inherit") return 0;
    for (const [group, field] of SECRET_AUTH_FIELDS) {
        if (group !== auth.type || !auth[group]) continue;
        const value = auth[group][field];
        if (value && !hasVariable(value)) { auth[group][field] = ""; n++; }
    }
    return n;
}

/**
 * Suite -> pretty JSON text for a .apisuite file.
 * Without includeSecrets, secret variable values and credentials typed into Auth tabs are left out (blank);
 * the secret flags stay, so whoever imports the file knows what to fill in.
 */
function exportSuite(suite, { includeEnvironments = true, includeSecrets = false } = {}) {
    const s = model.normalizeSuite(JSON.parse(JSON.stringify(suite)));
    if (!includeSecrets) {
        blankSecretVariables(s.variables);
        blankAuthCredentials(s.auth);
        model.walkItems(s.items, (item) => {
            blankAuthCredentials(item.auth);
            if (item.type === "folder") blankSecretVariables(item.variables);
        });
    }
    if (!includeEnvironments) {
        s.environments = [];
        s.activeEnvironmentId = null;
    } else if (!includeSecrets) {
        for (const env of s.environments) blankSecretVariables(env.variables);
    }
    const { format, version, ...rest } = s;
    const file = { format, version, exportedAt: new Date().toISOString(), exportedWith: `API Tester ${appVersion()}`.trim(), secretsIncluded: !!includeSecrets, ...rest };
    return `${JSON.stringify(file, null, 2)}\n`;
}

/** Environment -> JSON text (for sharing one environment on its own). */
function exportEnvironment(environment, { includeSecrets = false } = {}) {
    const variables = JSON.parse(JSON.stringify(environment.variables || []));
    if (!includeSecrets) blankSecretVariables(variables);
    return `${JSON.stringify({ format: ENVIRONMENT_FORMAT, version: 1, exportedAt: new Date().toISOString(), name: environment.name || "Environment", variables }, null, 2)}\n`;
}

/** Safe file name "<suite name>.apisuite" for save dialogs (all platforms). */
function suiteFileName(suite) {
    let base = String((suite && suite.name) || "").normalize("NFC")
        .replace(/\s*:\s*/g, " - ")
        .replace(/[\\/*?"<>|\u0000-\u001f\u007f]+/g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^[.\s-]+|[.\s]+$/g, "");
    if (base.length > 100) base = base.slice(0, 100).trim();
    if (!base) base = "suite";
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = `${base}-suite`; // reserved names on Windows
    return `${base}.${SUITE_EXTENSION}`;
}

// ------------------------------------------------------------------ import helpers

function unrecognised(label) {
    return new Error(`Unrecognised file${label ? ` "${label}"` : ""}: expected an API Tester suite (.${SUITE_EXTENSION}), a Postman collection or ` +
        "environment, an OpenAPI / Swagger definition (JSON or YAML) or a cURL command.");
}

/** Normalises an imported suite and warns about secrets / credentials left empty by an export without secrets. */
function finishSuite(suite, warnings, { checkSecrets = false, checkCredentials = false } = {}) {
    const s = model.normalizeSuite(suite);
    const emptySecrets = [];
    const emptyCredentials = [];
    const checkVars = (list, where) => {
        if (!checkSecrets) return;
        for (const v of list) if (v.secret && v.enabled && !v.value) emptySecrets.push(where ? `${v.key} (${where})` : v.key);
    };
    const checkAuth = (auth, owner) => {
        if (!checkCredentials || !auth || !auth[auth.type]) return;
        for (const [group, field] of SECRET_AUTH_FIELDS) {
            if (group !== auth.type || (field === "password" && group === "oauth2" && auth.oauth2.grantType !== "password")) continue;
            if (auth[group][field] === "") { emptyCredentials.push(owner); break; }
        }
    };
    checkVars(s.variables, "");
    checkAuth(s.auth, "the suite");
    model.walkItems(s.items, (item) => {
        checkAuth(item.auth, item.name);
        if (item.type === "folder") checkVars(item.variables, item.name);
    });
    for (const env of s.environments) checkVars(env.variables, env.name);
    if (emptySecrets.length) warnings.push(`Secret values were not included in the file; fill them in: ${listNames(emptySecrets, 6)}.`);
    if (emptyCredentials.length) warnings.push(`Credentials are empty in the Auth tab of ${listNames(emptyCredentials)}; fill them in.`);
    return s;
}

function suiteStats(suites) {
    let requests = 0, folders = 0;
    for (const s of suites) model.walkItems(s.items, (item) => { if (item.type === "folder") folders++; else requests++; });
    return `${plural(requests, "request")}${folders ? ` in ${plural(folders, "folder")}` : ""}`;
}

/** ImportResult; summary is a one-line description for the import preview, e.g. "Postman collection: 12 requests in 3 folders". */
function result(kind, source, { suites = [], environments = [], warnings = [], what }) {
    const parts = [];
    if (kind === "environment") {
        parts.push(environments.map((e) => `"${e.name}" (${plural(e.variables.length, "variable")})`).join(", "));
    } else {
        if (suites.length > 1) parts.push(plural(suites.length, "suite"));
        parts.push(suiteStats(suites));
        const envCount = suites.reduce((n, s) => n + s.environments.length, 0);
        if (envCount) parts.push(plural(envCount, "environment"));
    }
    return { kind, suites, environments, warnings, source, summary: `${what}: ${parts.join(", ")}` };
}

function isApiTesterSuite(obj) {
    return !!obj && typeof obj === "object" && !Array.isArray(obj) &&
        (obj.format === model.SUITE_FORMAT || (obj.format === undefined && Array.isArray(obj.items) && !obj.info && !obj.item));
}

function isApiTesterEnvironment(obj) {
    return !!obj && typeof obj === "object" && !Array.isArray(obj) &&
        (obj.format === ENVIRONMENT_FORMAT || (obj.format === undefined && typeof obj.name === "string" && Array.isArray(obj.variables) && !obj.items && !obj.values));
}

function toEnvironment(obj) {
    return model.newEnvironment(String(obj.name || "Environment"), (obj.variables || []).filter((v) => v && typeof v === "object" && v.key).map((v) => model.newVariable(
        String(v.key), v.value == null ? "" : String(v.value), { enabled: v.enabled !== false, secret: !!v.secret, description: String(v.description || "") })));
}

/** "Copy all as cURL" pastes several commands; split them (quotes and line continuations respected). */
function splitCurlCommands(textIn) {
    const textValue = String(textIn);
    const commands = [];
    let current = "";
    let quote = null;
    let ansi = false;
    for (let i = 0; i < textValue.length; i++) {
        const c = textValue[i];
        if (quote) {
            current += c;
            if (c === "\\" && (quote === "\"" || ansi)) {
                current += textValue[++i] ?? "";
            } else if (c === quote) {
                quote = null;
                ansi = false;
            }
            continue;
        }
        if (c === "'" || c === "\"") {
            quote = c;
            ansi = c === "'" && textValue[i - 1] === "$";
            current += c;
            continue;
        }
        if (c === "\n") {
            const line = current.replace(/\r$/, "");
            const continued = /[\\^`]$/.test(line);
            if (!continued && /^\s*(?:\$\s+)?curl(?:\.exe)?\s/i.test(textValue.slice(i + 1, i + 200))) {
                commands.push(current);
                current = "";
                continue;
            }
        }
        current += c;
    }
    commands.push(current);
    return commands
        .map((cmd) => cmd.trim().replace(/^\$\s+/, "").replace(/\s*(?:;|&&|&)\s*$/, "").trim())
        .filter((cmd) => /^curl(?:\.exe)?\s/i.test(cmd));
}

function requestNameFromUrl(method, url) {
    try {
        const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`);
        return `${method} ${u.pathname === "/" ? u.host : u.pathname}`;
    } catch {
        return `${method} ${url}`.slice(0, 80);
    }
}

function hostOf(url) {
    try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`).host; } catch { return ""; }
}

function importCurl(textValue) {
    let curl;
    try {
        curl = require("./curl");
    } catch (err) {
        throw new Error(`cURL import is not available: ${err.message}`);
    }
    const commands = splitCurlCommands(textValue);
    if (!commands.length) throw new Error("No cURL command found");
    const warnings = [];
    const items = commands.map((cmd, i) => {
        let request;
        try {
            if (typeof curl.parseCurlDetailed === "function") {
                const detailed = curl.parseCurlDetailed(cmd);
                request = detailed.request;
                for (const w of detailed.warnings || []) warnings.push(commands.length > 1 ? `Command ${i + 1}: ${w}` : w);
            } else {
                request = curl.parseCurl(cmd);
            }
        } catch (err) {
            throw new Error(commands.length > 1 ? `cURL command ${i + 1}: ${err.message}` : err.message);
        }
        if (!request || typeof request !== "object") throw new Error(`cURL command ${i + 1} could not be read`);
        if (!request.name || request.name === "New Request") request.name = requestNameFromUrl(request.method || "GET", request.url || "");
        return request;
    });
    const host = hostOf(items[0].url || "");
    const suite = model.newSuite(host ? `${host} (cURL)` : "Imported cURL", { items });
    const s = finishSuite(suite, warnings);
    return result("curl", "curl", { suites: [s], warnings, what: commands.length > 1 ? `${commands.length} cURL commands` : "cURL command" });
}

function importUrl(url) {
    const request = model.newRequest(requestNameFromUrl("GET", url), { url });
    const host = hostOf(url);
    const s = model.normalizeSuite(model.newSuite(host || "Imported URL", { items: [request] }));
    return result("curl", "curl", { suites: [s], warnings: [], what: "URL" });
}

/** Parsed JSON / YAML value -> ImportResult. */
function importObject(obj, label) {
    if (Array.isArray(obj)) {
        if (obj.length && obj.every(isApiTesterSuite)) {
            const warnings = [];
            const suites = obj.map((s) => finishSuite(s, warnings, { checkSecrets: true, checkCredentials: s.secretsIncluded === false }));
            return result("suite", "api-tester", { suites, warnings, what: "API Tester suites" });
        }
        if (obj.length && obj.every((o) => postman.isPostmanEnvironment(o))) {
            const warnings = [];
            const environments = obj.map((o) => { const r = postman.importPostmanEnvironment(o); warnings.push(...r.warnings); return r.environment; });
            return result("environment", "postman-environment", { environments, warnings, what: "Postman environments" });
        }
        throw unrecognised(label);
    }
    if (!obj || typeof obj !== "object") throw unrecognised(label);

    if (isApiTesterSuite(obj)) {
        const warnings = [];
        if (Number(obj.version) > model.SUITE_VERSION) warnings.push("This file was made with a newer version of API Tester; settings this version does not know were skipped.");
        const s = finishSuite(obj, warnings, { checkSecrets: true, checkCredentials: obj.secretsIncluded === false });
        return result("suite", "api-tester", { suites: [s], warnings, what: "API Tester suite" });
    }
    if (isApiTesterEnvironment(obj)) {
        const env = toEnvironment(obj);
        const warnings = [];
        const empty = env.variables.filter((v) => v.secret && !v.value).map((v) => v.key);
        if (empty.length) warnings.push(`Secret values were not included in the file; fill them in: ${listNames(empty, 6)}.`);
        return result("environment", "api-tester", { environments: [env], warnings, what: "API Tester environment" });
    }
    if (Array.isArray(obj.suites) && !obj.info) {
        // Workspace backup (workspace.json of the desktop app).
        const warnings = [];
        const suites = obj.suites.filter(isApiTesterSuite).map((s) => finishSuite(s, warnings, { checkSecrets: true }));
        if (!suites.length) throw new Error(`"${label || "The file"}" is a workspace file without suites`);
        if (Array.isArray(obj.globals) && obj.globals.length) warnings.push("Global variables in the backup were not imported.");
        return result("suite", "api-tester", { suites, warnings, what: "API Tester workspace" });
    }
    if (postman.isPostmanCollectionV1(obj)) {
        throw new Error("This is a Postman collection in the old v1 format. In Postman, export it again as \"Collection v2.1\" and import that file.");
    }
    if (postman.isPostmanCollection(obj)) {
        const r = postman.importPostmanCollection(obj);
        const warnings = [...r.warnings];
        const s = finishSuite(r.suite, warnings);
        return result("suite", "postman", { suites: [s], warnings, what: "Postman collection" });
    }
    if (postman.isPostmanEnvironment(obj)) {
        const r = postman.importPostmanEnvironment(obj);
        return result("environment", "postman-environment", { environments: [r.environment], warnings: r.warnings, what: obj._postman_variable_scope === "globals" ? "Postman globals" : "Postman environment" });
    }
    if (openapi.isOpenApi(obj) || openapi.isSwagger(obj)) {
        const r = openapi.importOpenApi(obj);
        const warnings = [...r.warnings];
        const s = finishSuite(r.suite, warnings);
        const what = r.source === "swagger" ? "Swagger 2.0 definition" : `OpenAPI ${String(obj.openapi)} definition`;
        return result("suite", r.source, { suites: [s], warnings, what });
    }
    if (obj.swagger !== undefined) throw new Error(`Swagger ${obj.swagger} is not supported. Convert it to Swagger 2.0 or OpenAPI 3 first.`);
    if (obj.openapi !== undefined) throw new Error(`OpenAPI ${obj.openapi} is not supported (only 3.x).`);
    throw unrecognised(label);
}

/**
 * Detects the kind of text and imports it.
 * -> { kind: "suite"|"environment"|"curl", suites, environments, warnings, source, summary }
 */
function importText(input, fileName = "") {
    let textValue = Buffer.isBuffer(input) ? decodeBuffer(input) : String(input ?? "");
    textValue = textValue.replace(/^﻿/, "");
    const label = fileName ? path.basename(String(fileName)) : "";
    const trimmed = textValue.trim();
    if (!trimmed) throw new Error(label ? `"${label}" is empty` : "Nothing to import: the text is empty");

    const withoutPrompt = trimmed.replace(/^\$\s+/, "");
    if (/^curl(?:\.exe)?\s/i.test(withoutPrompt)) return importCurl(withoutPrompt);
    if (/^https?:\/\/[^\s"'<>]+$/i.test(trimmed)) return importUrl(trimmed);

    let obj;
    if (/^[{[]/.test(trimmed)) {
        try {
            obj = JSON.parse(trimmed);
        } catch (jsonError) {
            // JSON with comments or trailing commas is still valid YAML in many cases.
            try { obj = yaml.load(trimmed); } catch { obj = undefined; }
            if (!obj || typeof obj !== "object") throw new Error(`${label ? `"${label}"` : "The text"} looks like JSON but is not valid: ${jsonError.message}`);
        }
    } else {
        try {
            obj = yaml.load(trimmed);
        } catch (yamlError) {
            if (/^\s*["']?(openapi|swagger)["']?\s*:/m.test(trimmed)) {
                throw new Error(`${label ? `"${label}"` : "The text"} looks like an OpenAPI YAML file but is not valid YAML: ${String(yamlError.message).split("\n")[0]}`);
            }
            throw unrecognised(label);
        }
    }
    return importObject(obj, label);
}

/** Buffer -> text (UTF-8, or UTF-16 with a byte order mark, as written by some Windows tools). */
function decodeBuffer(buf) {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString("utf16le");
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        const swapped = Buffer.from(buf.slice(2));
        swapped.swap16();
        return swapped.toString("utf16le");
    }
    return buf.toString("utf8");
}

/** Reads a file and imports it (see importText). */
function importFile(filePath) {
    const name = path.basename(String(filePath || ""));
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (err) {
        throw new Error(err.code === "ENOENT" ? `File not found: ${filePath}` : `Cannot open ${filePath}: ${err.message}`);
    }
    if (stat.isDirectory()) throw new Error(`"${name}" is a folder, not a file`);
    if (stat.size > MAX_IMPORT_BYTES) throw new Error(`"${name}" is too large to import (${(stat.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_IMPORT_BYTES / 1024 / 1024} MB)`);
    let buf;
    try {
        buf = fs.readFileSync(filePath);
    } catch (err) {
        throw new Error(`Cannot read ${filePath}: ${err.message}`);
    }
    return importText(decodeBuffer(buf), filePath);
}

module.exports = {
    SUITE_EXTENSION, ENVIRONMENT_FORMAT,
    exportSuite, exportEnvironment, importText, importFile, suiteFileName, splitCurlCommands
};
