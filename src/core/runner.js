"use strict";
// Runs requests: one request (the Send button) or a whole suite / folder selection (the runner and the CLI).
//
// One request: build the variable scope -> pre-request script (may set variables or change the request)
// -> prepare (resolve variables, auth, body) -> send -> post-response script -> assertions (+ script tests)
// -> captures. A run: the selected requests in tree order, once per iteration, sharing one runtime variable
// object, one cookie jar and one OAuth2 token cache, so captured values chain requests across the run.
const model = require("./model");
const { createScope } = require("./variables");
const { prepareRequest } = require("./prepare");
const { sendRequest } = require("./http");
const { createOAuthCache } = require("./auth");
const { createCookieJar } = require("./cookies");
const { evaluateAssertions } = require("./assertions");
const { runExtractions } = require("./extract");
const { runScript } = require("./scripts");

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

const MASK = "•••••";
const MIN_SECRET_CHARS = 3; // same rule as scope.mask(): shorter values are not masked
// a header value that may carry base64 credentials: "Basic dXNlcjpwYXNz", "<scheme> <base64>" or only base64
const BASE64_CREDENTIALS_RE = /^(\s*(?:[A-Za-z][\w.-]*\s+)?)([A-Za-z0-9+/_-]{4,}={0,2})(\s*)$/;

/** base64 text -> decoded UTF-8 text, or null when it is not base64 of readable text. */
function decodeBase64Text(token) {
    const clean = token.replace(/=+$/, "");
    if (clean.length % 4 === 1) return null;
    try {
        const text = Buffer.from(clean, "base64").toString("utf8");
        return text && !text.includes("�") ? text : null;
    } catch {
        return null;
    }
}

/**
 * Masks the values of secret variables in texts shown in results and reports. Beyond scope.mask() (the literal
 * value) it masks base64 forms of the secret, and header values whose base64 credentials contain a secret
 * (Basic auth: base64 of user:password). refresh() adds the current secret values (scripts and captures can change
 * them while the request runs); values seen before stay masked.
 */
