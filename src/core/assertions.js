"use strict";
// No-code assertions: checks on status, headers, body, JSON values (JSONPath) and JSON Schema.
// The runner evaluates them after every response; the metadata below drives the editor's dropdowns.
//
// Comparison is type-aware: a number (status, a JSON number) compares numerically with the expected text
// (200 equals "200", 1.5 equals "1.50"); text values (headers, JSON strings) must match exactly, so "1.10" is not
// "1.1" and "02134" is not "2134"; objects / arrays compare deep-equal against the JSON-parsed expected text.
const { JSONPath } = require("jsonpath-plus");
const Ajv = require("ajv");
const Ajv2019 = require("ajv/dist/2019");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const { newAssertion } = require("./model");
const { runWithTimeLimit, createTimeBudget, isTimeLimit, REGEX_TIME_LIMIT_MS, QUERY_TIME_LIMIT_MS, REGEX_TIMEOUT_MESSAGE } = require("./limits");

const MAX_ACTUAL_CHARS = 300;
const MAX_SCHEMA_ERRORS = 5;
const NUMERIC_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const INTEGER_RE = /^[-+]?\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
// Valid RegExp flags, each at most once ("/api/users" is a path, not the pattern "api" with flags "users").
const REGEX_FLAGS_RE = /^(?![a-z]*([a-z])[a-z]*\1)[dgimsuvy]*$/;

// ------------------------------------------------------------------ metadata for the UI

const STRING_OPS = ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith", "matches", "in", "notIn"];
const NUMBER_OPS = ["equals", "notEquals", "gt", "gte", "lt", "lte", "in", "notIn", "matches"];
const LENGTH_OPS = ["lengthEquals", "lengthGt", "lengthLt", "isEmpty", "isNotEmpty"];

const ASSERTION_SOURCES = [
    { value: "status", label: "Status code", needsProperty: false, propertyPlaceholder: "", hint: "HTTP status code, e.g. 200", operators: NUMBER_OPS },
    { value: "statusText", label: "Status text", needsProperty: false, propertyPlaceholder: "", hint: "Reason phrase, e.g. OK or Not Found", operators: [...STRING_OPS, "isEmpty", "isNotEmpty"] },
    { value: "responseTime", label: "Response time (ms)", needsProperty: false, propertyPlaceholder: "", hint: "Total time in milliseconds", operators: ["lt", "lte", "gt", "gte"] },
    { value: "size", label: "Body size (bytes)", needsProperty: false, propertyPlaceholder: "", hint: "Size of the response body in bytes", operators: ["lt", "lte", "gt", "gte", "equals", "notEquals"] },
    {
        value: "header", label: "Header", needsProperty: true, propertyPlaceholder: "Content-Type", hint: "Response header (name not case-sensitive)",
        operators: ["exists", "notExists", ...STRING_OPS, "gt", "gte", "lt", "lte", ...LENGTH_OPS]
    },
    { value: "contentType", label: "Content-Type", needsProperty: false, propertyPlaceholder: "", hint: "Content-Type header of the response", operators: ["contains", "notContains", "equals", "notEquals", "startsWith", "matches", "exists", "notExists"] },
    {
        value: "body", label: "Body (text)", needsProperty: false, propertyPlaceholder: "", hint: "Whole response body as text",
        operators: ["contains", "notContains", "equals", "notEquals", "startsWith", "endsWith", "matches", ...LENGTH_OPS]
    },
    {
        value: "jsonpath", label: "JSON value", needsProperty: true, propertyPlaceholder: "$.data[0].id",
        hint: "JSONPath into the JSON body. One match gives the value, several give a list",
        operators: ["equals", "notEquals", "exists", "notExists", "contains", "notContains", "startsWith", "endsWith", "gt", "gte", "lt", "lte",
            "matches", "isType", "in", "notIn", ...LENGTH_OPS, "validSchema"]
    },
    { value: "schema", label: "JSON schema", needsProperty: false, propertyPlaceholder: "", hint: "Validate the whole JSON body against a JSON Schema", operators: ["validSchema"] }
];

