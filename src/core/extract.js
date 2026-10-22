"use strict";
// Captures: take values out of a response and store them as variables, so later requests can use them
// (login -> capture token -> {{token}} in the next request). Objects and lists are stored as JSON text.
const { responseJson, jsonPathQuery, headerValue, parseRegex, runRegex, formatValue } = require("./assertions");
const { createTimeBudget, isTimeLimit } = require("./limits");

const MAX_SHOWN_VALUE = 1000;

const EXTRACT_SOURCES = [
    { value: "jsonpath", label: "JSON value", needsProperty: true, propertyPlaceholder: "$.data.token", hint: "JSONPath into the JSON body. Objects and lists are saved as JSON text" },
    { value: "header", label: "Header", needsProperty: true, propertyPlaceholder: "Location", hint: "Response header (name not case-sensitive)" },
    { value: "regex", label: "Regex on body", needsProperty: true, propertyPlaceholder: "token=(\\w+)", hint: "Regular expression on the body text; saves the first group, or the whole match" },
    { value: "status", label: "Status code", needsProperty: false, propertyPlaceholder: "", hint: "HTTP status code, e.g. 201" },
    { value: "body", label: "Whole body", needsProperty: false, propertyPlaceholder: "", hint: "The complete response body as text" },
    { value: "cookie", label: "Cookie", needsProperty: true, propertyPlaceholder: "session_id", hint: "Value of a cookie set by this response" }
];

const EXTRACT_SCOPES = [
    { value: "runtime", label: "Runtime", hint: "Kept until the app closes or the run ends (not saved)" },
    { value: "environment", label: "Environment", hint: "Saved in the active environment" },
    { value: "global", label: "Global", hint: "Saved in the globals, visible to every suite" }
];

const SCOPE_NAMES = { runtime: "runtime", environment: "environment", global: "global" };

function cookieValue(response, name) {
    const wanted = String(name ?? "").trim();
    if (!wanted) return undefined;
    const list = Array.isArray(response.cookies) ? response.cookies : [];
    for (let i = list.length - 1; i >= 0; i--) {
        if (list[i] && list[i].name === wanted) return String(list[i].value ?? "");
    }
    // fallback: Set-Cookie headers (when the response did not go through a cookie jar)
    const headers = Array.isArray(response.headers) ? response.headers : [];
    for (let i = headers.length - 1; i >= 0; i--) {
        const [key, value] = headers[i] || [];
        if (String(key).toLowerCase() !== "set-cookie") continue;
        for (const line of String(value).split(/\n/)) {
            const first = line.split(";")[0];
            const eq = first.indexOf("=");
            if (eq > 0 && first.slice(0, eq).trim() === wanted) return first.slice(eq + 1).trim();
        }
    }
    return undefined;
}

/** -> { value } (any JSON value) or { error }. ctx.budget: time budget of the response (limits.js). */
function readCapture(source, property, response, ctx = null) {
    switch (source) {
        case "jsonpath": {
            const json = responseJson(response);
            const q = jsonPathQuery(json.ok ? json.value : undefined, property, ctx);
            if (!q.ok) return { error: q.message };
            if (!json.ok) return { error: json.message };
            return q.count === 0 ? { error: `No match for ${q.path}` } : { value: q.value };
        }
        case "header": {
            if (!String(property ?? "").trim()) return { error: "Enter the header name in Property" };
            const value = headerValue(response, property);
            return value === undefined ? { error: `Header "${String(property).trim()}" is missing` } : { value };
        }
        case "regex": {
            if (!String(property ?? "")) return { error: "Enter a regular expression in Property, e.g. id=(\\d+)" };
            let re;
            try {
                re = parseRegex(property);
            } catch (err) {
                return { error: err.message };
            }
            let m;
            try {
                m = runRegex(re, String(response.bodyText ?? ""), ctx, true);
            } catch (err) {
                if (isTimeLimit(err)) return { error: err.message };
                throw err;
            }
            if (!m) return { error: `No match for ${property}` };
            return { value: m.length > 1 ? (m[1] ?? "") : m[0] };
        }
        case "status":
            return { value: String(response.status ?? "") };
        case "body":
            return { value: String(response.bodyText ?? "") };
        case "cookie": {
            if (!String(property ?? "").trim()) return { error: "Enter the cookie name in Property" };
            const value = cookieValue(response, property);
            return value === undefined ? { error: `Cookie "${String(property).trim()}" was not set by this response` } : { value };
        }
        default:
            return { error: `Unknown capture source "${source}"` };
    }
}

/**
 * Runs the enabled captures and stores the values with scope.set(variable, value, scopeName).
 * -> [{ id, source, variable, scope, value, ok, message }] (value is the stored text, masked when the variable is secret).
 * A failed capture leaves the variable unchanged.
 * options.budget: time budget shared with the assertions of the same response (regex and JSONPath are time limited).
 */
function runExtractions(extractions, response, scope, options = {}) {
    const out = [];
    const ctx = { budget: (options && options.budget) || createTimeBudget() };
    for (const x of Array.isArray(extractions) ? extractions : []) {
        if (!x || typeof x !== "object" || x.enabled === false) continue;
        const variable = String(x.variable ?? "").trim();
        const rawProperty = String(x.property ?? "");
        if (!variable && !rawProperty.trim()) continue; // empty trailing table row
        const scopeName = SCOPE_NAMES[x.scope] || "runtime";
        const base = { id: x.id, source: x.source, variable, scope: scopeName };
        if (!variable) {
            out.push({ ...base, value: "", ok: false, message: "Enter a variable name to store the value in" });
            continue;
        }
        if (!response || response.error) {
            out.push({ ...base, value: "", ok: false, message: "Not captured: no response" });
            continue;
        }
        let property = rawProperty;
        try {
            if (scope && typeof scope.resolve === "function") property = scope.resolve(rawProperty);
        } catch {
            property = rawProperty;
        }
        let found;
        try {
            found = readCapture(x.source, property, response, ctx);
        } catch (err) {
            found = { error: `Could not capture: ${err.message}` };
        }
        if (found.error) {
            out.push({ ...base, value: "", ok: false, message: found.error });
            continue;
        }
        try {
            const stored = scope && typeof scope.set === "function"
                ? scope.set(variable, found.value, scopeName)
                : (typeof found.value === "string" ? found.value : JSON.stringify(found.value) ?? "");
            const secret = scope && typeof scope.isSecret === "function" && scope.isSecret(variable);
            out.push({
                ...base,
                value: secret ? "•••••" : formatValue(stored, MAX_SHOWN_VALUE),
                ok: true,
                message: `Saved as {{${variable}}} (${scopeName})`
            });
        } catch (err) {
            out.push({ ...base, value: "", ok: false, message: err.message });
        }
    }
    return out;
}

module.exports = { EXTRACT_SOURCES, EXTRACT_SCOPES, runExtractions };
