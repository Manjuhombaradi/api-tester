"use strict";
// Data model of API Tester: suites, folders, requests, environments, variables, assertions, captures.
// Shared by the core engine, the desktop app and the CLI. Plain JSON objects only (no classes), so
// everything can be saved, exported and sent over IPC as is.
const crypto = require("crypto");

const SUITE_FORMAT = "api-tester-suite";
const SUITE_VERSION = 1;
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const BODY_MODES = ["none", "json", "text", "xml", "form", "multipart", "binary", "graphql"];
const AUTH_TYPES = ["inherit", "none", "basic", "bearer", "apikey", "oauth2"];

/** Short unique id with a prefix: s_ suite, f_ folder, r_ request, e_ environment, a_ assertion, x_ capture. */
function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function newVariable(key = "", value = "", extra = {}) {
    return { key, value: String(value ?? ""), enabled: true, secret: false, description: "", ...extra };
}

function newKeyValue(key = "", value = "", extra = {}) {
    return { key, value: String(value ?? ""), enabled: true, description: "", ...extra };
}

function defaultAuth(type = "inherit") {
    return {
        type,
        basic: { username: "", password: "" },
        bearer: { token: "" },
        apikey: { key: "X-API-Key", value: "", in: "header" },
        oauth2: { grantType: "client_credentials", tokenUrl: "", clientId: "", clientSecret: "", scope: "", audience: "", username: "", password: "", clientAuth: "body" }
    };
}

function defaultBody(mode = "none") {
    return { mode, raw: "", form: [], multipart: [], binaryPath: "", graphql: { query: "", variables: "" } };
}

function newAssertion(source = "status", operator = "equals", expected = "200", property = "") {
    return { id: newId("a"), enabled: true, source, property, operator, expected: String(expected ?? "") };
}

function newExtraction(source = "jsonpath", property = "", variable = "", scope = "runtime") {
    return { id: newId("x"), enabled: true, source, property, variable, scope };
}

function newRequest(name = "New Request", extra = {}) {
    return {
        id: newId("r"),
        type: "request",
        name,
        description: "",
        method: "GET",
        url: "",
        params: [],
        headers: [],
        auth: defaultAuth("inherit"),
        body: defaultBody("none"),
        assertions: [],
        extract: [],
        scripts: { pre: "", post: "" },
        settings: { timeoutMs: null, followRedirects: null, verifyTls: null },
        ...extra
    };
}

function newFolder(name = "New Folder", extra = {}) {
    return { id: newId("f"), type: "folder", name, description: "", auth: defaultAuth("inherit"), headers: [], variables: [], items: [], ...extra };
}

function newEnvironment(name = "Default", variables = []) {
    return { id: newId("e"), name, variables };
}

function newSuite(name = "New Suite", extra = {}) {
    return {
        format: SUITE_FORMAT,
        version: SUITE_VERSION,
        id: newId("s"),
        name,
        description: "",
        variables: [],
        auth: defaultAuth("none"),
        headers: [],
        environments: [],
        activeEnvironmentId: null,
        items: [],
        ...extra
    };
}

// ------------------------------------------------------------------ normalisation (files may be hand-written or old)

function str(v, d = "") {
    return v === undefined || v === null ? d : String(v);
}

function normVars(list) {
    return (Array.isArray(list) ? list : []).filter((v) => v && typeof v === "object").map((v) => ({
        key: str(v.key), value: str(v.value), enabled: v.enabled !== false, secret: !!v.secret, description: str(v.description)
    }));
}

function normKeyValues(list) {
    return (Array.isArray(list) ? list : []).filter((v) => v && typeof v === "object").map((v) => ({
        key: str(v.key), value: str(v.value), enabled: v.enabled !== false, description: str(v.description)
    }));
}

function normAuth(auth, fallbackType) {
    const d = defaultAuth(fallbackType);
    if (!auth || typeof auth !== "object") return d;
    const type = AUTH_TYPES.includes(auth.type) ? auth.type : fallbackType;
    return {
        type,
        basic: { ...d.basic, ...(auth.basic || {}) },
        bearer: { ...d.bearer, ...(auth.bearer || {}) },
        apikey: { ...d.apikey, ...(auth.apikey || {}) },
        oauth2: { ...d.oauth2, ...(auth.oauth2 || {}) }
    };
}

function normBody(body) {
    const d = defaultBody();
    if (!body || typeof body !== "object") return d;
    return {
        mode: BODY_MODES.includes(body.mode) ? body.mode : "none",
        raw: str(body.raw),
        form: normKeyValues(body.form),
        multipart: (Array.isArray(body.multipart) ? body.multipart : []).filter(Boolean).map((p) => ({
            key: str(p.key), type: p.type === "file" ? "file" : "text", value: str(p.value), filePath: str(p.filePath),
            contentType: str(p.contentType), enabled: p.enabled !== false
        })),
        binaryPath: str(body.binaryPath),
        graphql: { query: str(body.graphql?.query), variables: str(body.graphql?.variables) }
    };
}

