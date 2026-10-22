"use strict";
// Runs requests: one request (the Send button) or a whole suite / folder selection (the runner and the CLI).
//
// One request: build the variable scope -> pre-request script (may set variables or change the request)
// -> prepare (resolve variables, auth, body) -> send -> post-response script -> assertions (+ script tests)
// -> captures. A run: the selected requests in tree order, once per iteration, sharing one runtime variable
// object, one cookie jar and one OAuth2 token cache, so captured values chain requests across the run.
const model = require("./model");
const { createScope } = require("./variables");
const { prepareRequest, authSecretValues } = require("./prepare");
const { sendRequest } = require("./http");
const { createOAuthCache } = require("./auth");
const { createCookieJar } = require("./cookies");
const { evaluateAssertions } = require("./assertions");
const { runExtractions } = require("./extract");
const { runScript } = require("./scripts");
const { createTimeBudget } = require("./limits");
const { MASK, MIN_SECRET_CHARS, isCredentialHeader, maskHeaderValue, maskCookies, redactRequest, credentialParts } = require("./secrets");

const MAX_BODY_CHARS = 2 * 1024 * 1024; // response text kept in a RequestResult
const RUN_BODY_CHARS = 1024 * 1024; // per request in a suite run (a run can hold thousands of results)
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // images up to this size are kept as base64 for the preview
const RAW_BODY_MODES = ["json", "text", "xml"];

const EMPTY_SUITE = Object.freeze({ id: null, name: "", variables: [], headers: [], auth: model.defaultAuth("none"), environments: [], items: [] });

function findEnvironment(suite, environmentId) {
    const list = (suite && Array.isArray(suite.environments)) ? suite.environments : [];
    // undefined -> the suite's active environment; null / "" -> no environment
    const id = environmentId === undefined ? suite && suite.activeEnvironmentId : environmentId;
    return id ? list.find((e) => e && e.id === id) || null : null;
}

/** Data row values as text (JSON data files may hold numbers, booleans or objects). */
function dataRow(row) {
    if (!row || typeof row !== "object") return null;
    const out = {};
    for (const [key, value] of Object.entries(row)) {
        out[key] = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    }
    return out;
}

function jsonText(v) {
    try {
        return JSON.stringify(v) || "";
    } catch {
        return "";
    }
}

function errorMessage(err) {
    return err && err.message ? String(err.message) : String(err || "Unknown error");
}

// ------------------------------------------------------------------ pre-request script <-> request

/** URL with the enabled Params appended, variables resolved (what the script sees as request.url). */
function viewUrl(request, scope) {
    const base = scope.resolve(request.url || "");
    const params = (request.params || []).filter((p) => p && p.enabled !== false && String(p.key ?? "").trim());
    if (!params.length) return base;
    const hashAt = base.indexOf("#");
    const head = hashAt >= 0 ? base.slice(0, hashAt) : base;
    const hash = hashAt >= 0 ? base.slice(hashAt) : "";
    const query = params.map((p) => `${encodeURIComponent(scope.resolve(p.key).trim())}=${encodeURIComponent(scope.resolve(p.value))}`).join("&");
    const joiner = !head.includes("?") ? "?" : head.endsWith("?") || head.endsWith("&") ? "" : "&";
    return `${head}${joiner}${query}${hash}`;
}

/** What the pre-request script sees: the request with variables resolved (full URL, request level headers, raw body). */
function scriptRequestView(request, scope) {
    const headers = {};
    for (const h of request.headers || []) {
        if (h && h.enabled !== false && h.key) headers[scope.resolve(h.key)] = scope.resolve(h.value);
    }
    const mode = request.body && request.body.mode;
    return {
        method: String(request.method || "GET").toUpperCase(),
        url: viewUrl(request, scope),
        headers,
        body: RAW_BODY_MODES.includes(mode) ? scope.resolve(request.body.raw || "") : ""
    };
}

