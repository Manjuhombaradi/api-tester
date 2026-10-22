"use strict";
// Variables: {{name}} interpolation over layered scopes plus dynamic {{$...}} values.
//
// Precedence (highest wins): runtime (captured during a session / run) > data row (runner iteration)
// > active environment > folder variables (innermost folder first) > suite variables > globals.
const crypto = require("crypto");

const VAR_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const MAX_DEPTH = 8; // values may reference other variables; stop runaway / circular references

const DYNAMIC_VARIABLES = {
    $guid: { description: "Random UUID v4", fn: () => crypto.randomUUID() },
    $uuid: { description: "Random UUID v4 (same as $guid)", fn: () => crypto.randomUUID() },
    $timestamp: { description: "Unix time in seconds", fn: () => String(Math.floor(Date.now() / 1000)) },
    $timestampMs: { description: "Unix time in milliseconds", fn: () => String(Date.now()) },
    $isoTimestamp: { description: "Current time, ISO 8601 (UTC)", fn: () => new Date().toISOString() },
    $randomInt: { description: "Random integer 0-1000", fn: () => String(Math.floor(Math.random() * 1001)) },
    $randomFloat: { description: "Random number 0-1000 with 2 decimals", fn: () => (Math.random() * 1000).toFixed(2) },
    $randomString: { description: "Random 12 character string [a-z0-9]", fn: () => crypto.randomBytes(9).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x").slice(0, 12) },
    $randomEmail: { description: "Random e-mail address", fn: () => `user.${crypto.randomBytes(4).toString("hex")}@example.com` },
    $randomBoolean: { description: "true or false", fn: () => String(Math.random() < 0.5) }
};

function enabledVars(list) {
    return (Array.isArray(list) ? list : []).filter((v) => v && v.enabled !== false && v.key);
}

/**
 * Creates a variable scope.
 *  globals:     Variable[]                      (workspace wide)
 *  suite:       suite object (uses suite.variables)
 *  parents:     folder objects, outer -> inner (uses folder.variables)
 *  environment: environment object or null (uses environment.variables)
 *  data:        { name: value } of the current data-file row, or null
 *  runtime:     { name: value } object, mutated by set(..., "runtime"); share it between requests to chain them
 * set(..., "environment" | "global") mutates the given environment / globals arrays in place, so the caller can
 * persist them afterwards.
 */
function createScope({ globals = [], suite = null, parents = [], environment = null, data = null, runtime = {} } = {}) {
    const layers = () => [
        // highest first
        { source: "runtime", vars: Object.entries(runtime || {}).map(([key, value]) => ({ key, value })) },
        { source: "data", vars: Object.entries(data || {}).map(([key, value]) => ({ key, value })) },
        { source: "environment", vars: enabledVars(environment?.variables) },
        ...[...parents].reverse().map((f) => ({ source: `folder:${f.name}`, vars: enabledVars(f.variables) })),
        { source: "suite", vars: enabledVars(suite?.variables) },
        { source: "global", vars: enabledVars(globals) }
    ];

    const secretNames = () => {
        const s = new Set();
        for (const list of [globals, suite?.variables, environment?.variables, ...parents.map((p) => p.variables)]) {
            for (const v of enabledVars(list)) if (v.secret) s.add(v.key);
        }
        return s;
    };

    function lookup(name) {
        for (const layer of layers()) {
            const v = layer.vars.find((x) => x.key === name);
            if (v) return { found: true, value: v.value == null ? "" : String(v.value), source: layer.source };
        }
        return { found: false };
    }

    function resolveDetailed(text) {
        const unresolved = new Set();
        const used = new Map();
        const run = (input, depth) => String(input ?? "").replace(VAR_PATTERN, (match, rawName) => {
            const name = rawName.trim();
            if (DYNAMIC_VARIABLES[name]) {
                const value = DYNAMIC_VARIABLES[name].fn();
                used.set(name, { name, value, source: "dynamic" });
                return value;
            }
            const hit = lookup(name);
            if (!hit.found) {
                unresolved.add(name);
                return match;
            }
            used.set(name, { name, value: hit.value, source: hit.source });
            return depth < MAX_DEPTH && hit.value.includes("{{") ? run(hit.value, depth + 1) : hit.value;
        });
        const value = run(text, 0);
        return { value, unresolved: [...unresolved], used: [...used.values()] };
    }

    function setVar(name, value, scope = "runtime") {
        const key = String(name || "").trim();
        if (!key) throw new Error("Variable name is empty");
        const v = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
        const upsert = (list) => {
            const existing = list.find((x) => x.key === key);
            if (existing) { existing.value = v; existing.enabled = true; } else list.push({ key, value: v, enabled: true, secret: false, description: "" });
        };
        if (scope === "environment") {
            if (!environment) throw new Error(`No active environment to store "${key}" in`);
            environment.variables = environment.variables || [];
            upsert(environment.variables);
        } else if (scope === "global") {
            upsert(globals);
        } else {
            runtime[key] = v;
        }
        return v;
    }

    return {
        get: (name) => { const hit = lookup(String(name).trim()); return hit.found ? hit.value : undefined; },
        has: (name) => lookup(String(name).trim()).found,
        set: setVar,
        unset: (name) => { delete runtime[name]; },
        /** Replaces {{vars}}; unknown variables are left as written. */
        resolve: (text) => resolveDetailed(text).value,
        resolveDetailed,
        /** Resolves every string inside a JSON-like value (objects / arrays copied). */
        resolveDeep(value) {
            const walk = (v) => {
                if (typeof v === "string") return resolveDetailed(v).value;
                if (Array.isArray(v)) return v.map(walk);
                if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
                return v;
            };
            return walk(value);
        },
        isSecret: (name) => secretNames().has(name),
        /** Replaces the values of secret variables in a text with ••••• (logs, reports). */
        mask(text) {
            let out = String(text ?? "");
            for (const name of secretNames()) {
                const value = lookup(name).value;
                if (value && value.length >= 3) out = out.split(value).join("•••••");
            }
            return out;
        },
        /** Effective variables, highest precedence wins: [{ key, value, source, secret }]. */
        snapshot() {
            const seen = new Map();
            const secrets = secretNames();
            for (const layer of layers()) {
                for (const v of layer.vars) {
                    if (!seen.has(v.key)) seen.set(v.key, { key: v.key, value: v.value == null ? "" : String(v.value), source: layer.source, secret: secrets.has(v.key) });
                }
            }
            return [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
        },
        runtime,
        environment,
        globals
    };
}

/** Variable names referenced in a text (without dynamic $ variables). */
function referencedVariables(text) {
    const out = new Set();
    for (const m of String(text ?? "").matchAll(VAR_PATTERN)) {
        const name = m[1].trim();
        if (!name.startsWith("$")) out.add(name);
    }
    return [...out];
}

module.exports = { createScope, referencedVariables, DYNAMIC_VARIABLES, VAR_PATTERN };