function normItem(item, ids) {
    if (!item || typeof item !== "object") return null;
    const uniqueId = (id, prefix) => {
        let v = typeof id === "string" && id ? id : newId(prefix);
        if (ids.has(v)) v = newId(prefix); // duplicated ids (copy/paste in files) would break selection
        ids.add(v);
        return v;
    };
    if (item.type === "folder" || Array.isArray(item.items)) {
        return {
            id: uniqueId(item.id, "f"),
            type: "folder",
            name: str(item.name, "Folder"),
            description: str(item.description),
            auth: normAuth(item.auth, "inherit"),
            headers: normKeyValues(item.headers),
            variables: normVars(item.variables),
            items: (item.items || []).map((i) => normItem(i, ids)).filter(Boolean)
        };
    }
    const method = str(item.method, "GET").toUpperCase();
    return {
        id: uniqueId(item.id, "r"),
        type: "request",
        name: str(item.name, "Request"),
        description: str(item.description),
        method: method || "GET",
        url: str(item.url),
        params: normKeyValues(item.params),
        headers: normKeyValues(item.headers),
        auth: normAuth(item.auth, "inherit"),
        body: normBody(item.body),
        assertions: (Array.isArray(item.assertions) ? item.assertions : []).filter(Boolean).map((a) => ({
            id: typeof a.id === "string" && a.id ? a.id : newId("a"),
            enabled: a.enabled !== false, source: str(a.source, "status"), property: str(a.property),
            operator: str(a.operator, "equals"), expected: str(a.expected)
        })),
        extract: (Array.isArray(item.extract) ? item.extract : []).filter(Boolean).map((x) => ({
            id: typeof x.id === "string" && x.id ? x.id : newId("x"),
            enabled: x.enabled !== false, source: str(x.source, "jsonpath"), property: str(x.property),
            variable: str(x.variable), scope: ["runtime", "environment", "global"].includes(x.scope) ? x.scope : "runtime"
        })),
        scripts: { pre: str(item.scripts?.pre), post: str(item.scripts?.post) },
        settings: {
            timeoutMs: item.settings?.timeoutMs == null || item.settings.timeoutMs === "" ? null : Number(item.settings.timeoutMs),
            followRedirects: typeof item.settings?.followRedirects === "boolean" ? item.settings.followRedirects : null,
            verifyTls: typeof item.settings?.verifyTls === "boolean" ? item.settings.verifyTls : null
        }
    };
}

/** Validates and fills defaults; throws a readable Error when the object is not a suite at all. */
function normalizeSuite(obj) {
    if (!obj || typeof obj !== "object") throw new Error("Not a suite: expected a JSON object");
    if (obj.format && obj.format !== SUITE_FORMAT) throw new Error(`Not an API Tester suite (format "${obj.format}")`);
    if (!Array.isArray(obj.items)) throw new Error("Not an API Tester suite: \"items\" list is missing");
    const ids = new Set();
    const environments = (Array.isArray(obj.environments) ? obj.environments : []).filter(Boolean).map((e) => ({
        id: typeof e.id === "string" && e.id ? e.id : newId("e"), name: str(e.name, "Environment"), variables: normVars(e.variables)
    }));
    const activeEnvironmentId = environments.some((e) => e.id === obj.activeEnvironmentId) ? obj.activeEnvironmentId : (environments[0]?.id || null);
    return {
        format: SUITE_FORMAT,
        version: SUITE_VERSION,
        id: typeof obj.id === "string" && obj.id ? obj.id : newId("s"),
        name: str(obj.name, "Suite"),
        description: str(obj.description),
        variables: normVars(obj.variables),
        auth: normAuth(obj.auth, "none"),
        headers: normKeyValues(obj.headers),
        environments,
        activeEnvironmentId,
        items: obj.items.map((i) => normItem(i, ids)).filter(Boolean)
    };
}

// ------------------------------------------------------------------ tree helpers

/** Calls fn(item, parents) for every folder and request (depth first). parents: folders outer -> inner. */
function walkItems(items, fn, parents = []) {
    for (const item of items || []) {
        if (fn(item, parents) === false) return false;
        if (item.type === "folder" && walkItems(item.items, fn, [...parents, item]) === false) return false;
    }
    return true;
}

/** -> { item, parents (outer -> inner folders), list (array containing the item), index } or null. */
function findItem(suite, id) {
    let found = null;
    const visit = (list, parents) => {
        for (let i = 0; i < list.length; i++) {
            const item = list[i];
            if (item.id === id) { found = { item, parents, list, index: i }; return true; }
            if (item.type === "folder" && visit(item.items, [...parents, item])) return true;
        }
        return false;
    };
    visit(suite.items || [], []);
    return found;
}

/** All requests below the given item ids (folders expand to their requests), in tree order. */
function collectRequests(suite, itemIds) {
    const out = [];
    const wanted = itemIds && itemIds.length ? new Set(itemIds) : null;
    walkItems(suite.items, (item, parents) => {
        if (item.type !== "request") return;
        if (!wanted || wanted.has(item.id) || parents.some((p) => wanted.has(p.id))) out.push({ request: item, parents });
    });
    return out;
}

/** Deep copy with fresh ids (duplicate / paste). */
function cloneWithNewIds(item) {
    const copy = JSON.parse(JSON.stringify(item));
    const remap = (i) => {
        i.id = newId(i.type === "folder" ? "f" : "r");
        for (const a of i.assertions || []) a.id = newId("a");
        for (const x of i.extract || []) x.id = newId("x");
        (i.items || []).forEach(remap);
    };
    remap(copy);
    return copy;
}

module.exports = {
    SUITE_FORMAT, SUITE_VERSION, HTTP_METHODS, BODY_MODES, AUTH_TYPES,
    newId, newVariable, newKeyValue, defaultAuth, defaultBody, newAssertion, newExtraction,
    newRequest, newFolder, newEnvironment, newSuite,
    normalizeSuite, walkItems, findItem, collectRequests, cloneWithNewIds
};
