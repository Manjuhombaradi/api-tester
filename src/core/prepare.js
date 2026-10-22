"use strict";
// Turns a request (saved or being edited) into a PreparedRequest ready to send: {{variables}} resolved
// everywhere, enabled params merged into the URL query, inherited headers and auth applied, and the body
// built (JSON / text / XML, form, multipart with files, binary file, GraphQL). Used by the runner, the
// Code view ("Copy as cURL") and the CLI.
const fs = require("fs");
const os = require("os");
const path = require("path");
const FormData = require("form-data");
const { createScope, referencedVariables } = require("./variables");
const { DEFAULT_SETTINGS, USER_AGENT } = require("./http");
const { getOAuth2Token, peekOAuth2Token } = require("./auth");

const DEFAULT_CONTENT_TYPES = {
    json: "application/json",
    text: "text/plain",
    xml: "application/xml",
    form: "application/x-www-form-urlencoded",
    binary: "application/octet-stream",
    graphql: "application/json"
};
const OAUTH_PLACEHOLDER = "<token fetched when sent>";

// ------------------------------------------------------------------ helpers

function enabled(list) {
    return (Array.isArray(list) ? list : []).filter((x) => x && x.enabled !== false);
}

function headerIndex(pairs, name) {
    const n = String(name).toLowerCase();
    return pairs.findIndex(([k]) => k.toLowerCase() === n);
}

function getHeader(pairs, name) {
    const i = headerIndex(pairs, name);
    return i < 0 ? undefined : pairs[i][1];
}

/** Later same-name header (any case) replaces the earlier one, keeping its position. */
function setHeader(pairs, name, value) {
    const i = headerIndex(pairs, name);
    if (i >= 0) pairs[i] = [name, value];
    else pairs.push([name, value]);
}

function ensureContentType(pairs, type) {
    if (getHeader(pairs, "content-type") === undefined) pairs.push(["Content-Type", type]);
}

function safeDecode(s) {
    try {
        return decodeURIComponent(s.replace(/\+/g, " "));
    } catch {
        return s;
    }
}

/**
 * encodeURIComponent, but keeps characters that are safe and more readable in a query (, : / @ $ [ ]) and
 * encodes ' like the URL parser does when sending, so the shown URL is exactly what goes on the wire.
 */
function encodeQuery(s) {
    return encodeURIComponent(s).replace(/%(2C|3A|2F|40|24|5B|5D)/gi, (m) => decodeURIComponent(m)).replace(/'/g, "%27");
}

/** Effective request settings: request-level values (not null) win over the app settings. */
function effectiveSettings(requestSettings, appSettings) {
    const app = { ...DEFAULT_SETTINGS, ...(appSettings || {}) };
    const r = requestSettings || {};
    const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Number(v));
    return {
        timeoutMs: num(r.timeoutMs) ?? num(app.timeoutMs) ?? DEFAULT_SETTINGS.timeoutMs,
        followRedirects: typeof r.followRedirects === "boolean" ? r.followRedirects : app.followRedirects !== false,
        maxRedirects: 10,
        verifyTls: typeof r.verifyTls === "boolean" ? r.verifyTls : app.verifyTls !== false
    };
}

/**
 * The auth that applies to a request: its own, else the nearest folder (inner -> outer) whose auth is not
 * "inherit", else the suite's. -> { auth, source: "request" | "folder" | "suite" | "none", sourceName }
 */
function findEffectiveAuth(request, parents = [], suite = null) {
    const own = request && request.auth;
    if (own && own.type && own.type !== "inherit") return { auth: own, source: "request", sourceName: "" };
    for (let i = parents.length - 1; i >= 0; i--) {
        const a = parents[i] && parents[i].auth;
        if (a && a.type && a.type !== "inherit") return { auth: a, source: "folder", sourceName: parents[i].name || "" };
    }
    if (suite && suite.auth && suite.auth.type && suite.auth.type !== "inherit") return { auth: suite.auth, source: "suite", sourceName: suite.name || "" };
    return { auth: { type: "none" }, source: "none", sourceName: "" };
}

