"use strict";
// Optional JavaScript for power users: pre-request and post-response scripts.
//
// Each script runs in a worker thread (node:worker_threads) with a heap limit, inside a separate V8 context
// (node:vm) with a 5 s time limit and no Node access (no require, process, fs, timers). An endless loop is
// stopped by the time limit; a script that fills memory ends only its worker, never the app or the CLI run.
// vm is not a full security boundary by itself, so the context is hardened:
//  - the context global has a null prototype and code generation from strings (eval, new Function) is disabled;
//  - no outer-realm object or function is ever reachable from the script: the API is built inside the context,
//    and the only link out is a bridge function hidden in a closure that exchanges JSON text with the main
//    thread (where the variable scope lives);
//  - dynamic import() cannot run (its error objects would come from the outer realm): every "import" in the
//    source is written as "import" before compiling. In strings, comments, regexes and templates that is the
//    same text; as a keyword it is a syntax error, so import() is refused wherever it is written;
//  - Error.prepareStackTrace is locked so call-site objects of outer frames cannot be inspected;
//  - all values thrown or returned by the script are turned into text inside the context, under the time limit.
// Scripts are synchronous: promises and async test functions settle within the same run, nothing waits on timers.
// runScript() returns a Promise; the main thread stays free while the worker runs.
const { Worker, MessageChannel } = require("worker_threads");

const SCRIPT_TIMEOUT_MS = 5000;
const SCRIPT_MEMORY_MB = 256; // heap limit of a script worker
const MAX_SCRIPT_MEMORY_MB = 1024; // scripts that receive a very large response get a larger limit, up to this
const LARGE_INPUT_CHARS = 16 * 1024 * 1024;
const WATCHDOG_EXTRA_MS = 4000; // the worker is ended when it has not answered this long after the time limit
const MAX_IDLE_WORKERS = 2;
const MAX_JOBS_PER_WORKER = 200; // replace workers now and then so memory use stays flat
const IDLE_WORKER_MS = 60 * 1000;
const SCOPES = ["runtime", "environment", "global"];

