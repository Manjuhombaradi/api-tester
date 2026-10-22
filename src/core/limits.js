"use strict";
// Time limits for checks that run patterns from a suite on response data: regular expressions ("matches" assertions,
// regex captures), JSONPath filters (/re/.test(@.name)) and JSON Schema "pattern" keywords. A pattern like (a+)+$
// can make the regex engine backtrack for minutes on a short text; without a limit that would freeze the desktop
// app's main process or a CI run (ReDoS). The pattern may come from a shared suite or an imported file.
//
// The work runs synchronously through a tiny vm script with a timeout: V8 interrupts the running code when the time
// is up - also inside the regex engine and also in code of this realm called from the script - and the call throws
// a TimeLimitError. Each call is limited on its own, and all calls for one response share a budget, so a suite with
// many slow patterns cannot block the process for long either.
const vm = require("vm");
const { performance } = require("perf_hooks");

const REGEX_TIME_LIMIT_MS = 500; // one regular expression on one text
const QUERY_TIME_LIMIT_MS = 2000; // one JSONPath query or one JSON Schema validation
const CHECKS_BUDGET_MS = 3000; // everything limited here for one response (assertions and captures)

const REGEX_TIMEOUT_MESSAGE = "Regex took too long (possible catastrophic backtracking)";
const BUDGET_MESSAGE = `Not checked: the checks of this response already took more than ${CHECKS_BUDGET_MS / 1000} s ` +
    "(a regular expression may backtrack catastrophically)";

class TimeLimitError extends Error {
    constructor(message) {
        super(message);
        this.name = "TimeLimitError";
        this.code = "TIME_LIMIT";
    }
}

const context = vm.createContext(Object.create(null), { name: "API Tester time limit", codeGeneration: { strings: false, wasm: false } });
const script = new vm.Script("run()", { filename: "api-tester-time-limit" });
let running = false;

/** Shared time budget of the limited checks of one response. */
function createTimeBudget(totalMs = CHECKS_BUDGET_MS) {
    let used = 0;
    return {
        totalMs,
        remaining: () => Math.max(0, totalMs - used),
        spend: (ms) => { used += Math.max(0, ms); },
        get usedMs() { return used; }
    };
}

/**
 * Runs fn() synchronously and returns its value. It is stopped after limitMs (or what is left of budget) and then
 * throws TimeLimitError(message) - or the budget message when the budget ran out. fn's own errors are thrown as
 * they are. A call made while another limited call runs simply runs (the outer limit applies).
 */
function runWithTimeLimit(fn, { limitMs = REGEX_TIME_LIMIT_MS, budget = null, message = REGEX_TIMEOUT_MESSAGE } = {}) {
    if (running) return fn();
    let limit = limitMs;
    if (budget) {
        const left = budget.remaining();
        if (left <= 0) throw new TimeLimitError(BUDGET_MESSAGE);
        limit = Math.min(limit, left);
    }
    let value;
    let failed = false;
    let error = null;
    context.run = () => {
        try {
            value = fn();
        } catch (err) {
            failed = true;
            error = err;
        }
    };
    const started = performance.now();
    running = true;
    try {
        script.runInContext(context, { timeout: Math.max(1, Math.ceil(limit)) });
    } catch (err) {
        if (err && err.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") throw new TimeLimitError(limit < limitMs ? BUDGET_MESSAGE : message);
        throw err;
    } finally {
        running = false;
        context.run = undefined;
        if (budget) budget.spend(performance.now() - started);
    }
    if (failed) throw error;
    return value;
}

const isTimeLimit = (err) => !!err && err.code === "TIME_LIMIT";

module.exports = {
    runWithTimeLimit, createTimeBudget, isTimeLimit, TimeLimitError,
    REGEX_TIME_LIMIT_MS, QUERY_TIME_LIMIT_MS, CHECKS_BUDGET_MS, REGEX_TIMEOUT_MESSAGE, BUDGET_MESSAGE
};