/** Applies the changes a pre-request script made to its request view onto the (copied) request. */
function applyScriptChanges(request, before, after) {
    if (!after) return;
    if (after.method && after.method !== before.method) request.method = after.method;
    if (after.url !== before.url) {
        request.url = after.url; // the new URL already holds the query string
        request.params = [];
    }
    const lowerBefore = new Map(Object.keys(before.headers).map((k) => [k.toLowerCase(), k]));
    const lowerAfter = new Map(Object.keys(after.headers).map((k) => [k.toLowerCase(), k]));
    request.headers = Array.isArray(request.headers) ? request.headers : [];
    const rowsFor = (lower) => request.headers.filter((h) => h && h.enabled !== false && String(h.key).trim().toLowerCase() === lower);
    for (const [lower, name] of lowerAfter) {
        const value = after.headers[name];
        const oldName = lowerBefore.get(lower);
        if (oldName !== undefined && before.headers[oldName] === value) continue;
        const rows = rowsFor(lower);
        if (rows.length) {
            // literal value from the script (already resolved); keep one row
            rows[0].key = name;
            rows[0].value = value;
            for (const extra of rows.slice(1)) extra.enabled = false;
        } else {
            request.headers.push(model.newKeyValue(name, value));
        }
    }
    for (const lower of lowerBefore.keys()) {
        if (!lowerAfter.has(lower)) for (const h of rowsFor(lower)) h.enabled = false;
    }
    if (after.body !== before.body) {
        request.body = request.body && typeof request.body === "object" ? request.body : model.defaultBody("none");
        if (!RAW_BODY_MODES.includes(request.body.mode)) request.body.mode = "text";
        request.body.raw = after.body;
    }
}

// ------------------------------------------------------------------ masking secrets in results and reports

// a header value that may carry base64 credentials: "Basic dXNlcjpwYXNz", "<scheme> <base64>" or only base64
const BASE64_CREDENTIALS_RE = /^(\s*(?:[A-Za-z][\w.-]*\s+)?)([A-Za-z0-9+/_-]{4,}={0,2})(\s*)$/;

/** base64 text -> decoded UTF-8 text, or null when it is not base64 of readable text. */
function decodeBase64Text(token) {
    const clean = token.replace(/=+$/, "");
    if (clean.length % 4 === 1) return null;
    try {
        const text = Buffer.from(clean, "base64").toString("utf8");
        return text && !text.includes("\uFFFD") ? text : null;
    } catch {
        return null;
    }
}