const ASSERTION_OPERATORS = [
    { value: "equals", label: "equals", needsExpected: true, expectedPlaceholder: "200", numeric: false },
    { value: "notEquals", label: "does not equal", needsExpected: true, expectedPlaceholder: "value", numeric: false },
    { value: "contains", label: "contains", needsExpected: true, expectedPlaceholder: "text", numeric: false },
    { value: "notContains", label: "does not contain", needsExpected: true, expectedPlaceholder: "text", numeric: false },
    { value: "startsWith", label: "starts with", needsExpected: true, expectedPlaceholder: "text", numeric: false },
    { value: "endsWith", label: "ends with", needsExpected: true, expectedPlaceholder: "text", numeric: false },
    { value: "gt", label: "greater than", needsExpected: true, expectedPlaceholder: "0", numeric: true },
    { value: "gte", label: "greater or equal", needsExpected: true, expectedPlaceholder: "0", numeric: true },
    { value: "lt", label: "less than", needsExpected: true, expectedPlaceholder: "2000", numeric: true },
    { value: "lte", label: "less or equal", needsExpected: true, expectedPlaceholder: "2000", numeric: true },
    { value: "exists", label: "exists", needsExpected: false, expectedPlaceholder: "", numeric: false },
    { value: "notExists", label: "does not exist", needsExpected: false, expectedPlaceholder: "", numeric: false },
    { value: "matches", label: "matches regex", needsExpected: true, expectedPlaceholder: "/^ok$/i", numeric: false },
    { value: "isType", label: "is of type", needsExpected: true, expectedPlaceholder: "string, number, boolean, object, array, null", numeric: false },
    { value: "lengthEquals", label: "length equals", needsExpected: true, expectedPlaceholder: "3", numeric: true },
    { value: "lengthGt", label: "length greater than", needsExpected: true, expectedPlaceholder: "0", numeric: true },
    { value: "lengthLt", label: "length less than", needsExpected: true, expectedPlaceholder: "100", numeric: true },
    { value: "in", label: "is one of", needsExpected: true, expectedPlaceholder: "200, 201, 204", numeric: false },
    { value: "notIn", label: "is not one of", needsExpected: true, expectedPlaceholder: "500, 502, 503", numeric: false },
    { value: "isEmpty", label: "is empty", needsExpected: false, expectedPlaceholder: "", numeric: false },
    { value: "isNotEmpty", label: "is not empty", needsExpected: false, expectedPlaceholder: "", numeric: false },
    { value: "validSchema", label: "matches JSON schema", needsExpected: true, expectedPlaceholder: "{ \"type\": \"object\", \"required\": [\"id\"] }", numeric: false }
];

const OPERATOR_BY_VALUE = new Map(ASSERTION_OPERATORS.map((o) => [o.value, o]));
const SOURCE_BY_VALUE = new Map(ASSERTION_SOURCES.map((s) => [s.value, s]));

/** Operators that make sense for a source (full operator objects, in the source's preferred order). */
function operatorsForSource(source) {
    const meta = SOURCE_BY_VALUE.get(source);
    if (!meta) return ASSERTION_OPERATORS.slice();
    return meta.operators.map((v) => OPERATOR_BY_VALUE.get(v)).filter(Boolean);
}

// ------------------------------------------------------------------ shared value helpers (also used by extract.js)

function toNumber(v) {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string") {
        const t = v.trim();
        return NUMERIC_RE.test(t) ? Number(t) : null;
    }
    return null;
}

function parseJson(text) {
    try {
        return { ok: true, value: JSON.parse(text) };
    } catch (err) {
        return { ok: false, message: err.message };
    }
}

function typeName(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    return typeof v;
}