// Built inside the script context. Receives the hidden bridge, the input JSON text and the compiled user function.
const BOOTSTRAP = String.raw`(function (bridge, inputJson, userFn) {
    "use strict";
    const g = globalThis;
    const stringify = JSON.stringify;
    const parse = JSON.parse;
    const freeze = Object.freeze;
    const defineProperty = Object.defineProperty;
    const keys = Object.keys;
    const hasOwn = Object.prototype.hasOwnProperty;
    const isArray = Array.isArray;
    const ErrorCtor = Error;
    const StringCtor = String;
    const NumberCtor = Number;
    const RegExpCtor = RegExp;
    const ObjectIs = Object.is;
    const MAX_LOGS = 500;
    const MAX_LOG_CHARS = 5000;
    const MAX_TESTS = 1000;

    defineProperty(ErrorCtor, "prepareStackTrace", { value: undefined, writable: false, configurable: false });

    const input = parse(inputJson);
    const tests = [];
    const logs = [];
    let droppedLogs = 0;
    let scriptError = null;

    // JSON text of data built by this bootstrap; ignores toJSON / prototype changes made by the script.
    function toJsonText(v) {
        if (v === null || v === undefined) return "null";
        if (typeof v === "string") return stringify(v);
        if (typeof v === "number") return NumberCtor.isFinite(v) ? StringCtor(v) : "null";
        if (typeof v === "boolean") return v ? "true" : "false";
        let out = "";
        if (isArray(v)) {
            for (let i = 0; i < v.length; i++) out += (i ? "," : "") + toJsonText(v[i]);
            return "[" + out + "]";
        }
        const ks = keys(v);
        for (let i = 0; i < ks.length; i++) out += (i ? "," : "") + stringify(StringCtor(ks[i])) + ":" + toJsonText(v[ks[i]]);
        return "{" + out + "}";
    }

    function call(op, args) {
        let out;
        try {
            out = bridge(op, toJsonText(args));
        } catch (e) {
            // never hand a host error object to the script
            throw new ErrorCtor("Internal error while talking to API Tester");
        }
        const res = parse(typeof out === "string" ? out : "{}");
        if (res.error) throw new ErrorCtor(res.error);
        return res.value;
    }

    function show(v) {
        if (typeof v === "string") return stringify(v);
        if (v === undefined) return "undefined";
        if (typeof v === "function") return "[function]";
        if (typeof v === "bigint") return StringCtor(v) + "n";
        if (typeof v === "symbol") return v.toString();
        if (v instanceof ErrorCtor) return v.name + ": " + v.message;
        if (v instanceof RegExpCtor) return StringCtor(v);
        try {
            const seen = new WeakSet();
            const s = stringify(v, (k, x) => {
                if (x && typeof x === "object") {
                    if (seen.has(x)) return "[Circular]";
                    seen.add(x);
                }
                return x;
            });
            return s === undefined ? StringCtor(v) : s;
        } catch (e) {
            try { return StringCtor(v); } catch (e2) { return "[value]"; }
        }
    }

    function logText(v) {
        return typeof v === "string" ? v : show(v);
    }

    function errText(e) {
        try {
            if (e instanceof ErrorCtor) {
                const name = StringCtor(e.name || "Error");
                const message = StringCtor(e.message);
                return name === "Error" || name === "AssertionError" ? message : name + ": " + message;
            }
            return "Thrown: " + show(e);
        } catch (e2) {
            return "The script threw a value that cannot be shown";
        }
    }

    function errLine(e) {
        try {
            const stack = e instanceof ErrorCtor ? StringCtor(e.stack || "") : "";
            const m = /script:(\d+)(?::(\d+))?/.exec(stack);
            return m ? " (line " + m[1] + ")" : "";
        } catch (e2) {
            return "";
        }
    }

    // ---------------------------------------------------------------- variables
    function varText(v) {
        if (v === undefined || v === null) return "";
        if (typeof v === "string") return v;
        if (typeof v === "object") return stringify(v);
        return StringCtor(v);
    }

    const vars = freeze({
        get(name) { const v = call("get", [StringCtor(name)]); return v === null ? undefined : v; },
        set(name, value, scope) { call("set", [StringCtor(name), varText(value), scope === undefined || scope === null ? "runtime" : StringCtor(scope)]); },
        has(name) { return call("has", [StringCtor(name)]) === true; },
        unset(name) { call("unset", [StringCtor(name)]); },
        resolve(text) { return call("resolve", [StringCtor(text)]); }
    });
    const env = freeze({
        name: input.environmentName,
        get: vars.get,
        set(name, value) { vars.set(name, value, "environment"); }
    });

    // ---------------------------------------------------------------- console
    function makeLog(level) {
        return function () {
            if (logs.length >= MAX_LOGS) { droppedLogs++; return; }
            let message = "";
            for (let i = 0; i < arguments.length; i++) message += (i ? " " : "") + logText(arguments[i]);
            if (message.length > MAX_LOG_CHARS) message = message.slice(0, MAX_LOG_CHARS) + "… (cut)";
            logs.push({ level: level, message: message });
        };
    }
    const consoleApi = freeze({ log: makeLog("log"), info: makeLog("info"), warn: makeLog("warn"), error: makeLog("error"), debug: makeLog("debug") });

    // ---------------------------------------------------------------- expect
    class AssertionError extends ErrorCtor {
        constructor(message) { super(message); this.name = "AssertionError"; }
    }

    function deepEqual(a, b) {
        if (ObjectIs(a, b)) return true;
        if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
        if (isArray(a) !== isArray(b)) return false;
        if (isArray(a)) {
            if (a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
            return true;
        }
        const ka = keys(a);
        const kb = keys(b);
        if (ka.length !== kb.length) return false;
        for (const k of ka) if (!hasOwn.call(b, k) || !deepEqual(a[k], b[k])) return false;
        return true;
    }

    function toNum(v, what) {
        const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? NumberCtor(v) : NaN;
        if (NumberCtor.isNaN(n)) throw new AssertionError("Expected " + what + " to be a number, got " + show(v));
        return n;
    }

    function pathParts(path) {
        if (isArray(path)) return path.map(StringCtor);
        return StringCtor(path).replace(/\[(?:'([^']*)'|"([^"]*)"|([^\]]*))\]/g, (m, a, b, c) => "." + (a !== undefined ? a : b !== undefined ? b : c))
            .split(".").filter((p) => p !== "");
    }

    function expect(actual) {
        function matchers(negate) {
            function assert(pass, text, negText) {
                if (negate ? pass : !pass) throw new AssertionError(negate ? negText : text);
            }
            const a = () => show(actual);
            return {
                toBe(exp) { assert(ObjectIs(actual, exp), "Expected " + a() + " to be " + show(exp), "Expected " + a() + " not to be " + show(exp)); },
                toEqual(exp) { assert(deepEqual(actual, exp), "Expected " + a() + " to equal " + show(exp), "Expected " + a() + " not to equal " + show(exp)); },
                toContain(item) {
                    let pass;
                    if (typeof actual === "string") pass = actual.includes(StringCtor(item));
                    else if (isArray(actual)) pass = actual.some((x) => deepEqual(x, item));
                    else throw new AssertionError("toContain() needs a text or a list, got " + a());
                    assert(pass, "Expected " + a() + " to contain " + show(item), "Expected " + a() + " not to contain " + show(item));
                },
                toBeGreaterThan(n) { assert(toNum(actual, "value") > toNum(n, "limit"), "Expected " + a() + " to be greater than " + show(n), "Expected " + a() + " not to be greater than " + show(n)); },
                toBeGreaterThanOrEqual(n) { assert(toNum(actual, "value") >= toNum(n, "limit"), "Expected " + a() + " to be at least " + show(n), "Expected " + a() + " to be less than " + show(n)); },
                toBeLessThan(n) { assert(toNum(actual, "value") < toNum(n, "limit"), "Expected " + a() + " to be less than " + show(n), "Expected " + a() + " not to be less than " + show(n)); },
                toBeLessThanOrEqual(n) { assert(toNum(actual, "value") <= toNum(n, "limit"), "Expected " + a() + " to be at most " + show(n), "Expected " + a() + " to be more than " + show(n)); },
                toMatch(pattern) {
                    const re = pattern instanceof RegExpCtor ? new RegExpCtor(pattern.source, pattern.flags.replace(/[gy]/g, "")) : new RegExpCtor(StringCtor(pattern));
                    const pass = typeof actual === "string" && re.test(actual);
                    assert(pass, "Expected " + a() + " to match " + StringCtor(re), "Expected " + a() + " not to match " + StringCtor(re));
                },
                toBeTruthy() { assert(!!actual, "Expected " + a() + " to be truthy", "Expected " + a() + " not to be truthy"); },
                toBeFalsy() { assert(!actual, "Expected " + a() + " to be falsy", "Expected " + a() + " not to be falsy"); },
                toBeDefined() { assert(actual !== undefined, "Expected value to be defined", "Expected " + a() + " to be undefined"); },
                toBeUndefined() { assert(actual === undefined, "Expected " + a() + " to be undefined", "Expected value to be defined"); },
                toBeNull() { assert(actual === null, "Expected " + a() + " to be null", "Expected value not to be null"); },
                toHaveProperty(path, value) {
                    const parts = pathParts(path);
                    let cur = actual;
                    let found = parts.length > 0;
                    for (const p of parts) {
                        if (cur !== null && cur !== undefined && (typeof cur === "object" || typeof cur === "function") && hasOwn.call(cur, p)) cur = cur[p];
                        else if (typeof cur === "string" && p === "length") cur = cur.length;
                        else { found = false; break; }
                    }
                    const p = StringCtor(isArray(path) ? path.join(".") : path);
                    if (arguments.length > 1) {
                        const pass = found && deepEqual(cur, value);
                        assert(pass, found ? "Expected property \"" + p + "\" to be " + show(value) + ", got " + show(cur) : "Expected property \"" + p + "\" to exist",
                            "Expected property \"" + p + "\" not to be " + show(value));
                    } else {
                        assert(found, "Expected " + a() + " to have property \"" + p + "\"", "Expected " + a() + " not to have property \"" + p + "\"");
                    }
                },
                toHaveLength(n) {
                    const len = actual !== null && actual !== undefined && typeof actual.length === "number" ? actual.length : undefined;
                    const want = toNum(n, "length");
                    assert(len === want, "Expected length " + want + ", got " + (len === undefined ? "no length (" + a() + ")" : len), "Expected length not to be " + want);
                }
            };
        }
        const api = matchers(false);
        api.not = freeze(matchers(true));
        return freeze(api);
    }

    // ---------------------------------------------------------------- test()
    function test(name, fn) {
        if (tests.length >= MAX_TESTS) return;
        const entry = { name: StringCtor(name === undefined ? "Test " + (tests.length + 1) : name).slice(0, 300), passed: false, error: null, pending: false };
        tests.push(entry);
        if (typeof fn !== "function") { entry.error = "test() needs a function as second argument"; return; }
        try {
            const r = fn();
            if (r !== null && (typeof r === "object" || typeof r === "function") && typeof r.then === "function") {
                entry.pending = true;
                r.then(() => { entry.pending = false; entry.passed = true; }, (e) => { entry.pending = false; entry.error = errText(e) + errLine(e); });
            } else {
                entry.passed = true;
            }
        } catch (e) {
            entry.error = errText(e) + errLine(e);
        }
    }

    // ---------------------------------------------------------------- request / response
    function freezeDeep(o) {
        if (o && typeof o === "object") { for (const k of keys(o)) freezeDeep(o[k]); freeze(o); }
        return o;
    }
    const request = input.request || { method: "GET", url: "", headers: {}, body: "" };
    if (input.phase !== "pre") freezeDeep(request);
    let response;
    if (input.response) {
        const r = input.response;
        let parsed;
        let parsedOk = false;
        const headers = freeze(r.headers || {});
        response = freeze({
            status: r.status,
            statusText: r.statusText,
            headers: headers,
            body: r.body,
            time: r.time,
            size: r.size,
            url: r.url,
            cookies: freezeDeep(r.cookies || []),
            json() {
                if (!parsedOk) {
                    try { parsed = parse(r.body); } catch (e) { throw new ErrorCtor("Response body is not valid JSON"); }
                    parsedOk = true;
                }
                return parsed;
            },
            text() { return r.body; },
            header(name) { const v = headers[StringCtor(name).toLowerCase()]; return v === undefined ? undefined : v; }
        });
    }

    function defineGlobal(name, value) {
        defineProperty(g, name, { value: value, writable: false, enumerable: false, configurable: false });
    }
    defineGlobal("vars", vars);
    defineGlobal("env", env);
    defineGlobal("request", request);
    if (response) defineGlobal("response", response);
    defineGlobal("test", test);
    defineGlobal("expect", expect);
    defineGlobal("console", consoleApi);

    function snapshotRequest() {
        const r = request;
        const headers = {};
        const h = r.headers && typeof r.headers === "object" ? r.headers : {};
        for (const k of keys(h)) {
            if (h[k] === undefined || h[k] === null) continue;
            headers[StringCtor(k)] = StringCtor(h[k]);
        }
        const body = r.body === undefined || r.body === null ? "" : typeof r.body === "object" ? stringify(r.body) : StringCtor(r.body);
        return { method: StringCtor(r.method || "GET").toUpperCase(), url: StringCtor(r.url === undefined || r.url === null ? "" : r.url), headers: headers, body: body };
    }

    // Hidden entry points for the host (called via short scripts that run under the time limit).
    defineGlobal("__apiTesterHost", freeze({
        run() {
            try {
                userFn.call(undefined);
            } catch (e) {
                scriptError = errText(e) + errLine(e);
            }
        },
        collect() {
            let req = null;
            let reqError = null;
            if (input.phase === "pre") {
                try { req = snapshotRequest(); } catch (e) { reqError = "Could not read the changed request: " + errText(e); }
            }
            const done = [];
            for (const t of tests) {
                done.push({
                    name: t.name,
                    passed: t.passed && !t.pending,
                    error: t.pending ? "Test did not finish (scripts are synchronous: nothing waits for timers or network)" : t.error
                });
            }
            if (droppedLogs) logs.push({ level: "warn", message: droppedLogs + " more log lines were dropped" });
            return toJsonText({ tests: done, logs: logs, error: scriptError || reqError, request: req });
        }
    }));
})`;