/** The ways a secret can appear in a URL or body besides itself: base64 (Basic auth), URL and form encoding. */
function encodedForms(secret) {
    const b64 = Buffer.from(secret, "utf8").toString("base64");
    const uri = encodeURIComponent(secret);
    return [
        b64, b64.replace(/=+$/, ""), Buffer.from(secret, "utf8").toString("base64url"),
        uri,
        uri.replace(/%(2C|3A|2F|40|24|5B|5D)/gi, (m) => decodeURIComponent(m)).replace(/'/g, "%27"), // prepare.js query encoding
        new URLSearchParams([["", secret]]).toString().slice(1) // form encoding (+ for spaces)
    ].filter((form) => form.length >= 4 && form !== secret);
}

/**
 * Masks secrets in texts shown in results, history and reports: the values of secret variables (also when scripts
 * or captures change them: refresh()), credentials of the Auth tab and OAuth tokens (add()), and their base64 / URL
 * encoded forms. Header values are masked by name too: Authorization / Proxy-Authorization / Cookie / Set-Cookie,
 * the API key header (protectHeaders()) and names that look like credentials keep only their scheme / cookie names
 * ("Bearer •••••"); a Basic header whose base64 contains a secret is masked as well. Values seen once stay masked.
 */
function createMasker(scope) {
    const secrets = new Set();
    const protectedHeaders = new Set();
    let sorted = [];
    let encoded = [];
    const remember = (v) => {
        if (typeof v !== "string" || v.length < MIN_SECRET_CHARS || v === MASK || secrets.has(v)) return false;
        secrets.add(v);
        return true;
    };
    const rebuild = () => {
        const forms = new Set();
        for (const secret of secrets) for (const form of encodedForms(secret)) forms.add(form);
        sorted = [...secrets].sort((a, b) => b.length - a.length);
        encoded = [...forms].filter((f) => !secrets.has(f)).sort((a, b) => b.length - a.length);
    };
    function refresh() {
        let snapshot = [];
        try {
            snapshot = scope.snapshot();
        } catch {
            snapshot = [];
        }
        let added = false;
        for (const v of snapshot) if (v && v.secret && remember(v.value)) added = true;
        if (added) rebuild();
    }
    /** Adds secret values (texts shorter than 3 characters are ignored). */
    function add(...values) {
        let added = false;
        for (const v of values.flat()) if (remember(v)) added = true;
        if (added) rebuild();
    }
    /** Header names (any case) whose values are always masked, e.g. the API key header of the Auth tab. */
    function protectHeaders(names) {
        for (const n of Array.isArray(names) ? names : []) if (n) protectedHeaders.add(String(n).toLowerCase());
    }
    const replaceAll = (text, values) => {
        let out = text;
        for (const v of values) if (out.includes(v)) out = out.split(v).join(MASK);
        return out;
    };
    function text(value) {
        let out = String(value ?? "");
        try {
            out = scope.mask(out);
        } catch {
            // keep going with the values known here
        }
        if (!secrets.size) return out;
        return replaceAll(replaceAll(out, sorted), encoded);
    }
    function header(value, name) {
        const v = String(value ?? "");
        if (name !== undefined && isCredentialHeader(name, protectedHeaders)) return maskHeaderValue(name, v);
        const m = secrets.size ? BASE64_CREDENTIALS_RE.exec(v) : null;
        if (m) {
            const decoded = decodeBase64Text(m[2]);
            if (decoded !== null && text(decoded) !== decoded) return `${m[1]}${MASK}${m[3]}`;
        }
        return text(v);
    }
    function headers(list) {
        if (Array.isArray(list)) return list.map((pair) => (Array.isArray(pair) ? [pair[0], header(pair[1], pair[0])] : pair));
        if (list && typeof list === "object") {
            const out = {};
            for (const [k, v] of Object.entries(list)) out[k] = Array.isArray(v) ? v.map((x) => header(x, k)) : header(v, k);
            return out;
        }
        return list;
    }
    refresh();
    return { refresh, add, protectHeaders, text, header, headers, values: () => [...secrets] };
}

/**
 * Assertion results with secret values masked: label / expected / message hold resolved {{variables}}, and actual
 * is masked too, so a check against a secret does not show it in the Tests tab or a JUnit report (the response
 * itself is kept as received).
 */
function maskAssertions(list, masker) {
    return list.map((a) => ({ ...a, label: masker.text(a.label), expected: masker.text(a.expected), actual: masker.text(a.actual), message: masker.text(a.message) }));
}

// ------------------------------------------------------------------ result shaping

/** What was sent, for the result: credentials masked; files: the local files uploaded (absolute paths). */
function preparedForResult(prepared, masker) {
    if (!prepared) return null;
    return {
        method: prepared.method,
        url: masker.text(prepared.url),
        headers: masker.headers(prepared.headers || []),
        bodyText: masker.text(prepared.bodyText ?? ""),
        bodyMode: prepared.bodyMode,
        authInfo: masker.text(prepared.authInfo || ""),
        unresolved: Array.isArray(prepared.unresolved) ? prepared.unresolved : [],
        files: Array.isArray(prepared.files) ? prepared.files.map((f) => ({ kind: f.kind, field: f.field, path: f.path })) : []
    };
}

/**
 * The response content of a result with secrets masked (for suite runs: their results end up in reports): body text,
 * response headers (Set-Cookie and credential headers by name), cookie values. The parsed JSON is dropped when the
 * body text had to be masked.
 */
function maskResponseContent(response, masker) {
    if (!response || typeof response !== "object") return response;
    const out = { ...response };
    if (typeof out.bodyText === "string" && out.bodyText) {
        const masked = masker.text(out.bodyText);
        if (masked !== out.bodyText) {
            out.bodyText = masked;
            delete out.json;
        }
    }
    if (out.headers) out.headers = masker.headers(out.headers);
    if (out.headersMap) out.headersMap = masker.headers(out.headersMap);
    if (out.cookies) out.cookies = maskCookies(out.cookies);
    return out;
}

/**
 * HttpResponse without the body Buffer: text capped, small images as base64, secrets in the echoed request, URLs,
 * redirects, warnings and the error masked. maskContent: also the response body / headers / cookies (suite runs; a
 * single request keeps the real response for the response view).
 */
function responseForResult(response, masker, { maxBodyChars = MAX_BODY_CHARS, keepJson = true, maskContent = false } = {}) {
    if (!response) return null;
    const { body, ...rest } = response;
    const out = { ...rest };
    if (typeof out.bodyText === "string" && out.bodyText.length > maxBodyChars) {
        out.bodyText = out.bodyText.slice(0, maxBodyChars);
        out.bodyTextTruncated = true;
    }
    if (!keepJson || out.bodyTextTruncated) delete out.json;
    if (Buffer.isBuffer(body) && body.length > 0 && body.length <= MAX_IMAGE_BYTES && /^image\//i.test(String(out.contentType || ""))) {
        out.bodyBase64 = body.toString("base64");
    }
    if (typeof out.url === "string") out.url = masker.text(out.url);
    if (Array.isArray(out.redirects)) {
        out.redirects = out.redirects.map((r) => (r && typeof r === "object" ? { ...r, url: masker.text(r.url), location: r.location === undefined ? r.location : masker.text(r.location) } : r));
    }
    if (Array.isArray(out.warnings)) out.warnings = out.warnings.map((w) => masker.text(w));
    if (out.error && typeof out.error === "object") out.error = { ...out.error, message: masker.text(out.error.message) };
    if (out.request && typeof out.request === "object") {
        out.request = { ...out.request, url: masker.text(out.request.url), headers: masker.headers(out.request.headers) };
    }
    return maskContent ? maskResponseContent(out, masker) : out;
}

/** "TLS certificate verification was off" notes for a request sent over https. */
function tlsNotes(prepared) {
    const s = (prepared && prepared.settings) || {};
    if (!/^https:/i.test(String(prepared && prepared.url || ""))) return null;
    if (s.verifyTls === false) {
        return {
            disabled: true,
            log: {
                level: "warn",
                source: "runner",
                message: s.verifyTlsFrom === "request"
                    ? "TLS certificate verification was off for this request (\"Verify TLS\" is turned off in its Settings tab): the server's identity was not checked."
                    : "TLS certificate verification was off (Settings > Verify TLS): the server's identity was not checked."
            }
        };
    }
    if (s.tlsEnforced) {
        return {
            disabled: false,
            log: {
                level: "info",
                source: "runner",
                message: `"Verify TLS" is turned off ${s.verifyTlsFrom === "request" ? "in this request's Settings tab" : "in Settings"}, but TLS verification is enforced ` +
                    "(Settings > Enforce TLS verification): the certificate is checked anyway."
            }
        };
    }
    return null;
}

function scriptTests(scriptResult, phase) {
    return (scriptResult ? scriptResult.tests : []).map((t, i) => ({
        id: `script-${phase}-${i + 1}`,
        source: "script",
        operator: "test",
        phase,
        label: t.name,
        passed: !!t.passed,
        actual: "",
        expected: "",
        message: t.passed ? "" : t.error || "Failed",
        skipped: false
    }));
}

/** Script result for the RequestResult: secret values masked in tests, logs and the error. */
function maskedScriptResult(scriptResult, phase, masker) {
    return {
        tests: scriptResult.tests.map((t) => ({ name: masker.text(t.name), passed: t.passed, error: t.error == null ? null : masker.text(t.error) })),
        logs: scriptResult.logs.map((l) => ({ level: l.level, message: masker.text(l.message), source: phase })),
        error: scriptResult.error == null ? null : masker.text(scriptResult.error)
    };
}

// ------------------------------------------------------------------ one request

/**
 * Sends one request with everything around it (see the file comment).
 *  { suite, requestId, request (optional edited copy), globals, environmentId, runtime, data, settings,
 *    cookieJar, oauthCache, signal, iteration (default 1), baseDir (for relative file paths), maxBodyChars, keepJson,
 *    approveFile (see prepare.js: asked before a local file is uploaded; without it no file is read),
 *    maskResponse (true: secrets are masked in the response body / headers / cookies too, as in suite runs),
 *    history (false: no result.historyRequest) }
 * Captures / scripts that store "environment" or "global" variables change the given suite environment and
 * globals array in place (the caller persists them); result.variablesChanged tells whether that happened.
 * Secrets (secret variables, Auth tab credentials, OAuth tokens, credential headers) are masked in the result.
 * result.historyRequest: copy of the request for the history, credentials left out / masked.
 * A local file that is not approved: result.errorCode "FILE_NOT_APPROVED", result.fileApproval { filePath, realPath,
 * kind, field, host, suiteId, requestId }. result.tlsVerificationDisabled: TLS certificates were not verified.
 * Never rejects: problems are reported in result.error.
 */
async function executeRequest(options = {}) {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const suite = options.suite || EMPTY_SUITE;
    const globals = Array.isArray(options.globals) ? options.globals : [];
    const runtime = options.runtime && typeof options.runtime === "object" ? options.runtime : {};
    const settings = options.settings || {};
    const signal = options.signal || null;
    const iteration = Number.isInteger(options.iteration) ? options.iteration : 1;
    const found = options.requestId ? model.findItem(suite, options.requestId) : null;
    const saved = found && found.item && found.item.type === "request" ? found.item : null;
    const source = options.request || saved;
    const parents = found ? found.parents : [];
    const environment = findEnvironment(suite, options.environmentId);

    const result = {
        requestId: options.requestId || (source && source.id) || null,
        name: source ? source.name : "Request",
        method: source ? String(source.method || "GET").toUpperCase() : "GET",
        url: source ? String(source.url || "") : "",
        path: parents.map((p) => p.name),
        iteration,
        prepared: null,
        response: null,
        assertions: [],
        captures: [],
        scripts: { pre: null, post: null },
        logs: [],
        passed: false,
        error: null,
        startedAt,
        durationMs: 0,
        variablesChanged: { environment: false, globals: false }
    };
    const finish = () => {
        result.durationMs = Date.now() - t0;
        result.passed = !result.error && result.assertions.every((a) => a.skipped || a.passed);
        return result;
    };
    if (!source) {
        result.error = "Request not found. It may have been deleted.";
        return finish();
    }

    let scope;
    let request;
    try {
        request = JSON.parse(JSON.stringify(source));
        scope = createScope({ globals, suite, parents, environment, data: dataRow(options.data), runtime });
    } catch (err) {
        result.error = `Could not read the request: ${errorMessage(err)}`;
        return finish();
    }
    const envBefore = jsonText(environment ? environment.variables : null);
    const globalsBefore = jsonText(globals);
    const noteChanges = () => {
        result.variablesChanged = {
            environment: jsonText(environment ? environment.variables : null) !== envBefore,
            globals: jsonText(globals) !== globalsBefore
        };
    };
    const environmentName = environment ? environment.name : "";
    const masker = createMasker(scope);
    masker.add(authSecretValues(request, { suite, parents, scope }));
    // every check of this response (assertions, captures) shares one time budget for regex / JSONPath / schemas
    const budget = createTimeBudget();
    const finishWith = finish;
    const done = () => {
        if (options.maskResponse && result.response) result.response = maskResponseContent(result.response, masker);
        if (options.history !== false) {
            try {
                result.historyRequest = redactRequest(source, (text) => masker.text(text));
            } catch {
                result.historyRequest = null;
            }
        }
        Object.defineProperty(result, "secretValues", { value: masker.values(), enumerable: false, configurable: true });
        return finishWith();
    };
    const skipAll = (why) => {
        result.assertions.push(...maskAssertions(evaluateAssertions(request.assertions, { error: { code: "NOT_SENT", message: why } }, scope), masker));
    };
    const cancelled = () => {
        result.error = "Request cancelled";
        skipAll("cancelled");
        noteChanges();
        return done();
    };
    const captureResults = (response) => runExtractions(request.extract, response, scope, { budget }).map((c) => ({ ...c, message: masker.text(c.message) }));

    try {
        // 1. pre-request script
        if (request.scripts && String(request.scripts.pre || "").trim()) {
            const view = scriptRequestView(request, scope);
            const pre = await runScript(request.scripts.pre, { phase: "pre", scope, request: view, environmentName, signal });
            masker.refresh(); // the script may have changed secret values
            result.scripts.pre = maskedScriptResult(pre, "pre", masker);
            result.logs.push(...result.scripts.pre.logs);
            result.assertions.push(...scriptTests(result.scripts.pre, "pre"));
            if (signal && signal.aborted) return cancelled();
            if (pre.error) {
                result.error = masker.text(`Pre-request script: ${pre.error}`);
                result.logs.push({ level: "error", message: result.error, source: "pre" });
                skipAll("the pre-request script failed");
                noteChanges();
                return done();
            }
            applyScriptChanges(request, view, pre.request);
        }
        if (signal && signal.aborted) return cancelled();

        // 2. prepare
        let prepared;
        try {
            prepared = await prepareRequest(request, {
                suite, parents, scope, settings, oauthCache: options.oauthCache || null, signal, baseDir: options.baseDir || null,
                approveFile: typeof options.approveFile === "function" ? options.approveFile : null,
                suiteId: suite.id || null,
                requestId: result.requestId
            });
        } catch (err) {
            if (err && err.code === "FILE_NOT_APPROVED") {
                // not an error of the request: the user has to allow the file (the app asks and sends again)
                result.error = err.message;
                result.errorCode = "FILE_NOT_APPROVED";
                result.fileApproval = {
                    filePath: err.filePath, realPath: err.realPath, kind: err.kind, field: err.field,
                    host: err.host, suiteId: err.suiteId, requestId: err.requestId
                };
                result.logs.push({ level: "warn", message: result.error, source: "runner" });
                skipAll("a local file was not allowed");
                noteChanges();
                return done();
            }
            result.error = masker.text(`Could not build the request: ${errorMessage(err)}`);
            result.logs.push({ level: "error", message: result.error, source: "runner" });
            skipAll("the request could not be built");
            noteChanges();
            return done();
        }
        masker.add(prepared.secretValues || []);
        masker.protectHeaders(prepared.sensitiveHeaders);
        // tokens and keys typed into credential headers are masked wherever else they show up (echoed bodies)
        for (const [name, value] of prepared.headers || []) masker.add(credentialParts(name, value));
        result.method = prepared.method || result.method;
        result.url = masker.text(prepared.url || result.url);
        result.prepared = preparedForResult(prepared, masker);
        for (const name of result.prepared.unresolved) {
            result.logs.push({ level: "warn", message: `Variable {{${name}}} is not defined, it was sent as written`, source: "runner" });
        }
        const tls = tlsNotes(prepared);
        if (tls) {
            if (tls.disabled) result.tlsVerificationDisabled = true;
            result.logs.push(tls.log);
        }

        // 3. send
        let response;
        try {
            response = await sendRequest(prepared, { settings, cookieJar: options.cookieJar || null, signal, secretValues: masker.values() });
        } catch (err) {
            response = { status: 0, statusText: "", headers: [], headersMap: {}, cookies: [], bodyText: "", timings: { total: Date.now() - t0 }, error: { code: "ERROR", message: errorMessage(err) } };
        }
        // session cookies (Set-Cookie, and the cookie jar's Cookie header) are credentials as well
        for (const [name, value] of (response.request && response.request.headers) || []) masker.add(credentialParts(name, value));
        for (const c of Array.isArray(response.cookies) ? response.cookies : []) masker.add(credentialParts("cookie", `${c && c.name}=${c && c.value}`));
        result.response = responseForResult(response, masker, { maxBodyChars: options.maxBodyChars || MAX_BODY_CHARS, keepJson: options.keepJson !== false });
        if (response.error) {
            result.error = masker.text(response.error.message || response.error.code || "Request failed");
            result.logs.push({ level: "error", message: result.error, source: "runner" });
            for (const w of Array.isArray(response.warnings) ? response.warnings : []) result.logs.push({ level: "warn", message: masker.text(w), source: "runner" });
            skipAll(result.error);
            result.captures = captureResults(response);
            noteChanges();
            return done();
        }
        for (const w of Array.isArray(response.warnings) ? response.warnings : []) result.logs.push({ level: "warn", message: masker.text(w), source: "runner" });

        // 4. post-response script
        if (request.scripts && String(request.scripts.post || "").trim()) {
            // what was sent (unmasked: the script may need it, e.g. to check a signature; its logs are masked)
            const sentView = { method: prepared.method, url: prepared.url, headers: prepared.headers || [], body: prepared.bodyText ?? "" };
            const post = await runScript(request.scripts.post, { phase: "post", scope, request: sentView, response, environmentName, signal });
            masker.refresh();
            result.scripts.post = maskedScriptResult(post, "post", masker);
            result.logs.push(...result.scripts.post.logs);
            if (post.error) {
                result.error = signal && signal.aborted ? "Request cancelled" : masker.text(`Post-response script: ${post.error}`);
                result.logs.push({ level: "error", message: result.error, source: "post" });
            }
        }

        // 5. assertions (script tests first, then the table rows); expected values / labels hold resolved variables
        result.assertions.push(...scriptTests(result.scripts.post, "post"), ...maskAssertions(evaluateAssertions(request.assertions, response, scope, { budget }), masker));

        // 6. captures
        result.captures = captureResults(response);
        masker.refresh();
        for (const c of result.captures) {
            if (!c.ok) result.logs.push({ level: "warn", message: `Capture {{${c.variable || "?"}}}: ${c.message}`, source: "capture" });
        }
    } catch (err) {
        // safety net: a bug must not turn into an unhandled rejection
        result.error = masker.text(`Unexpected error: ${errorMessage(err)}`);
    }
    noteChanges();
    return done();
}

// ------------------------------------------------------------------ a run

function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal && signal.aborted) return resolve();
        const done = () => {
            clearTimeout(timer);
            if (signal) signal.removeEventListener("abort", done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        if (signal) signal.addEventListener("abort", done, { once: true });
    });
}