function shorten(text, max = MAX_ACTUAL_CHARS) {
    const s = String(text);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Short display text of any value: strings as is, objects as compact JSON, undefined as "(none)". */
function formatValue(v, max = MAX_ACTUAL_CHARS) {
    if (v === undefined) return "(none)";
    if (typeof v === "string") return shorten(v, max);
    if (v === null || typeof v !== "object") return String(v);
    try {
        return shorten(JSON.stringify(v), max);
    } catch {
        return "[object]";
    }
}

function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

/**
 * Runs a regular expression from a suite on a text under a time limit (limits.js): a catastrophic pattern cannot hang
 * the app. ctx.budget: shared budget of one response. -> re.test(text) or, with exec, re.exec(text).
 * Throws TimeLimitError("Regex took too long (possible catastrophic backtracking)").
 */
function runRegex(re, text, ctx = null, exec = false) {
    return runWithTimeLimit(() => (exec ? re.exec(text) : re.test(text)), {
        limitMs: REGEX_TIME_LIMIT_MS,
        budget: ctx && ctx.budget,
        message: REGEX_TIMEOUT_MESSAGE
    });
}

/**
 * "/pattern/flags" or a plain pattern -> RegExp (global / sticky flags dropped so test() has no state).
 * The slash form is used only when the part after the last "/" is a set of valid flags, so path-like
 * patterns such as "/api/users" or "/users/me" are plain patterns.
 */
function parseRegex(text) {
    const s = String(text ?? "");
    const m = /^\/([\s\S]+)\/([A-Za-z]*)$/.exec(s.trim());
    try {
        if (m && REGEX_FLAGS_RE.test(m[2])) return new RegExp(m[1], m[2].replace(/[gy]/g, ""));
        return new RegExp(s);
    } catch (err) {
        throw new Error(`Invalid regular expression ${s}: ${err.message.replace(/^Invalid regular expression: /, "")}`);
    }
}

const jsonCache = new WeakMap();

/** Parsed JSON body of a response -> { ok, value } or { ok:false, message }. Parses bodyText when http.js did not. */
function responseJson(response) {
    if (!response || typeof response !== "object") return { ok: false, message: "No response" };
    if (response.json !== undefined) return { ok: true, value: response.json };
    if (jsonCache.has(response)) return jsonCache.get(response);
    const text = typeof response.bodyText === "string" ? response.bodyText : "";
    let out;
    if (!text.trim()) out = { ok: false, message: "Response body is empty (not JSON)" };
    else {
        const parsed = parseJson(text);
        out = parsed.ok ? parsed : { ok: false, message: "Response body is not JSON" };
    }
    jsonCache.set(response, out);
    return out;
}

/** Accepts "$.a.b", "a.b", ".a", "[0].id" -> a JSONPath starting with $. */
function normalizeJsonPath(path) {
    const p = String(path ?? "").trim();
    if (!p || p.startsWith("$")) return p;
    if (p.startsWith("[") || p.startsWith(".")) return `$${p}`;
    return `$.${p}`;
}

/**
 * Syntax problems jsonpath-plus would silently ignore (it then matches the root or every node):
 * unbalanced brackets / parentheses / quotes, empty [], "..." and a trailing "." -> reason text, or "" when fine.
 * Inside ( ) (filter and script expressions) only parentheses and quotes are counted.
 */
function jsonPathSyntaxError(p) {
    const closers = [];
    for (let i = 0; i < p.length; i++) {
        const c = p[i];
        if (c === "`") {
            i++; // jsonpath-plus: a backtick escapes the next character
            continue;
        }
        if (c === "'" || c === "\"") {
            let j = i + 1;
            while (j < p.length && p[j] !== c) j += p[j] === "\\" ? 2 : 1;
            if (j >= p.length) return `the quote ${c} at position ${i + 1} is not closed`;
            i = j;
            continue;
        }
        const inParens = closers.length > 0 && closers[closers.length - 1] === ")";
        if (c === "(") closers.push(")");
        else if (c === "[" && !inParens) {
            if (/^\[\s*\]/.test(p.slice(i))) return `empty brackets [] at position ${i + 1}`;
            closers.push("]");
        } else if (c === ")" || (c === "]" && !inParens)) {
            if (closers.pop() !== c) return `unexpected "${c}" at position ${i + 1}`;
        } else if (c === "." && !closers.length && p.startsWith("...", i)) {
            return `"..." at position ${i + 1} (use . for a child or .. for all levels)`;
        }
    }
    if (closers.length) return `"${closers[closers.length - 1] === "]" ? "[" : "("}" is not closed`;
    if (p.endsWith(".")) return "the path ends with a dot (a name is missing)";
    return "";
}

/**
 * Runs a JSONPath query -> { ok, path, count, value } (value: single match as is, several as an array, none undefined)
 * or { ok:false, message } for an invalid path or a query that took too long (filters can hold regular expressions).
 * ctx.budget: shared time budget of one response (limits.js).
 */
function jsonPathQuery(json, path, ctx = null) {
    const p = normalizeJsonPath(path);
    if (!p) return { ok: false, message: "Enter a JSONPath, e.g. $.data[0].id" };
    const syntaxError = jsonPathSyntaxError(p);
    if (syntaxError) return { ok: false, message: `Invalid JSONPath "${p}": ${syntaxError}` };
    let matches;
    if (json === null || json === undefined) {
        matches = p === "$" && json === null ? [null] : [];
    } else {
        try {
            matches = runWithTimeLimit(() => JSONPath({ path: p, json, wrap: true, eval: "safe" }), {
                limitMs: QUERY_TIME_LIMIT_MS,
                budget: ctx && ctx.budget,
                message: `JSONPath "${p}" took too long (more than ${QUERY_TIME_LIMIT_MS / 1000} s; a regular expression in a filter may backtrack catastrophically)`
            });
        } catch (err) {
            if (isTimeLimit(err)) return { ok: false, message: err.message };
            return { ok: false, message: `Invalid JSONPath "${p}": ${err.message.replace(/^jsonPath: /, "")}` };
        }
    }
    if (!Array.isArray(matches)) matches = matches === undefined ? [] : [matches];
    const value = matches.length === 0 ? undefined : matches.length === 1 ? matches[0] : matches;
    return { ok: true, path: p, count: matches.length, value };
}

/** JSONPath for a child key: $.name or $['odd key']. */
function jsonPathFor(base, key) {
    if (typeof key === "number") return `${base}[${key}]`;
    if (/^[A-Za-z_$][\w$]*$/.test(key)) return `${base}.${key}`;
    return `${base}['${String(key).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`;
}

/** Response header value (case-insensitive; repeated headers joined with ", ") or undefined. */
function headerValue(response, name) {
    const lower = String(name ?? "").trim().toLowerCase();
    if (!lower || !response) return undefined;
    if (response.headersMap && Object.prototype.hasOwnProperty.call(response.headersMap, lower)) return String(response.headersMap[lower]);
    if (Array.isArray(response.headers)) {
        const values = response.headers.filter((h) => Array.isArray(h) && String(h[0]).toLowerCase() === lower).map((h) => String(h[1]));
        if (values.length) return values.join(", ");
    }
    return undefined;
}

// ------------------------------------------------------------------ JSON Schema (ajv), compiled validators cached

const validatorCache = new Map();
const MAX_CACHED_VALIDATORS = 200;

function ajvFor(schema) {
    const draft = schema && typeof schema === "object" && typeof schema.$schema === "string" ? schema.$schema : "";
    const options = { allErrors: true, strict: false, validateFormats: true };
    // A fresh instance per schema: no clashes between schemas using the same $id, memory freed with the cache entry.
    let ajv;
    if (draft.includes("2020-12")) ajv = new Ajv2020(options);
    else if (draft.includes("2019-09")) ajv = new Ajv2019(options);
    else ajv = new Ajv(options);
    addFormats(ajv);
    return ajv;
}

function getValidator(schemaText) {
    const key = String(schemaText ?? "");
    if (validatorCache.has(key)) return validatorCache.get(key);
    let out;
    if (!key.trim()) out = { error: "Enter a JSON Schema in the expected value" };
    else {
        const parsed = parseJson(key);
        if (!parsed.ok) out = { error: `Schema is not valid JSON: ${parsed.message}` };
        else if (typeof parsed.value !== "boolean" && (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value))) {
            out = { error: "Schema must be a JSON object, e.g. { \"type\": \"object\" }" };
        } else {
            let schema = parsed.value;
            // ajv 8 knows draft-07, 2019-09 and 2020-12; older drafts are validated as draft-07 (nearly identical keywords).
            if (schema && typeof schema === "object" && typeof schema.$schema === "string" && !/draft-07|2019-09|2020-12/.test(schema.$schema)) {
                schema = { ...schema };
                delete schema.$schema;
            }
            try {
                out = { validate: ajvFor(schema).compile(schema) };
            } catch (err) {
                out = { error: `Invalid JSON Schema: ${err.message}` };
            }
        }
    }
    if (validatorCache.size >= MAX_CACHED_VALIDATORS) validatorCache.delete(validatorCache.keys().next().value);
    validatorCache.set(key, out);
    return out;
}