// ------------------------------------------------------------------ worker thread

// Runs inside the worker thread. It is passed to the Worker as source text (eval: true), so no separate file has
// to be found at runtime (also inside the packaged app's asar archive).
function scriptWorkerMain(bootstrapSource) {
    "use strict";
    const vm = require("vm");
    const { parentPort, workerData, receiveMessageOnPort } = require("worker_threads");
    const callPort = workerData.callPort;
    const flag = new Int32Array(workerData.flag);
    const CALL_WAIT_MS = 30000;

    // A script can leave a rejected promise nobody handles (e.g. `Promise.reject(1)`); it must not end the worker.
    process.on("unhandledRejection", () => {});

    // Synchronous call to the main thread (vars.get / set / resolve): post the request, sleep until the main
    // thread has posted the answer and raised the flag, then take the answer from the port.
    function bridge(op, argsJson) {
        Atomics.store(flag, 0, 0);
        callPort.postMessage({ op: String(op), args: String(argsJson) });
        const state = Atomics.wait(flag, 0, 0, CALL_WAIT_MS);
        const reply = receiveMessageOnPort(callPort);
        if (!reply) return JSON.stringify({ error: state === "timed-out" ? "API Tester did not answer in time" : "No answer from API Tester" });
        return String(reply.message);
    }

    function isTimeout(err) {
        return !!err && typeof err === "object" && err.code === "ERR_SCRIPT_EXECUTION_TIMEOUT";
    }

    function lineOf(err, filename) {
        const stack = err && typeof err.stack === "string" ? err.stack : "";
        const m = new RegExp(`${filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)`).exec(stack);
        return m ? ` (line ${m[1]})` : "";
    }

    function runJob(job) {
        const out = { error: null, timedOut: false, collected: null };
        const filename = job.filename;
        let context;
        try {
            context = vm.createContext(Object.create(null), {
                name: `API Tester ${filename}`,
                codeGeneration: { strings: false, wasm: false },
                microtaskMode: "afterEvaluate"
            });
        } catch (err) {
            out.error = `Could not start the script engine: ${err.message}`;
            return out;
        }

        let userFn;
        try {
            userFn = vm.compileFunction(job.source, [], { parsingContext: context, filename });
        } catch (err) {
            // The guarded source does not compile: a real syntax error, or "import" used as a keyword.
            // Compiling (not running) the original tells which one.
            let syntaxError = err;
            if (job.original !== job.source) {
                try {
                    vm.compileFunction(job.original, [], { parsingContext: context, filename });
                    syntaxError = null;
                } catch (err2) {
                    syntaxError = err2;
                }
            }
            out.error = syntaxError
                ? `Syntax error: ${syntaxError && syntaxError.message ? syntaxError.message : "invalid script"}${lineOf(syntaxError, filename)}`
                : `import() is not available in scripts${lineOf(err, filename)}`;
            return out;
        }

        try {
            const setup = vm.runInContext(bootstrapSource, context, { filename: "api-tester-bootstrap", timeout: job.timeoutMs });
            setup(bridge, job.input, userFn);
        } catch (err) {
            out.error = `Could not start the script: ${err && err.message ? err.message : err}`;
            return out;
        }

        const started = Date.now();
        try {
            vm.runInContext("__apiTesterHost.run()", context, { timeout: job.timeoutMs });
        } catch (err) {
            if (isTimeout(err)) out.timedOut = true;
            else out.error = `Script failed: ${err && err.message ? String(err.message) : "unknown error"}`;
        }
        try {
            // collect reads what the script left behind (tests, logs, changed request) under a short time limit
            const remaining = Math.max(500, Math.min(2000, job.timeoutMs - (Date.now() - started)));
            out.collected = String(vm.runInContext("__apiTesterHost.collect()", context, { timeout: remaining }));
        } catch (err) {
            if (!out.error && !out.timedOut) out.error = isTimeout(err) ? "Script took too long to finish" : `Could not read script results: ${err.message}`;
        }
        return out;
    }

    parentPort.on("message", (job) => {
        let result;
        try {
            result = runJob(job);
        } catch (err) {
            result = { error: `Script engine error: ${err && err.message ? err.message : err}`, timedOut: false, collected: null };
        }
        parentPort.postMessage({ id: job.id, result });
    });
}