function toInt(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

/** Counts for a list of RequestResults (passed / failed / errors are disjoint: they add up to requests). */
function computeStats(results) {
    const stats = { requests: results.length, passed: 0, failed: 0, errors: 0, assertions: 0, assertionsPassed: 0, assertionsFailed: 0, avgResponseMs: 0 };
    let timeSum = 0;
    let timeCount = 0;
    for (const r of results) {
        if (r.error) stats.errors++;
        else if (r.passed) stats.passed++;
        else stats.failed++;
        for (const a of r.assertions || []) {
            if (a.skipped) continue;
            stats.assertions++;
            if (a.passed) stats.assertionsPassed++;
            else stats.assertionsFailed++;
        }
        const total = r.response && r.response.status > 0 && r.response.timings ? r.response.timings.total : null;
        if (typeof total === "number") {
            timeSum += total;
            timeCount++;
        }
    }
    stats.avgResponseMs = timeCount ? Math.round(timeSum / timeCount) : 0;
    return stats;
}

/**
 * After a run: masks in every result the secrets that any request of the run used (a token returned in the body of
 * the login request is masked there once a later request sent it in its Authorization header). In place.
 */
function maskRunResults(results, secretValues) {
    if (!secretValues.size) return;
    const masker = createMasker({ mask: (t) => t, snapshot: () => [] });
    masker.add([...secretValues]);
    for (const r of results) {
        if (!r || typeof r !== "object") continue;
        r.url = masker.text(r.url);
        if (r.error) r.error = masker.text(r.error);
        if (r.prepared) r.prepared = { ...r.prepared, url: masker.text(r.prepared.url), headers: masker.headers(r.prepared.headers || []), bodyText: masker.text(r.prepared.bodyText) };
        if (r.response) r.response = responseForResult(r.response, masker, { maxBodyChars: Infinity, maskContent: true });
        r.assertions = maskAssertions(r.assertions || [], masker);
        r.logs = (r.logs || []).map((l) => (l && typeof l === "object" ? { ...l, message: masker.text(l.message) } : l));
        r.captures = (r.captures || []).map((c) => (c && typeof c === "object" ? { ...c, value: masker.text(c.value), message: masker.text(c.message) } : c));
        if (r.scripts) {
            for (const phase of ["pre", "post"]) {
                const sr = r.scripts[phase];
                if (sr) r.scripts[phase] = maskedScriptResult({ tests: sr.tests || [], logs: sr.logs || [], error: sr.error }, phase, masker);
            }
        }
    }
}

/**
 * Runs the requests below itemIds (all when empty) `iterations` times (at least once per data row).
 * Data rows: iteration n uses row n (rows repeat from the top when there are more iterations than rows).
 * onEvent(event): { type: "run-start", total, iterations, requests } | { type: "request-start", index, iteration,
 * requestId, name } | { type: "request-done", index, iteration, result } | { type: "run-done", result }.
 * index counts from 0 over the whole run, iteration from 1. Resolves with a RunResult; never rejects for
 * request problems (they are in the results).
 * approveFile: see prepare.js (local file uploads). Results of a run end up in reports, so secrets are masked in the
 * response bodies, headers and cookies too (maskResponses: false keeps them as received).
 */
async function runSuite(options = {}) {
    const suite = options.suite;
    if (!suite || !Array.isArray(suite.items)) throw new Error("No suite to run");
    const signal = options.signal || null;
    const emit = (event) => {
        if (typeof options.onEvent !== "function") return;
        try {
            options.onEvent(event);
        } catch {
            // a broken listener must not stop the run
        }
    };
    const globals = Array.isArray(options.globals) ? options.globals : [];
    const rows = Array.isArray(options.data) && options.data.length ? options.data : null;
    const iterations = Math.max(toInt(options.iterations, 1) || 1, rows ? rows.length : 0);
    const delayMs = toInt(options.delayMs, 0);
    const environment = findEnvironment(suite, options.environmentId);
    const list = model.collectRequests(suite, Array.isArray(options.itemIds) ? options.itemIds : []);
    const runtime = options.runtime && typeof options.runtime === "object" ? options.runtime : {};
    const cookieJar = options.cookieJar !== undefined ? options.cookieJar : createCookieJar();
    const oauthCache = options.oauthCache || createOAuthCache();
    const total = list.length * iterations;
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const results = [];
    const runSecrets = new Set();
    let stopped = false;
    let stopReason = null;
    let error = null;

    emit({ type: "run-start", total, iterations, requests: list.length });
    let index = 0;
    try {
        run: for (let iteration = 1; iteration <= iterations; iteration++) {
            const row = rows ? rows[(iteration - 1) % rows.length] : null;
            for (const { request } of list) {
                if (signal && signal.aborted) {
                    stopped = true;
                    stopReason = "cancelled";
                    break run;
                }
                if (index > 0 && delayMs > 0) {
                    await sleep(delayMs, signal);
                    if (signal && signal.aborted) {
                        stopped = true;
                        stopReason = "cancelled";
                        break run;
                    }
                }
                emit({ type: "request-start", index, iteration, requestId: request.id, name: request.name });
                const result = await executeRequest({
                    suite,
                    requestId: request.id,
                    globals,
                    environmentId: environment ? environment.id : null,
                    runtime,
                    data: row,
                    settings: options.settings,
                    cookieJar,
                    oauthCache,
                    signal,
                    iteration,
                    baseDir: options.baseDir || null,
                    approveFile: options.approveFile,
                    maskResponse: options.maskResponses !== false,
                    history: false,
                    maxBodyChars: RUN_BODY_CHARS,
                    keepJson: false
                });
                for (const v of result.secretValues || []) runSecrets.add(v);
                results.push(result);
                emit({ type: "request-done", index, iteration, result });
                index++;
                if (signal && signal.aborted) {
                    stopped = true;
                    stopReason = "cancelled";
                    break run;
                }
                if (options.stopOnFailure && !result.passed) {
                    stopped = index < total;
                    stopReason = stopped ? "failure" : null;
                    break run;
                }
            }
        }
    } catch (err) {
        stopped = true;
        stopReason = "error";
        error = `The run stopped unexpectedly: ${errorMessage(err)}`;
    }

    if (options.maskResponses !== false) maskRunResults(results, runSecrets);
    const finishedAt = new Date().toISOString();
    const runResult = {
        id: model.newId("run"),
        suiteId: suite.id || null,
        suiteName: suite.name || "",
        environmentId: environment ? environment.id : null,
        environmentName: environment ? environment.name : "",
        startedAt,
        finishedAt,
        durationMs: Date.now() - t0,
        iterations,
        total,
        stats: computeStats(results),
        results,
        stopped,
        stopReason,
        error
    };
    emit({ type: "run-done", result: runResult });
    return runResult;
}

module.exports = { executeRequest, runSuite, computeStats, createMasker };