function schemaErrorPath(instancePath) {
    if (!instancePath) return "$";
    return "$" + instancePath.split("/").slice(1).map((seg) => {
        const s = seg.replace(/~1/g, "/").replace(/~0/g, "~");
        return /^\d+$/.test(s) ? `[${s}]` : jsonPathFor("", s);
    }).join("");
}

/** -> { passed, message }. Time limited (a "pattern" in the schema is a regular expression from the suite). */
function validateSchema(value, schemaText, ctx = null) {
    let v;
    let valid;
    try {
        valid = runWithTimeLimit(() => {
            v = getValidator(schemaText);
            return v.error ? false : v.validate(value);
        }, {
            limitMs: QUERY_TIME_LIMIT_MS,
            budget: ctx && ctx.budget,
            message: `JSON Schema validation took too long (more than ${QUERY_TIME_LIMIT_MS / 1000} s; a "pattern" in the schema may backtrack catastrophically)`
        });
    } catch (err) {
        if (isTimeLimit(err)) return { passed: false, message: err.message };
        throw err;
    }
    if (v.error) return { passed: false, message: v.error };
    if (valid) return { passed: true, message: "" };
    const errors = v.validate.errors || [];
    const parts = errors.slice(0, MAX_SCHEMA_ERRORS).map((e) => {
        let text = `${schemaErrorPath(e.instancePath)} ${e.message}`;
        if (e.params && e.params.additionalProperty) text += ` (${e.params.additionalProperty})`;
        if (e.params && Array.isArray(e.params.allowedValues)) text += `: ${e.params.allowedValues.map((x) => JSON.stringify(x)).join(", ")}`;
        return text;
    });
    const more = errors.length > MAX_SCHEMA_ERRORS ? ` (+${errors.length - MAX_SCHEMA_ERRORS} more)` : "";
    return { passed: false, message: `Schema validation failed: ${parts.join("; ")}${more}` };
}