const WORKER_SOURCE = `(${scriptWorkerMain.toString()})(${JSON.stringify(BOOTSTRAP)});`;

// ------------------------------------------------------------------ host side

function textOrEmpty(v) {
    return v === undefined || v === null ? "" : String(v);
}

function headersObject(headers) {
    // [[name, value], ...] or { name: value } -> { name: value } (later duplicates joined)
    const out = {};
    if (Array.isArray(headers)) {
        for (const pair of headers) {
            if (!Array.isArray(pair) || pair[0] === undefined) continue;
            const name = String(pair[0]);
            out[name] = name in out ? `${out[name]}, ${textOrEmpty(pair[1])}` : textOrEmpty(pair[1]);
        }
    } else if (headers && typeof headers === "object") {
        for (const [k, v] of Object.entries(headers)) out[k] = textOrEmpty(v);
    }
    return out;
}

/** Plain-JSON view of the request given to the script. */
function requestView(request) {
    const r = request || {};
    return {
        method: String(r.method || "GET").toUpperCase(),
        url: textOrEmpty(r.url),
        headers: headersObject(r.headers),
        body: typeof r.body === "string" ? r.body : textOrEmpty(r.bodyText ?? (r.body && !Buffer.isBuffer(r.body) && typeof r.body !== "object" ? r.body : ""))
    };
}