function createMasker(scope) {
    const secrets = new Set();
    let encoded = [];
    function refresh() {
        let snapshot = [];
        try {
            snapshot = scope.snapshot();
        } catch {
            snapshot = [];
        }
        let added = false;
        for (const v of snapshot) {
            if (v && v.secret && typeof v.value === "string" && v.value.length >= MIN_SECRET_CHARS && !secrets.has(v.value)) {
                secrets.add(v.value);
                added = true;
            }
        }
        if (!added) return;
        const forms = new Set();
        for (const s of secrets) {
            const b64 = Buffer.from(s, "utf8").toString("base64");
            for (const form of [b64, b64.replace(/=+$/, ""), Buffer.from(s, "utf8").toString("base64url")]) if (form.length >= 4) forms.add(form);
        }
        encoded = [...forms].sort((a, b) => b.length - a.length);
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
        return replaceAll(replaceAll(out, [...secrets].sort((a, b) => b.length - a.length)), encoded);
    }
    function header(value) {
        const v = String(value ?? "");
        const m = secrets.size ? BASE64_CREDENTIALS_RE.exec(v) : null;
        if (m) {
            const decoded = decodeBase64Text(m[2]);
            if (decoded !== null && text(decoded) !== decoded) return `${m[1]}${MASK}${m[3]}`;
        }
        return text(v);
    }
    function headers(list) {
        if (Array.isArray(list)) return list.map((pair) => (Array.isArray(pair) ? [pair[0], header(pair[1])] : pair));
        if (list && typeof list === "object") {
            const out = {};
            for (const [k, v] of Object.entries(list)) out[k] = Array.isArray(v) ? v.map(header) : header(v);
            return out;
        }
        return list;
    }
    refresh();
    return { refresh, text, header, headers };
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

function preparedForResult(prepared, masker) {
    if (!prepared) return null;
    return {
        method: prepared.method,
        url: masker.text(prepared.url),
        headers: masker.headers(prepared.headers || []),
        bodyText: masker.text(prepared.bodyText ?? ""),
        bodyMode: prepared.bodyMode,
        authInfo: masker.text(prepared.authInfo || ""),
        unresolved: Array.isArray(prepared.unresolved) ? prepared.unresolved : []
    };
}

/** HttpResponse without the body Buffer: text capped, small images as base64, secrets in the echoed request masked. */
function responseForResult(response, masker, { maxBodyChars = MAX_BODY_CHARS, keepJson = true } = {}) {
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
    if (Array.isArray(out.redirects)) out.redirects = out.redirects.map((r) => (r && typeof r === "object" ? { ...r, url: masker.text(r.url) } : r));
    if (out.request && typeof out.request === "object") {
        out.request = { ...out.request, url: masker.text(out.request.url), headers: masker.headers(out.request.headers) };
    }
    return out;
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
 *    cookieJar, oauthCache, signal, iteration (default 1), baseDir (for relative file paths), maxBodyChars, keepJson }
 * Captures / scripts that store "environment" or "global" variables change the given suite environment and
 * globals array in place (the caller persists them); result.variablesChanged tells whether that happened.
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
    const skipAll = (why) => {
        result.assertions.push(...maskAssertions(evaluateAssertions(request.assertions, { error: { code: "NOT_SENT", message: why } }, scope), masker));
    };
    const cancelled = () => {
        result.error = "Request cancelled";
        skipAll("cancelled");
        noteChanges();
        return finish();
    };
    const captureResults = (response) => runExtractions(request.extract, response, scope).map((c) => ({ ...c, message: masker.text(c.message) }));

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
                return finish();
            }
            applyScriptChanges(request, view, pre.request);
        }
        if (signal && signal.aborted) return cancelled();

        // 2. prepare
        let prepared;
        try {
            prepared = await prepareRequest(request, { suite, parents, scope, settings, oauthCache: options.oauthCache || null, signal, baseDir: options.baseDir || null });
        } catch (err) {
            result.error = masker.text(`Could not build the request: ${errorMessage(err)}`);
            result.logs.push({ level: "error", message: result.error, source: "runner" });
            skipAll("the request could not be built");
            noteChanges();
            return finish();
        }
        result.method = prepared.method || result.method;
        result.url = masker.text(prepared.url || result.url);
        result.prepared = preparedForResult(prepared, masker);
        for (const name of result.prepared.unresolved) {
            result.logs.push({ level: "warn", message: `Variable {{${name}}} is not defined, it was sent as written`, source: "runner" });
        }

        // 3. send
        let response;
        try {
            response = await sendRequest(prepared, { settings, cookieJar: options.cookieJar || null, signal });
        } catch (err) {
            response = { status: 0, statusText: "", headers: [], headersMap: {}, cookies: [], bodyText: "", timings: { total: Date.now() - t0 }, error: { code: "ERROR", message: errorMessage(err) } };
        }
        result.response = responseForResult(response, masker, { maxBodyChars: options.maxBodyChars || MAX_BODY_CHARS, keepJson: options.keepJson !== false });
        if (response.error) {
            result.error = masker.text(response.error.message || response.error.code || "Request failed");
            result.logs.push({ level: "error", message: result.error, source: "runner" });
            for (const w of Array.isArray(response.warnings) ? response.warnings : []) result.logs.push({ level: "warn", message: masker.text(w), source: "runner" });
            skipAll(result.error);
            result.captures = captureResults(response);
            noteChanges();
            return finish();
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
        result.assertions.push(...scriptTests(result.scripts.post, "post"), ...maskAssertions(evaluateAssertions(request.assertions, response, scope), masker));

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
    return finish();
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
 * Runs the requests below itemIds (all when empty) `iterations` times (at least once per data row).
 * Data rows: iteration n uses row n (rows repeat from the top when there are more iterations than rows).
 * onEvent(event): { type: "run-start", total, iterations, requests } | { type: "request-start", index, iteration,
 * requestId, name } | { type: "request-done", index, iteration, result } | { type: "run-done", result }.
 * index counts from 0 over the whole run, iteration from 1. Resolves with a RunResult; never rejects for
 * request problems (they are in the results).
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
                    maxBodyChars: RUN_BODY_CHARS,
                    keepJson: false
                });
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

module.exports = { executeRequest, runSuite, computeStats };