/** Headers in effect: suite, then folders outer -> inner, then the request (later same name replaces earlier). */
function collectHeaders(suite, parents, request, resolve = (s) => s) {
    const out = [];
    for (const list of [suite && suite.headers, ...parents.map((p) => p && p.headers), request && request.headers]) {
        for (const h of enabled(list)) {
            const name = resolve(h.key || "").trim();
            if (name) setHeader(out, name, resolve(h.value || ""));
        }
    }
    return out;
}

function resolveFilePath(filePath, baseDir) {
    let p = String(filePath).trim();
    if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) p = path.join(os.homedir(), p.slice(1));
    return path.isAbsolute(p) ? p : path.resolve(baseDir || process.cwd(), p);
}

async function readFileFor(filePath, what, baseDir) {
    const full = resolveFilePath(filePath, baseDir);
    try {
        return await fs.promises.readFile(full);
    } catch (err) {
        if (err.code === "ENOENT") throw new Error(`File not found for ${what}: ${full}`);
        if (err.code === "EISDIR") throw new Error(`${full} is a folder, not a file (${what})`);
        if (err.code === "EACCES" || err.code === "EPERM") throw new Error(`No permission to read ${full} (${what})`);
        throw new Error(`Cannot read ${full} for ${what}: ${err.message}`);
    }
}

// ------------------------------------------------------------------ URL checks

const SCHEME_PATTERN = /^([a-z][a-z\d+.-]*:)\/\//i;
const EXAMPLE_URL = "https://api.example.com/users";