/** Plain-JSON view of an HttpResponse given to post-response scripts. */
function responseView(response) {
    const r = response || {};
    const headers = {};
    if (r.headersMap && typeof r.headersMap === "object") {
        for (const [k, v] of Object.entries(r.headersMap)) headers[k.toLowerCase()] = textOrEmpty(v);
    } else {
        for (const [k, v] of Object.entries(headersObject(r.headers))) headers[k.toLowerCase()] = v;
    }
    return {
        status: typeof r.status === "number" ? r.status : Number(r.status) || 0,
        statusText: textOrEmpty(r.statusText),
        headers,
        body: textOrEmpty(r.bodyText),
        time: r.timings && typeof r.timings.total === "number" ? r.timings.total : typeof r.time === "number" ? r.time : null,
        size: r.size && typeof r.size.body === "number" ? r.size.body : null,
        url: textOrEmpty(r.url),
        cookies: (Array.isArray(r.cookies) ? r.cookies : []).map((c) => ({
            name: textOrEmpty(c && c.name), value: textOrEmpty(c && c.value), domain: textOrEmpty(c && c.domain), path: textOrEmpty(c && c.path)
        }))
    };
}

function makeBridge(scope) {
    // The only host function the script context can (indirectly) call. JSON text in, JSON text out.
    return function bridge(op, argsJson) {
        try {
            if (typeof argsJson !== "string") throw new Error("Bad call");
            const args = JSON.parse(argsJson);
            if (!Array.isArray(args)) throw new Error("Bad call");
            const name = String(args[0] ?? "");
            let value = null;
            switch (String(op)) {
                case "get":
                    value = scope ? scope.get(name) ?? null : null;
                    break;
                case "has":
                    value = scope ? scope.has(name) : false;
                    break;
                case "set": {
                    const target = String(args[2] ?? "runtime");
                    if (!SCOPES.includes(target)) throw new Error(`Unknown scope "${target}" (use runtime, environment or global)`);
                    if (!name.trim()) throw new Error("vars.set() needs a variable name");
                    if (!scope) throw new Error("Variables are not available here");
                    scope.set(name, String(args[1] ?? ""), target);
                    break;
                }
                case "unset":
                    if (scope) scope.unset(name);
                    break;
                case "resolve":
                    value = scope ? scope.resolve(name) : name;
                    break;
                default:
                    throw new Error("Unknown call");
            }
            return JSON.stringify({ value });
        } catch (err) {
            return JSON.stringify({ error: err && err.message ? String(err.message) : "Failed" });
        }
    };
}