// ------------------------------------------------------------------ reading the actual value

/** -> { value } | { value: undefined, missing: "why not found" } | { configError: "assertion is incomplete" } */
function readActual(source, property, response, ctx = null) {
    switch (source) {
        case "status":
            return { value: typeof response.status === "number" ? response.status : toNumber(response.status) ?? undefined };
        case "statusText":
            return { value: response.statusText == null ? "" : String(response.statusText) };
        case "responseTime": {
            const total = response.timings && typeof response.timings.total === "number" ? response.timings.total : response.time;
            return typeof total === "number" ? { value: Math.round(total), unit: UNITS.responseTime } : { value: undefined, missing: "Response time is not available" };
        }
        case "size": {
            if (response.size && typeof response.size.body === "number") return { value: response.size.body, unit: UNITS.size };
            if (Buffer.isBuffer(response.body)) return { value: response.body.length, unit: UNITS.size };
            return { value: Buffer.byteLength(String(response.bodyText ?? "")), unit: UNITS.size };
        }
        case "header": {
            if (!String(property ?? "").trim()) return { configError: "Enter the header name in Property" };
            const value = headerValue(response, property);
            return value === undefined ? { value, missing: `Header "${String(property).trim()}" is missing` } : { value };
        }
        case "contentType": {
            const value = response.contentType || headerValue(response, "content-type");
            return value ? { value: String(value) } : { value: undefined, missing: "The response has no Content-Type header" };
        }
        case "body":
            return { value: response.bodyText == null ? "" : String(response.bodyText) };
        case "jsonpath": {
            const json = responseJson(response);
            const q = jsonPathQuery(json.ok ? json.value : undefined, property, ctx);
            if (!q.ok) return { configError: q.message };
            if (!json.ok) return { value: undefined, missing: json.message };
            return q.count === 0 ? { value: undefined, missing: `No match for ${q.path}` } : { value: q.value };
        }
        case "schema": {
            const json = responseJson(response);
            return json.ok ? { value: json.value } : { value: undefined, missing: json.message };
        }
        default:
            return { configError: `Unknown assertion source "${source}"` };
    }
}

// ------------------------------------------------------------------ operators