/** ["a", "b", "c"] -> "a, b and c" */
function joinList(items) {
    return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const varList = (names) => joinList(names.map((n) => `{{${n}}}`));

/**
 * Splits a URL text without normalising it: { scheme: "https:" | "" , authority, host }. Text without
 * "scheme://" is read as starting with the host ("localhost:3000/x"), except when it starts with a single "/".
 */
function splitAuthority(url) {
    const m = SCHEME_PATTERN.exec(url);
    let start = 0;
    if (m) start = m[0].length;
    else if (url.startsWith("//")) start = 2;
    else if (url.startsWith("/")) return { scheme: "", authority: "", host: "" };
    const cut = url.slice(start).search(/[/\\?#]/);
    const authority = cut < 0 ? url.slice(start) : url.slice(start, start + cut);
    const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
    const host = hostPort.startsWith("[") ? hostPort.slice(0, hostPort.indexOf("]") + 1 || undefined) : hostPort.split(":")[0];
    return { scheme: m ? m[1].toLowerCase() : "", authority, host };
}

/**
 * "http://user:p%40ss@host/x" -> { url: "http://host/x", username: "user", password: "p@ss" }, or null when the
 * URL has no user name / password. curl and browsers send these as Basic auth; node's http does not.
 */
function splitUrlCredentials(url) {
    const m = /^((?:https?:)?\/\/)?([^/\\?#]*)@/i.exec(String(url || ""));
    if (!m) return null;
    const decode = (s) => {
        try {
            return decodeURIComponent(s);
        } catch {
            return s;
        }
    };
    const colon = m[2].indexOf(":");
    return {
        url: (m[1] || "") + String(url).slice(m[0].length),
        username: decode(colon < 0 ? m[2] : m[2].slice(0, colon)),
        password: colon < 0 ? "" : decode(m[2].slice(colon + 1))
    };
}

/** Where a variable value came from (variables.js layer source), for messages. */
function sourceLabel(source, scope) {
    const s = String(source || "");
    if (s === "environment") {
        const name = scope && scope.environment && scope.environment.name;
        return name ? `the environment "${name}"` : "the environment";
    }
    if (s === "suite") return "the suite variables";
    if (s === "global") return "the global variables";
    if (s === "data") return "the data file";
    if (s === "runtime") return "the captured (runtime) values";
    if (s.startsWith("folder:")) return `the variables of the folder "${s.slice(7)}"`;
    return s || "the variables";
}

/** '{{baseUrl}} is empty in the environment "Custom". Fill it in or select another environment.' */
function emptyVariablesText(vars, scope) {
    const one = vars.length === 1;
    const sources = [...new Set(vars.map((v) => v.source))];
    const names = sources.length === 1
        ? `${varList(vars.map((v) => v.name))} ${one ? "is" : "are"} empty in ${sourceLabel(sources[0], scope)}`
        : `${joinList(vars.map((v) => `{{${v.name}}} (${sourceLabel(v.source, scope)})`))} are empty`;
    const env = sources.includes("environment") ? " or select another environment" : "";
    return `${names}. Fill ${one ? "it" : "them"} in${env}.`;
}

/** 'Unknown variable {{baseUrl}} in the URL. Select an environment that defines it, or add it as a variable.' */
function unknownVariablesText(names, what, scope) {
    const one = names.length === 1;
    const env = scope && scope.environment && scope.environment.name;
    const head = `Unknown variable${one ? "" : "s"} ${varList(names)} in the ${what}`;
    return env
        ? `${head} (not in the environment "${env}"). Add ${one ? "it" : "them"} to the environment or as ${one ? "a variable" : "variables"}.`
        : `${head}. Select an environment that defines ${one ? "it" : "them"}, or add ${one ? "it as a variable" : "them as variables"}.`;
}

/**
 * Throws a readable Error when a resolved URL cannot be sent because its host is missing or still holds an
 * unknown {{variable}}, naming the variable to fix (an empty {{baseUrl}} turns "{{baseUrl}}/users" into
 * "/users", which would otherwise be sent as "http:///users" = host "users").
 *  template: the URL as written, resolution: scope.resolveDetailed(template), what: "URL" | "OAuth 2.0 token URL".
 *  allowEmpty: an empty URL without variables is reported elsewhere (auth.js for the token URL).
 */
function checkUrlHost(template, resolution, scope, what = "URL", allowEmpty = false) {
    const url = String(resolution.value || "").trim();
    const used = resolution.used.filter((u) => u.source !== "dynamic");
    // empty variables that make up the host part of the URL as written (else: any empty variable it uses)
    const empties = () => {
        const all = used.filter((u) => !String(u.value).trim());
        const inHost = referencedVariables(splitAuthority(String(template || "").trim()).authority);
        const relevant = all.filter((u) => inHost.includes(u.name));
        return relevant.length ? relevant : all;
    };
    if (!url) {
        const empty = empties();
        if (empty.length) throw new Error(`The ${what} is empty: ${emptyVariablesText(empty, scope)}`);
        if (allowEmpty) return;
        throw new Error(`The ${what} is empty. Enter an address like ${EXAMPLE_URL}`);
    }
    const { scheme, host } = splitAuthority(url);
    if (scheme && scheme !== "http:" && scheme !== "https:") return; // http.js reports the unsupported protocol
    if (/\{\{|\}\}/.test(host)) {
        const names = resolution.unresolved.filter((n) => url.includes(n));
        if (names.length) throw new Error(unknownVariablesText(names, what, scope));
        throw new Error(`The host of the ${what} "${url}" still contains {{...}}. Check the variables it uses (a variable may refer to itself).`);
    }
    if (!host.trim()) {
        const empty = empties();
        if (empty.length) throw new Error(`The ${what} "${url}" has no host: ${emptyVariablesText(empty, scope)}`);
        throw new Error(`The ${what} "${url}" has no host name. Enter a full address like ${EXAMPLE_URL}`);
    }
}

/**
 * Adds http:// when the scheme is missing, drops a #fragment (never sent) and appends the params. A URL that
 * cannot have a host (it starts with "/" or with an unknown {{variable}}) is left without a scheme, so the
 * Code view shows it as the user wrote it.
 */
function buildUrl(rawUrl, params, preview) {
    let url = String(rawUrl || "").trim();
    if (!url) {
        if (preview) return "";
        throw new Error(`The URL is empty. Enter an address like ${EXAMPLE_URL}`);
    }
    if (url.startsWith("//")) url = `http:${url}`;
    else if (!SCHEME_PATTERN.test(url) && !url.startsWith("/") && !url.startsWith("{{")) url = `http://${url}`;
    const hashAt = url.indexOf("#");
    if (hashAt >= 0) url = url.slice(0, hashAt);
    if (!params.length) return url;

    // A param that is already in the URL with the same value is not added twice (the editor may keep the
    // URL's query string and the Params table in sync).
    const q = url.indexOf("?");
    const existing = new Set();
    if (q >= 0) {
        for (const part of url.slice(q + 1).split("&")) {
            if (!part) continue;
            const eq = part.indexOf("=");
            existing.add(`${safeDecode(eq < 0 ? part : part.slice(0, eq))}\u0000${eq < 0 ? "" : safeDecode(part.slice(eq + 1))}`);
        }
    }
    const extra = params.filter(([k, v]) => !existing.has(`${k}\u0000${v}`)).map(([k, v]) => `${encodeQuery(k)}=${encodeQuery(v)}`);
    if (!extra.length) return url;
    const sep = q < 0 ? "?" : (url.endsWith("?") || url.endsWith("&") ? "" : "&");
    return url + sep + extra.join("&");
}

// ------------------------------------------------------------------ auth

async function applyAuth(auth, ctx) {
    const { R, headers, query } = ctx;
    const manual = getHeader(headers, "authorization") !== undefined;
    switch (auth.type) {
        case "basic": {
            const user = R(auth.basic && auth.basic.username);
            const pass = R(auth.basic && auth.basic.password);
            if (manual) return "Authorization header set manually (Basic auth not applied)";
            if (!user && !pass) return "Basic auth: user name and password are empty (not sent)";
            setHeader(headers, "Authorization", `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`);
            return `Basic auth (user ${user || "<empty>"})`;
        }
        case "bearer": {
            const token = R(auth.bearer && auth.bearer.token).trim();
            if (manual) return "Authorization header set manually (Bearer token not applied)";
            if (!token) return "Bearer token is empty (not sent)";
            setHeader(headers, "Authorization", `Bearer ${token}`);
            return "Bearer token";
        }
        case "apikey": {
            const a = auth.apikey || {};
            const key = R(a.key).trim();
            const value = R(a.value);
            if (!key) return "API key name is empty (not sent)";
            if (a.in === "query") {
                query.push([key, value]);
                return `API key in query parameter "${key}"`;
            }
            if (getHeader(headers, key) !== undefined) return `Header "${key}" set manually (API key not applied)`;
            setHeader(headers, key, value);
            return `API key in header "${key}"`;
        }
        case "oauth2": {
            const o = auth.oauth2 || {};
            const tokenUrl = ctx.RD(o.tokenUrl);
            const resolved = {
                grantType: R(o.grantType) || "client_credentials",
                tokenUrl: tokenUrl.value.trim(),
                clientId: R(o.clientId).trim(),
                clientSecret: R(o.clientSecret),
                scope: R(o.scope).trim(),
                audience: R(o.audience).trim(),
                username: R(o.username).trim(),
                password: R(o.password),
                clientAuth: o.clientAuth === "basic" ? "basic" : "body"
            };
            const grant = resolved.grantType;
            if (manual) return "Authorization header set manually (OAuth 2.0 not applied)";
            if (ctx.preview) {
                const cached = peekOAuth2Token(resolved, ctx.oauthCache);
                if (cached) {
                    setHeader(headers, "Authorization", `${cached.tokenType} ${cached.accessToken}`);
                    return `${cached.tokenType} token (oauth2 ${grant}, cached)`;
                }
                setHeader(headers, "Authorization", `Bearer ${OAUTH_PLACEHOLDER}`);
                return `Bearer token (oauth2 ${grant}, fetched when the request is sent)`;
            }
            checkUrlHost(o.tokenUrl, tokenUrl, ctx.scope, "OAuth 2.0 token URL", true); // auth.js reports an empty one
            const token = await getOAuth2Token(resolved, { settings: ctx.settings, cache: ctx.oauthCache, signal: ctx.signal });
            setHeader(headers, "Authorization", `${token.tokenType} ${token.accessToken}`);
            return `${token.tokenType} token (oauth2 ${grant}${token.fromCache ? ", cached" : ""})`;
        }
        default:
            return "No auth";
    }
}

// ------------------------------------------------------------------ body

async function buildBody(body, ctx) {
    const { R, headers, preview, baseDir } = ctx;
    const b = body || {};
    const mode = b.mode || "none";
    const none = { body: null, bodyText: "" };
    switch (mode) {
        case "json":
        case "text":
        case "xml": {
            const text = R(b.raw);
            if (!text) return none;
            ensureContentType(headers, DEFAULT_CONTENT_TYPES[mode]);
            return { body: Buffer.from(text, "utf8"), bodyText: text };
        }
        case "form": {
            const form = enabled(b.form).map((kv) => [R(kv.key).trim(), R(kv.value)]).filter(([k]) => k);
            if (!form.length) return { ...none, form };
            const text = new URLSearchParams(form).toString();
            ensureContentType(headers, DEFAULT_CONTENT_TYPES.form);
            return { body: Buffer.from(text, "utf8"), bodyText: text, form };
        }
        case "multipart": {
            const formData = new FormData();
            // a boundary given in the Content-Type header (e.g. copied from a browser) must match the body
            const userType = getHeader(headers, "content-type");
            const userBoundary = userType && (/boundary=("?)([^";]+)\1/i.exec(userType) || [])[2];
            if (userBoundary) formData.setBoundary(userBoundary);
            const parts = [];
            const lines = [];
            for (const p of enabled(b.multipart)) {
                const key = R(p.key).trim();
                if (!key) continue;
                const contentType = R(p.contentType).trim();
                if (p.type === "file") {
                    const filePath = R(p.filePath).trim();
                    if (!filePath) {
                        if (!preview) throw new Error(`Choose a file for the form field "${key}"`);
                        parts.push({ key, type: "file", value: "", filePath: "", fileName: "", contentType });
                        lines.push(`${key}: <no file chosen>`);
                        continue;
                    }
                    const fileName = path.basename(filePath);
                    parts.push({ key, type: "file", value: "", filePath: resolveFilePath(filePath, baseDir), fileName, contentType });
                    lines.push(`${key}: <file ${fileName}>`);
                    if (preview) continue;
                    const data = await readFileFor(filePath, `the form field "${key}"`, baseDir);
                    formData.append(key, data, contentType ? { filename: fileName, contentType } : { filename: fileName });
                } else {
                    const value = R(p.value);
                    parts.push({ key, type: "text", value, filePath: "", fileName: "", contentType });
                    lines.push(`${key}: ${value}`);
                    formData.append(key, value, contentType ? { contentType } : undefined);
                }
            }
            if (!parts.length) return { ...none, multipart: parts };
            if (!userType) headers.push(["Content-Type", `multipart/form-data; boundary=${formData.getBoundary()}`]);
            else if (!userBoundary && /^multipart\//i.test(userType)) setHeader(headers, "Content-Type", `${userType.replace(/;\s*$/, "")}; boundary=${formData.getBoundary()}`);
            return { body: preview ? null : formData.getBuffer(), bodyText: lines.join("\n"), multipart: parts };
        }
        case "binary": {
            const filePath = R(b.binaryPath).trim();
            if (!filePath) {
                if (preview) return { body: null, bodyText: "<no file chosen>", binaryPath: "" };
                throw new Error("Binary body: choose a file to send");
            }
            ensureContentType(headers, DEFAULT_CONTENT_TYPES.binary);
            const fileName = path.basename(filePath);
            const full = resolveFilePath(filePath, baseDir);
            if (preview) return { body: null, bodyText: `<file ${fileName}>`, binaryPath: full };
            return { body: await readFileFor(filePath, "the binary body", baseDir), bodyText: `<file ${fileName}>`, binaryPath: full };
        }
        case "graphql": {
            const g = b.graphql || {};
            const query = R(g.query);
            const variablesText = R(g.variables).trim();
            if (!query.trim() && !variablesText) return none;
            let variables = {};
            if (variablesText) {
                try {
                    variables = JSON.parse(variablesText);
                } catch (err) {
                    throw new Error(`GraphQL variables are not valid JSON: ${err.message}`);
                }
            }
            const text = JSON.stringify({ query, variables });
            ensureContentType(headers, DEFAULT_CONTENT_TYPES.graphql);
            return { body: Buffer.from(text, "utf8"), bodyText: text };
        }
        default:
            return none;
    }
}

// ------------------------------------------------------------------ public API

/**
 * request: model request. options:
 *  suite, parents (folders outer -> inner), scope (variables.createScope; built from suite/parents when missing),
 *  settings (app settings), oauthCache (auth.createOAuthCache), signal (AbortSignal for the token request),
 *  preview: true -> never fetches OAuth tokens (a cached one is used, else a placeholder) and never reads files
 *           (for the Code view / Copy as cURL; missing files and an empty URL do not throw then),
 *  baseDir: folder that relative file paths are resolved against (default: current directory).
 * -> PreparedRequest { method, url, headers: [[name, value]], body: Buffer|null, bodyText, bodyMode,
 *    settings: { timeoutMs, followRedirects, maxRedirects, verifyTls }, unresolved: string[], authInfo,
 *    form?: [[k, v]], multipart?: [{ key, type, value, filePath, fileName, contentType }], binaryPath? }
 * Throws a readable Error for problems the user must fix (empty URL, a URL without host or with an unknown
 * {{variable}} in the host - naming the empty / unknown variable, missing file, bad GraphQL variables, failed
 * OAuth token request). In preview mode only GraphQL variables can throw. User name and password in the URL
 * are moved into a Basic Authorization header (unless one is set).
 */
async function prepareRequest(request, options = {}) {
    if (!request || typeof request !== "object") throw new Error("No request to prepare");
    const { suite = null, parents = [], settings = null, oauthCache = null, signal = null, preview = false, baseDir = null } = options;
    const scope = options.scope || createScope({ suite, parents });
    const unresolved = new Set();
    /** Resolves {{variables}} -> { value, unresolved, used } and remembers the unknown names. */
    const RD = (text) => {
        const r = scope.resolveDetailed(text === undefined || text === null ? "" : String(text));
        for (const name of r.unresolved) unresolved.add(name);
        return r;
    };
    const R = (text) => RD(text).value;
    const appSettings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    const effective = effectiveSettings(request.settings, appSettings);

    const method = (R(request.method || "GET").trim() || "GET").toUpperCase();
    const query = enabled(request.params).map((p) => [R(p.key).trim(), R(p.value)]).filter(([k]) => k);
    const headers = collectHeaders(suite, parents, request, R);

    // the URL is checked before the auth: no OAuth token is fetched for a URL that cannot be sent
    const urlResolution = RD(request.url);
    if (!preview) checkUrlHost(request.url, urlResolution, scope);

    const { auth, source, sourceName } = findEffectiveAuth(request, parents, suite);
    let authInfo = await applyAuth(auth, {
        R, RD, scope, headers, query, preview, oauthCache, signal,
        settings: { ...appSettings, timeoutMs: effective.timeoutMs, verifyTls: effective.verifyTls }
    });
    if (auth.type !== "none" && source === "folder") authInfo += ` - from folder "${sourceName}"`;
    else if (auth.type !== "none" && source === "suite") authInfo += " - from suite";

    let url = buildUrl(urlResolution.value, query, preview);
    // "http://user:pass@host/": sent as Basic auth like curl does (node's http would silently drop it)
    const credentials = splitUrlCredentials(url);
    if (credentials) {
        url = credentials.url;
        if (credentials.username || credentials.password) {
            let info;
            if (getHeader(headers, "authorization") !== undefined) {
                info = "user name and password in the URL not used (an Authorization header is set)";
            } else {
                setHeader(headers, "Authorization", `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, "utf8").toString("base64")}`);
                info = `Basic auth from the URL (user ${credentials.username || "<empty>"})`;
            }
            authInfo = auth.type === "none" ? info.charAt(0).toUpperCase() + info.slice(1) : `${authInfo}; ${info}`;
        }
    }
    const bodyMode = (request.body && request.body.mode) || "none";
    const built = await buildBody(request.body, { R, headers, preview, baseDir });

    if (getHeader(headers, "user-agent") === undefined) headers.push(["User-Agent", USER_AGENT]);
    if (getHeader(headers, "accept") === undefined) headers.push(["Accept", "*/*"]);

    const prepared = {
        method,
        url,
        headers,
        body: built.body,
        bodyText: built.bodyText,
        bodyMode,
        settings: effective,
        unresolved: [...unresolved],
        authInfo
    };
    if (built.form) prepared.form = built.form;
    if (built.multipart) prepared.multipart = built.multipart;
    if (built.binaryPath !== undefined) prepared.binaryPath = built.binaryPath;
    return prepared;
}

module.exports = { prepareRequest, effectiveSettings, findEffectiveAuth, collectHeaders, buildUrl, checkUrlHost, splitUrlCredentials, OAUTH_PLACEHOLDER };