// ------------------------------------------------------------------ worker pool (main thread)

const idleWorkers = [];
let nextJobId = 1;

function createScriptWorker(memoryMb) {
    const { port1, port2 } = new MessageChannel();
    const flagBuffer = new SharedArrayBuffer(4);
    const flag = new Int32Array(flagBuffer);
    const slot = { memoryMb, jobs: 0, job: null, exited: false, exitError: null, idleTimer: null, port: port1, worker: null };
    slot.worker = new Worker(WORKER_SOURCE, {
        eval: true,
        name: "API Tester script",
        workerData: { callPort: port2, flag: flagBuffer },
        transferList: [port2],
        resourceLimits: { maxOldGenerationSizeMb: memoryMb }
    });
    // bridge calls from the running script: answer on the port, then wake the waiting worker
    port1.on("message", (msg) => {
        let reply;
        try {
            reply = slot.job ? slot.job.bridge(msg && msg.op, msg && msg.args) : JSON.stringify({ error: "No script is running" });
        } catch (err) {
            reply = JSON.stringify({ error: err && err.message ? String(err.message) : "Failed" });
        }
        port1.postMessage(reply);
        Atomics.store(flag, 0, 1);
        Atomics.notify(flag, 0);
    });
    slot.worker.on("message", (msg) => {
        if (slot.job && msg && msg.id === slot.job.id) slot.job.finish({ result: msg.result });
    });
    slot.worker.on("error", (err) => {
        slot.exitError = err; // followed by "exit"
    });
    slot.worker.on("exit", () => {
        slot.exited = true;
        clearTimeout(slot.idleTimer);
        const i = idleWorkers.indexOf(slot);
        if (i >= 0) idleWorkers.splice(i, 1);
        try {
            port1.close();
        } catch {
            // already closed
        }
        if (slot.job) slot.job.finish({ exited: true, error: slot.exitError });
    });
    return slot;
}