/** Type-aware equality of an actual value and the expected text. */
function valuesEqual(actual, expected) {
    if (actual === undefined) return false;
    const exp = String(expected ?? "");
    const t = exp.trim();
    if (actual === null) return t === "null";
    if (typeof actual === "boolean") return t === String(actual);
    if (typeof actual === "number") {
        const n = toNumber(t);
        return n !== null && n === actual;
    }
    if (typeof actual === "object") {
        const p = parseJson(t);
        return p.ok && deepEqual(actual, p.value);
    }
    // Text (headers, status text, JSON strings): exact match, no number coercion. Version strings, zip codes
    // and big string ids only look like numbers ("1.10" is not "1.1", "02134" is not "2134").
    const s = String(actual);
    if (s === exp || s === t) return true;
    if (t.startsWith("\"")) {
        // expected written as a JSON string literal: "abc"
        const p = parseJson(t);
        if (p.ok && p.value === s) return true;
    }
    if ((t.startsWith("{") || t.startsWith("[")) && /^\s*[{[]/.test(s)) {
        // whole JSON text compared structurally (formatting / key order do not matter)
        const pa = parseJson(s);
        const pe = parseJson(t);
        if (pa.ok && pe.ok) return deepEqual(pa.value, pe.value);
    }
    return false;
}

/** Items of an "in" list: JSON array or comma separated values. */
function parseList(expected) {
    const t = String(expected ?? "").trim();
    if (t.startsWith("[")) {
        const p = parseJson(t);
        if (p.ok && Array.isArray(p.value)) return p.value.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
    }
    return t === "" ? [] : t.split(",").map((x) => x.trim());
}

function lengthOf(v) {
    if (typeof v === "string" || Array.isArray(v)) return v.length;
    if (v && typeof v === "object") return Object.keys(v).length;
    return null;
}

function isEmptyValue(v) {
    if (v === undefined || v === null) return true;
    if (typeof v === "string" || Array.isArray(v)) return v.length === 0;
    if (typeof v === "object") return Object.keys(v).length === 0;
    return false;
}

/** Order comparison -> { cmp } or { error } (numbers, or ISO dates when both sides are dates). */
function compareOrder(actual, expected) {
    const at = typeof actual === "string" ? actual.trim() : "";
    const et = String(expected ?? "").trim();
    if (INTEGER_RE.test(at) && INTEGER_RE.test(et)) {
        // whole numbers given as text compare exactly, also beyond 2^53 (big ids, counters)
        const d = BigInt(at) - BigInt(et);
        return { cmp: d > 0n ? 1 : d < 0n ? -1 : 0 };
    }
    const an = toNumber(actual);
    const en = toNumber(expected);
    if (an !== null && en !== null) return { cmp: an - en };
    if (typeof actual === "string" && DATE_RE.test(actual.trim()) && DATE_RE.test(String(expected).trim())) {
        const ad = Date.parse(actual.trim());
        const ed = Date.parse(String(expected).trim());
        if (!Number.isNaN(ad) && !Number.isNaN(ed)) return { cmp: ad - ed };
    }
    if (en === null) return { error: `Expected value "${shorten(expected, 60)}" is not a number` };
    return { error: `${formatValue(actual, 60)} is not a number` };
}

function textOf(v) {
    if (typeof v === "string") return v;
    if (v === null || typeof v !== "object") return String(v);
    return JSON.stringify(v);
}

function quote(s) {
    return `"${shorten(s, 80)}"`;
}

/**
 * Evaluates one operator -> { passed, message }. `found` holds the actual value and why it may be missing.
 * ctx.budget: shared time budget of one response for regular expressions and schemas (limits.js).
 */
function check(operator, found, expected, ctx = null) {
    const actual = found.value;
    const missing = found.missing || "Value not found";
    const a = formatValue(actual, 80);
    // response time / body size: show the unit next to the numbers ("Expected less than 2000 ms, got 2350 ms")
    const unit = found.unit && typeof actual === "number" ? found.unit : "";
    const withUnit = (text) => (unit && toNumber(text) !== null ? `${String(text).trim()}${unit}` : quoteIfText(text));
    const needValue = (fn) => (actual === undefined ? { passed: false, message: missing } : fn());
    const ok = (passed, message) => ({ passed, message: passed ? "" : message });
    switch (operator) {
        case "equals":
            // a text actual is always quoted, so "007" vs 7 shows that the value is text
            return needValue(() => ok(valuesEqual(actual, expected), `Expected ${withUnit(expected)} but got ${typeof actual === "string" ? quote(a) : withUnit(a)}`));
        case "notEquals":
            return ok(!valuesEqual(actual, expected), `Expected any value other than ${withUnit(expected)}`);
        case "contains":
            return needValue(() => ok(containsValue(actual, expected), `${describeHolder(actual)} does not contain ${quote(expected)}`));
        case "notContains":
            return ok(actual === undefined || !containsValue(actual, expected), `${describeHolder(actual)} contains ${quote(expected)}`);
        case "startsWith":
            return needValue(() => ok(textOf(actual).startsWith(String(expected)), `${quote(a)} does not start with ${quote(expected)}`));
        case "endsWith":
            return needValue(() => ok(textOf(actual).endsWith(String(expected)), `${quote(textOf(actual).slice(-60))} does not end with ${quote(expected)}`));
        case "gt":
        case "gte":
        case "lt":
        case "lte":
            return needValue(() => {
                const c = compareOrder(actual, expected);
                if (c.error) return { passed: false, message: c.error };
                const passed = operator === "gt" ? c.cmp > 0 : operator === "gte" ? c.cmp >= 0 : operator === "lt" ? c.cmp < 0 : c.cmp <= 0;
                const word = { gt: "more than", gte: "at least", lt: "less than", lte: "at most" }[operator];
                return ok(passed, `Expected ${word} ${String(expected).trim()}${unit}, got ${a}${unit}`);
            });
        case "exists":
            return ok(actual !== undefined, missing);
        case "notExists":
            return ok(actual === undefined, `Value exists: ${a}`);
        case "matches":
            return needValue(() => {
                let re;
                try {
                    re = parseRegex(expected);
                } catch (err) {
                    return { passed: false, message: err.message };
                }
                let matched;
                try {
                    matched = runRegex(re, textOf(actual), ctx);
                } catch (err) {
                    if (isTimeLimit(err)) return { passed: false, message: err.message };
                    throw err;
                }
                return ok(matched, `${quote(a)} does not match ${String(expected)}`);
            });
        case "isType":
            return needValue(() => {
                const want = String(expected ?? "").trim().toLowerCase();
                const valid = ["string", "number", "integer", "boolean", "object", "array", "null"];
                if (!valid.includes(want)) return { passed: false, message: `Unknown type "${expected}" (use ${valid.join(", ")})` };
                const actualType = typeName(actual);
                const passed = want === "integer" ? Number.isInteger(actual) : actualType === want;
                return ok(passed, `Expected type ${want}, got ${actualType}`);
            });
        case "lengthEquals":
        case "lengthGt":
        case "lengthLt":
            return needValue(() => {
                const len = lengthOf(actual);
                if (len === null) return { passed: false, message: `${typeName(actual)} value has no length` };
                const n = toNumber(expected);
                if (n === null) return { passed: false, message: `Expected length "${shorten(expected, 60)}" is not a number` };
                const passed = operator === "lengthEquals" ? len === n : operator === "lengthGt" ? len > n : len < n;
                const word = { lengthEquals: "", lengthGt: "greater than ", lengthLt: "less than " }[operator];
                return ok(passed, `Expected length ${word}${n}, got ${len}`);
            });
        case "in":
            return needValue(() => {
                const items = parseList(expected);
                return ok(items.some((x) => valuesEqual(actual, x)), `${quoteIfText(a)} is not one of ${String(expected).trim()}`);
            });
        case "notIn": {
            const items = parseList(expected);
            return ok(actual === undefined || !items.some((x) => valuesEqual(actual, x)), `${quoteIfText(a)} is one of ${String(expected).trim()}`);
        }
        case "isEmpty":
            return ok(isEmptyValue(actual), `Value is not empty: ${a}`);
        case "isNotEmpty":
            return ok(!isEmptyValue(actual), actual === undefined ? missing : "Value is empty");
        case "validSchema":
            return needValue(() => validateSchema(actual, expected, ctx));
        default:
            return { passed: false, message: `Unknown operator "${operator}"` };
    }
}

function containsValue(actual, expected) {
    if (Array.isArray(actual)) {
        const p = parseJson(String(expected).trim());
        return actual.some((x) => valuesEqual(x, expected) || (p.ok && deepEqual(x, p.value)));
    }
    if (actual && typeof actual === "object") {
        // object: has a key with that name, or its JSON text contains the expected text
        return Object.prototype.hasOwnProperty.call(actual, String(expected)) || textOf(actual).includes(String(expected));
    }
    return textOf(actual).includes(String(expected));
}

function describeHolder(actual) {
    if (Array.isArray(actual)) return `List ${formatValue(actual, 60)}`;
    if (typeof actual === "string" && actual.length > 60) return "Value";
    return quote(formatValue(actual, 60));
}

function quoteIfText(s) {
    const t = String(s ?? "");
    if (t === "(none)" || toNumber(t) !== null || /^(true|false|null)$/.test(t.trim()) || /^\s*[[{"]/.test(t)) return shorten(t, 80);
    return quote(t);
}

// ------------------------------------------------------------------ labels

const UNITS = { responseTime: " ms", size: " bytes" };

function subjectLabel(source, property) {
    const p = String(property ?? "").trim();
    switch (source) {
        case "status": return "Status";
        case "statusText": return "Status text";
        case "responseTime": return "Response time";
        case "size": return "Body size";
        case "header": return `Header "${p || "?"}"`;
        case "contentType": return "Content-Type";
        case "body": return "Body";
        case "jsonpath": return p ? normalizeJsonPath(p) : "JSON value";
        case "schema": return "Body";
        case "script": return "Script test";
        default: return String(source || "Value");
    }
}

/** Human sentence for an assertion, e.g. "Status equals 200", "$.id exists", "Response time less than 2000 ms". */
function describeAssertion(assertion, resolvedExpected) {
    const a = assertion || {};
    const op = OPERATOR_BY_VALUE.get(a.operator);
    const subject = subjectLabel(a.source, a.property);
    if (!op) return `${subject} ${a.operator || "?"}`;
    if (a.operator === "validSchema") return `${subject} matches JSON schema`;
    if (!op.needsExpected) return `${subject} ${op.label}`;
    const exp = String(resolvedExpected ?? a.expected ?? "").trim();
    const unit = ["gt", "gte", "lt", "lte", "equals", "notEquals"].includes(a.operator) && toNumber(exp) !== null ? UNITS[a.source] || "" : "";
    let shown = exp;
    if (["contains", "notContains", "startsWith", "endsWith"].includes(a.operator)) shown = quote(exp);
    else if (a.operator === "equals" || a.operator === "notEquals") shown = quoteIfText(exp);
    return shorten(`${subject} ${op.label} ${shown}${unit}`, 200);
}

// ------------------------------------------------------------------ public API

/**
 * Evaluates the request's assertions against a response.
 * -> [{ id, source, operator, label, passed, actual, expected, message, skipped }]
 * Disabled assertions are returned as skipped. When the request got no response, every assertion is skipped
 * ("Not checked") because the error itself is reported on the request.
 * options.budget: time budget shared with the captures of the same response (limits.createTimeBudget); regular
 * expressions, JSONPath queries and schemas are time limited, so a catastrophic pattern fails its check instead of
 * hanging the app.
 */
function evaluateAssertions(assertions, response, scope, options = {}) {
    const out = [];
    const ctx = { budget: (options && options.budget) || createTimeBudget() };
    const resolve = (text) => (scope && typeof scope.resolve === "function" ? scope.resolve(String(text ?? "")) : String(text ?? ""));
    const noResponse = !response || typeof response !== "object" || !!response.error;
    for (const a of Array.isArray(assertions) ? assertions : []) {
        if (!a || typeof a !== "object" || a.source === "script") continue;
        const base = { id: a.id, source: a.source, operator: a.operator };
        let expected = "";
        let property = "";
        try {
            expected = resolve(a.expected);
            property = resolve(a.property);
        } catch {
            expected = String(a.expected ?? "");
            property = String(a.property ?? "");
        }
        const label = describeAssertion({ ...a, property }, expected);
        const shownExpected = shorten(expected, MAX_ACTUAL_CHARS);
        if (a.enabled === false) {
            out.push({ ...base, label, passed: true, actual: "", expected: shownExpected, message: "Disabled", skipped: true });
            continue;
        }
        if (noResponse) {
            const why = response && response.error ? response.error.message || response.error.code : "no response";
            out.push({ ...base, label, passed: false, actual: "", expected: shownExpected, message: `Not checked: ${why}`, skipped: true });
            continue;
        }
        let result;
        let found = { value: undefined };
        try {
            found = readActual(a.source, property, response, ctx);
            result = found.configError ? { passed: false, message: found.configError } : check(a.operator, found, expected, ctx);
        } catch (err) {
            result = { passed: false, message: `Could not evaluate: ${err.message}` };
        }
        let actual = a.source === "schema" && found.value !== undefined ? "(JSON body)" : formatValue(found.value);
        if (found.unit && typeof found.value === "number") actual += found.unit; // "12 ms", "417 bytes"
        out.push({
            ...base,
            label,
            passed: !!result.passed,
            actual,
            expected: shownExpected,
            message: result.passed ? "" : result.message,
            skipped: false
        });
    }
    return out;
}

/** A few sensible default assertions for a response (the editor's "Add suggested" button). */
function suggestAssertions(response) {
    const out = [];
    if (!response || response.error || !response.status) return out;
    out.push(newAssertion("status", "equals", String(response.status)));
    const total = response.timings && typeof response.timings.total === "number" ? response.timings.total : null;
    // 2 s by default; slower endpoints get a limit that the current response passes (rounded up to whole seconds)
    const limit = total !== null && total > 1500 ? Math.ceil((total * 1.5) / 1000) * 1000 : 2000;
    out.push(newAssertion("responseTime", "lt", String(limit)));
    const contentType = String(response.contentType || headerValue(response, "content-type") || "");
    if (/json/i.test(contentType)) out.push(newAssertion("contentType", "contains", "json"));
    else if (contentType) out.push(newAssertion("contentType", "contains", contentType.split(";")[0].trim()));
    const json = responseJson(response);
    if (json.ok && json.value && typeof json.value === "object") {
        if (Array.isArray(json.value)) {
            out.push(newAssertion("jsonpath", "isType", "array", "$"));
            const first = json.value[0];
            if (first && typeof first === "object" && !Array.isArray(first)) {
                for (const key of Object.keys(first).slice(0, 3)) out.push(newAssertion("jsonpath", "exists", "", jsonPathFor("$[0]", key)));
            }
        } else {
            for (const key of Object.keys(json.value).slice(0, 5)) out.push(newAssertion("jsonpath", "exists", "", jsonPathFor("$", key)));
        }
    }
    return out;
}

module.exports = {
    ASSERTION_SOURCES, ASSERTION_OPERATORS, operatorsForSource,
    evaluateAssertions, suggestAssertions, describeAssertion,
    // helpers shared with extract.js / scripts / UI metadata
    responseJson, jsonPathQuery, normalizeJsonPath, jsonPathFor, headerValue, parseRegex, runRegex, formatValue, deepEqual, valuesEqual, toNumber, validateSchema
};