function endWorker(slot) {
    slot.worker.terminate().catch(() => {});
}

/** A worker for a new job: an idle one with the standard limit, or a new one. */
function takeWorker(memoryMb) {
    if (memoryMb === SCRIPT_MEMORY_MB) {
        while (idleWorkers.length) {
            const slot = idleWorkers.pop();
            clearTimeout(slot.idleTimer);
            if (slot.exited) continue;
            slot.worker.ref();
            slot.port.ref();
            return slot;
        }
    }
    return createScriptWorker(memoryMb);
}

/** Keeps a worker for the next script (idle workers do not keep the process alive), or ends it. */
function parkWorker(slot) {
    if (slot.exited) return;
    if (slot.memoryMb !== SCRIPT_MEMORY_MB || slot.jobs >= MAX_JOBS_PER_WORKER || idleWorkers.length >= MAX_IDLE_WORKERS) {
        endWorker(slot);
        return;
    }
    slot.worker.unref();
    slot.port.unref();
    slot.idleTimer = setTimeout(() => endWorker(slot), IDLE_WORKER_MS);
    if (typeof slot.idleTimer.unref === "function") slot.idleTimer.unref();
    idleWorkers.push(slot);
}

/**
 * Runs one job in a worker -> { result } (what the worker reported) | { exited, error } (the worker died, e.g.
 * out of memory) | { stopped: "timeout" | "cancelled" } | { startError }. Never rejects.
 */
function runInWorker(job, scope, signal) {
    return new Promise((resolve) => {
        let slot;
        try {
            slot = takeWorker(job.memoryMb);
        } catch (err) {
            resolve({ startError: err });
            return;
        }
        let settled = false;
        let stopReason = null;
        const stop = (reason) => {
            if (settled || stopReason) return;
            stopReason = reason;
            endWorker(slot); // "exit" follows and finishes the job
        };
        const watchdog = setTimeout(() => stop("timeout"), job.timeoutMs + WATCHDOG_EXTRA_MS);
        const onAbort = () => stop("cancelled");
        slot.job = {
            id: job.id,
            bridge: makeBridge(scope),
            finish(outcome) {
                if (settled) return;
                settled = true;
                clearTimeout(watchdog);
                if (signal) signal.removeEventListener("abort", onAbort);
                slot.job = null;
                resolve(stopReason ? { stopped: stopReason } : outcome);
                if (!stopReason && !outcome.exited) parkWorker(slot);
            }
        };
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
        slot.jobs++;
        try {
            slot.worker.postMessage({ id: job.id, source: job.source, original: job.original, filename: job.filename, input: job.input, timeoutMs: job.timeoutMs });
        } catch (err) {
            slot.job.finish({ startError: err });
            endWorker(slot);
        }
    });
}

/** Ends the idle script workers (tests, shutdown). Running scripts are not affected. */
function closeScriptWorkers() {
    for (const slot of idleWorkers.splice(0)) {
        clearTimeout(slot.idleTimer);
        endWorker(slot);
    }
}

/**
 * Writes every "import" as "import" (see the file comment): the same text inside strings, comments,
 * regexes and templates, a syntax error where it would be the import keyword. An "import" right after an odd
 * number of backslashes is part of an escape and is left as is (in code that is a syntax error anyway).
 */
function guardImports(source) {
    return source.replace(/(\\*)import/g, (match, slashes) => (slashes.length % 2 ? match : `${slashes}\\u0069mport`));
}

function timeoutMessage(timeoutMs) {
    return `Script stopped: it ran longer than ${Math.round(timeoutMs / 100) / 10} s (endless loop?)`;
}

/**
 * Runs a pre-request or post-response script.
 *  options: { phase: "pre"|"post", scope, request, response, environmentName, timeoutMs, signal }
 *   request  pre: { method, url, headers: {name: value} | [[name, value]], body } (the script may change it)
 *            post: what was sent (read-only in the script)
 *   response post: HttpResponse (§2.2)
 *   signal   optional AbortSignal: ends the script (error "Script cancelled")
 * -> Promise<{ tests: [{name, passed, error}], logs: [{level, message}], error: null|string, request }>, never rejects.
 *    request: pre -> the (possibly changed) { method, url, headers: {}, body }; post -> the request view.
 */
async function runScript(code, options = {}) {
    const phase = options.phase === "post" ? "post" : "pre";
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : SCRIPT_TIMEOUT_MS;
    const signal = options.signal || null;
    const reqView = requestView(options.request);
    const result = { tests: [], logs: [], error: null, request: reqView };
    const source = typeof code === "string" ? code : "";
    if (!source.trim()) return result;
    if (signal && signal.aborted) {
        result.error = "Script cancelled";
        return result;
    }

    let input;
    try {
        input = JSON.stringify({
            phase,
            environmentName: textOrEmpty(options.environmentName),
            request: reqView,
            response: phase === "post" && options.response ? responseView(options.response) : null
        });
    } catch (err) {
        result.error = `Could not start the script: ${err.message}`;
        return result;
    }
    const memoryMb = input.length > LARGE_INPUT_CHARS
        ? Math.min(MAX_SCRIPT_MEMORY_MB, SCRIPT_MEMORY_MB + Math.ceil(input.length / (1024 * 1024)) * 8)
        : SCRIPT_MEMORY_MB;

    const outcome = await runInWorker({
        id: nextJobId++,
        source: guardImports(source),
        original: source,
        filename: phase === "pre" ? "pre-request script" : "post-response script",
        input,
        timeoutMs,
        memoryMb
    }, options.scope || null, signal);

    if (outcome.startError) {
        result.error = `Could not start the script engine: ${outcome.startError.message || outcome.startError}`;
        return result;
    }
    if (outcome.stopped) {
        result.error = outcome.stopped === "cancelled" ? "Script cancelled" : timeoutMessage(timeoutMs);
        return result;
    }
    if (outcome.exited) {
        const err = outcome.error;
        result.error = err && err.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? `Script stopped: it used more than ${memoryMb} MB of memory (a loop that keeps adding to a list?)`
            : `The script engine stopped unexpectedly${err && err.message ? `: ${err.message}` : ""}`;
        return result;
    }

    const r = outcome.result || {};
    result.error = r.error ? String(r.error) : null;
    if (r.collected) {
        try {
            const collected = JSON.parse(r.collected);
            result.tests = Array.isArray(collected.tests) ? collected.tests.map((t) => ({ name: String(t.name), passed: !!t.passed, error: t.error == null ? null : String(t.error) })) : [];
            result.logs = Array.isArray(collected.logs) ? collected.logs.map((l) => ({ level: String(l.level), message: String(l.message) })) : [];
            if (!result.error && collected.error) result.error = String(collected.error);
            if (phase === "pre" && collected.request && !r.timedOut) {
                const req = collected.request;
                result.request = { method: String(req.method), url: String(req.url), headers: headersObject(req.headers), body: String(req.body) };
            }
        } catch (err) {
            if (!result.error && !r.timedOut) result.error = `Could not read script results: ${err.message}`;
        }
    }
    if (r.timedOut) {
        result.error = timeoutMessage(timeoutMs);
        result.request = reqView; // a script stopped half-way does not change the request
    }
    return result;
}

module.exports = { runScript, closeScriptWorkers, SCRIPT_TIMEOUT_MS, SCRIPT_MEMORY_MB };
