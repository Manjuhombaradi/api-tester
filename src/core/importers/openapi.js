"use strict";
// OpenAPI 3.0 / 3.1 and Swagger 2.0 importer (already parsed from JSON or YAML).
// servers -> {{baseUrl}} (one environment per server when there are several), tags -> folders,
// operations -> requests (path parameters as {{name}} suite variables, query / header parameters, an example
// body from examples or schemas), a status assertion from the first 2xx response (plus a disabled JSON Schema
// assertion for JSON responses), security schemes -> auth with {{credential}} variables to fill in.
const model = require("../model");
const { text, listNames, plural } = require("./common");

const OPERATION_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const SKIPPED_HEADERS = new Set(["accept", "content-type", "authorization"]);
const MAX_PROPERTIES = 60;
const MAX_DEPTH = 8;
const MAX_SCHEMA_TEXT = 20000;
// Node budgets per generated example / schema: big APIs reuse the same schemas in many branches, which can
// grow exponentially even without circular references.
const EXAMPLE_BUDGET = 1500;
const SCHEMA_BUDGET = 3000;
const SAMPLE_UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

// Formats ajv-formats knows; other formats are dropped from schema assertions (they would fail to compile).
const KNOWN_FORMATS = new Set(["date", "time", "date-time", "iso-time", "iso-date-time", "duration", "uri", "uri-reference", "uri-template",
    "url", "email", "hostname", "ipv4", "ipv6", "regex", "uuid", "json-pointer", "json-pointer-uri-fragment", "relative-json-pointer",
    "byte", "int32", "int64", "float", "double", "password", "binary"]);
const STRING_EXAMPLES = {
    "date-time": "2026-01-01T12:00:00Z", date: "2026-01-01", time: "12:00:00", email: "user@example.com", uuid: SAMPLE_UUID,
    uri: "https://example.com", url: "https://example.com", hostname: "example.com", ipv4: "192.168.1.10", ipv6: "::1",
    byte: "U3dhZ2dlciByb2Nrcw==", password: "secret", binary: ""
};

function isOpenApi(obj) {
    return !!obj && typeof obj === "object" && !Array.isArray(obj) && obj.openapi !== undefined && /^3(\.|$)/.test(String(obj.openapi));
}

function isSwagger(obj) {
    return !!obj && typeof obj === "object" && !Array.isArray(obj) && obj.swagger !== undefined && /^2(\.0)?$/.test(String(obj.swagger));
}

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isJsonType = (t) => /^application\/(?:[\w.+-]+\+)?json\b|^application\/json/i.test(t) || /\+json\b/i.test(t);

// ------------------------------------------------------------------ $ref handling

function resolveRef(ctx, ref) {
    if (typeof ref !== "string") return undefined;
    if (!ref.startsWith("#")) {
        ctx.externalRefs.add(ref.split("#")[0] || ref);
        return undefined;
    }
    let cur = ctx.doc;
    for (const raw of ref.slice(1).split("/").slice(1)) {
        const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
        if (cur && typeof cur === "object" && Object.prototype.hasOwnProperty.call(cur, key)) cur = cur[key];
        else {
            ctx.brokenRefs.add(ref);
            return undefined;
        }
    }
    return cur;
}

/** Follows $ref chains of parameters, request bodies, responses, examples, path items. */
function deref(ctx, obj) {
    let cur = obj;
    for (let i = 0; i < 20 && isPlainObject(cur) && typeof cur.$ref === "string"; i++) {
        const { $ref, ...rest } = cur;
        const target = resolveRef(ctx, $ref);
        cur = isPlainObject(target) ? { ...target, ...rest } : Object.keys(rest).length ? rest : undefined;
    }
    return cur;
}

// ------------------------------------------------------------------ examples from schemas

/** An example value for a schema (Swagger UI style). direction "request" skips readOnly, "response" writeOnly. */
function exampleFromSchema(ctx, schema, direction = "request", depth = 0, stack = new Set()) {
    if (depth === 0) ctx.exampleBudget = EXAMPLE_BUDGET;
    if (!isPlainObject(schema) || --ctx.exampleBudget < 0) return undefined;
    if (typeof schema.$ref === "string") {
        if (stack.has(schema.$ref) || depth > MAX_DEPTH) return undefined; // circular
        const { $ref, ...rest } = schema;
        const target = resolveRef(ctx, $ref);
        const next = new Set(stack).add($ref);
        return exampleFromSchema(ctx, isPlainObject(target) ? { ...target, ...rest } : rest, direction, depth + 1, next);
    }
    if (schema.example !== undefined) return schema.example;
    if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
    if (schema.default !== undefined) return schema.default;
    if (schema.const !== undefined) return schema.const;
    if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum.find((v) => v !== null) ?? schema.enum[0];
    if (depth > MAX_DEPTH) return undefined;

    const sub = (s) => exampleFromSchema(ctx, s, direction, depth + 1, stack);
    if (Array.isArray(schema.allOf) && schema.allOf.length) {
        const { allOf, ...rest } = schema;
        const parts = [...allOf, rest].map(sub).filter((v) => v !== undefined);
        const objects = parts.filter(isPlainObject);
        return objects.length ? Object.assign({}, ...objects) : parts[0];
    }
    const choices = schema.oneOf || schema.anyOf;
    if (Array.isArray(choices) && choices.length) {
        const { oneOf, anyOf, ...rest } = schema;
        const first = sub(choices.find((c) => !(isPlainObject(c) && c.type === "null")) || choices[0]);
        const own = Object.keys(rest).length ? sub(rest) : undefined;
        return isPlainObject(first) && isPlainObject(own) ? { ...own, ...first } : first !== undefined ? first : own;
    }

    let type = Array.isArray(schema.type) ? (schema.type.find((t) => t !== "null") || "null") : schema.type;
    if (!type) {
        if (schema.properties || schema.additionalProperties) type = "object";
        else if (schema.items) type = "array";
    }
    switch (type) {
        case "object": {
            const out = {};
            for (const [key, propSchema] of Object.entries(schema.properties || {}).slice(0, MAX_PROPERTIES)) {
                const resolved = isPlainObject(propSchema) && propSchema.$ref ? { ...(resolveRef(ctx, propSchema.$ref) || {}), ...propSchema } : propSchema || {};
                if (direction === "request" && resolved.readOnly) continue;
                if (direction === "response" && resolved.writeOnly) continue;
                const value = sub(propSchema);
                if (value !== undefined) out[key] = value;
            }
            if (!schema.properties && isPlainObject(schema.additionalProperties)) {
                const value = sub(schema.additionalProperties);
                if (value !== undefined) out.additionalProp1 = value;
            }
            return out;
        }
        case "array": {
            const item = sub(schema.items);
            return item === undefined ? [] : [item];
        }
        case "string":
            return Object.prototype.hasOwnProperty.call(STRING_EXAMPLES, schema.format) ? STRING_EXAMPLES[schema.format] : "string";
        case "integer":
        case "number":
            return typeof schema.minimum === "number" ? schema.minimum : 0;
        case "boolean":
            return true;
        case "null":
            return null;
        default:
            return undefined;
    }
}

/** OpenAPI schema -> plain JSON Schema (draft-07) for a "matches schema" assertion; ctx.schemaTooBig when it got too large. */
function toJsonSchema(ctx, schema, depth = 0, stack = new Set()) {
    if (depth === 0) { ctx.schemaBudget = SCHEMA_BUDGET; ctx.schemaTooBig = false; }
    if (--ctx.schemaBudget < 0) { ctx.schemaTooBig = true; return {}; }
    if (!isPlainObject(schema)) return {};
    if (typeof schema.$ref === "string") {
        if (stack.has(schema.$ref)) return {}; // circular: accept anything below this point
        const { $ref, ...rest } = schema;
        const target = resolveRef(ctx, $ref);
        if (!isPlainObject(target)) return {};
        return toJsonSchema(ctx, { ...target, ...rest }, depth + 1, new Set(stack).add($ref));
    }
    if (depth > 12) return {};
    const conv = (s) => toJsonSchema(ctx, s, depth + 1, stack);
    const out = {};
    let types = Array.isArray(schema.type) ? schema.type.slice() : schema.type ? [schema.type] : [];
    types = types.filter((t) => ["string", "number", "integer", "boolean", "object", "array", "null"].includes(t));
    if (schema.nullable === true && types.length && !types.includes("null")) types.push("null");
    if (types.length) out.type = types.length === 1 ? types[0] : types;
    if (Array.isArray(schema.enum)) out.enum = schema.nullable === true && !schema.enum.includes(null) ? [...schema.enum, null] : schema.enum;
    if (schema.const !== undefined) out.const = schema.const;
    for (const k of ["minimum", "maximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties"]) {
        if (typeof schema[k] === "number" || typeof schema[k] === "boolean") out[k] = schema[k];
    }
    // OpenAPI 3.0 uses boolean exclusiveMinimum / exclusiveMaximum next to minimum / maximum.
    if (typeof schema.exclusiveMinimum === "number") out.exclusiveMinimum = schema.exclusiveMinimum;
    else if (schema.exclusiveMinimum === true && typeof schema.minimum === "number") { out.exclusiveMinimum = schema.minimum; delete out.minimum; }
    if (typeof schema.exclusiveMaximum === "number") out.exclusiveMaximum = schema.exclusiveMaximum;
    else if (schema.exclusiveMaximum === true && typeof schema.maximum === "number") { out.exclusiveMaximum = schema.maximum; delete out.maximum; }
    if (typeof schema.pattern === "string") {
        try { new RegExp(schema.pattern, "u"); out.pattern = schema.pattern; } catch { /* not a JavaScript regex: skip */ }
    }
    if (typeof schema.format === "string" && KNOWN_FORMATS.has(schema.format)) out.format = schema.format;
    if (isPlainObject(schema.properties)) {
        out.properties = {};
        const writeOnly = new Set();
        for (const [k, s] of Object.entries(schema.properties)) {
            const resolved = isPlainObject(s) && s.$ref ? resolveRef(ctx, s.$ref) || {} : s || {};
            if (resolved.writeOnly) { writeOnly.add(k); continue; }
            out.properties[k] = conv(s);
        }
        if (Array.isArray(schema.required)) {
            const required = schema.required.filter((k) => !writeOnly.has(k));
            if (required.length) out.required = required;
        }
    } else if (Array.isArray(schema.required) && schema.required.length) {
        out.required = schema.required.slice();
    }
    if (isPlainObject(schema.items)) out.items = conv(schema.items);
    if (typeof schema.additionalProperties === "boolean") out.additionalProperties = schema.additionalProperties;
    else if (isPlainObject(schema.additionalProperties)) out.additionalProperties = conv(schema.additionalProperties);
    for (const k of ["allOf", "anyOf", "oneOf"]) if (Array.isArray(schema[k]) && schema[k].length) out[k] = schema[k].map(conv);
    if (isPlainObject(schema.not)) out.not = conv(schema.not);
    return out;
}

// ------------------------------------------------------------------ parameters, bodies, auth

function valueText(v) {
    if (v === undefined || v === null) return "";
    if (Array.isArray(v)) return v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(",");
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
}

/** Example value of a parameter (OpenAPI 3: example / examples / schema; Swagger 2: x-example / default / enum on the parameter). */
function parameterValue(ctx, p) {
    if (p.example !== undefined) return p.example;
    if (isPlainObject(p.examples)) {
        const first = deref(ctx, Object.values(p.examples)[0]);
        if (first && first.value !== undefined) return first.value;
    }
    if (p["x-example"] !== undefined) return p["x-example"];
    const schema = p.schema ? deref(ctx, p.schema) || {} : p;
    if (schema.example !== undefined) return schema.example;
    if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
    if (schema.default !== undefined) return schema.default;
    if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
    const items = schema.items ? deref(ctx, schema.items) || {} : null;
    if (items && Array.isArray(items.enum) && items.enum.length) return items.enum[0];
    if (items && items.default !== undefined) return items.default;
    return undefined;
}

function parameterType(ctx, p) {
    const schema = p.schema ? deref(ctx, p.schema) || {} : p;
    const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
    return { type: type || "", format: schema.format || "" };
}

function parameterDescription(ctx, p) {
    const { type, format } = parameterType(ctx, p);
    const bits = [];
    if (p.required) bits.push("Required.");
    if (p.description) bits.push(String(p.description).trim());
    if (type) bits.push(`(${type}${format ? `, ${format}` : ""})`);
    return bits.join(" ");
}

/** Merges path-level and operation-level parameters (operation wins for the same name + in). */
function mergedParameters(ctx, pathItem, op) {
    const map = new Map();
    for (const list of [pathItem.parameters, op.parameters]) {
        for (const raw of Array.isArray(list) ? list : []) {
            const p = deref(ctx, raw);
            if (!isPlainObject(p) || !p.name || !p.in) continue;
            map.set(`${p.in}:${p.name}`, p);
        }
    }
    return [...map.values()];
}

function addVariable(ctx, key, value, extra = {}) {
    if (ctx.variables.has(key)) return ctx.variables.get(key);
    const v = model.newVariable(key, value, extra);
    ctx.variables.set(key, v);
    return v;
}

function mediaExample(ctx, media) {
    if (!isPlainObject(media)) return undefined;
    if (media.example !== undefined) return media.example;
    if (isPlainObject(media.examples)) {
        for (const ex of Object.values(media.examples)) {
            const e = deref(ctx, ex);
            if (e && e.value !== undefined) return e.value;
        }
    }
    return undefined;
}

function pickMediaType(types) {
    return types.find((t) => /^application\/json\b/i.test(t)) || types.find(isJsonType) ||
        types.find((t) => /x-www-form-urlencoded/i.test(t)) || types.find((t) => /multipart\/form-data/i.test(t)) ||
        types.find((t) => /xml/i.test(t)) || types.find((t) => /^text\//i.test(t)) || types[0];
}

/** Object schema -> [{ key, schema, required }] (allOf merged). */
function objectProperties(ctx, schema, depth = 0) {
    const s = deref(ctx, schema);
    if (!isPlainObject(s) || depth > 5) return [];
    const out = [];
    for (const part of Array.isArray(s.allOf) ? s.allOf : []) out.push(...objectProperties(ctx, part, depth + 1));
    const required = new Set(Array.isArray(s.required) ? s.required : []);
    for (const [key, propSchema] of Object.entries(s.properties || {}).slice(0, MAX_PROPERTIES)) {
        const resolved = deref(ctx, propSchema) || {};
        if (resolved.readOnly) continue;
        out.push({ key, schema: resolved, required: required.has(key) });
    }
    return out;
}

const isFileSchema = (s) => isPlainObject(s) && ((s.type === "string" && ["binary", "base64"].includes(s.format)) || s.type === "file" ||
    (s.type === "array" && isPlainObject(s.items) && s.items.type === "string" && s.items.format === "binary") || typeof s.contentMediaType === "string");

/** Example value -> pretty JSON body text (an example written as a JSON string is used as is, not quoted again). */
function jsonBodyText(value) {
    if (value === undefined) return "{}";
    if (typeof value === "string" && /^\s*[{[]/.test(value)) {
        try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
    }
    return JSON.stringify(value, null, 2);
}

/** -> { body, headers: KV[] } for an OpenAPI 3 requestBody. */
function bodyFromRequestBody(ctx, requestBody) {
    const rb = deref(ctx, requestBody);
    const body = model.defaultBody("none");
    if (!isPlainObject(rb) || !isPlainObject(rb.content) || !Object.keys(rb.content).length) return { body, headers: [] };
    const types = Object.keys(rb.content);
    const type = pickMediaType(types);
    const media = rb.content[type] || {};
    const headers = [];
    const example = mediaExample(ctx, media);
    if (isJsonType(type)) {
        const value = example !== undefined ? example : exampleFromSchema(ctx, media.schema, "request");
        if (!/^application\/json\s*$/i.test(type)) headers.push(model.newKeyValue("Content-Type", type));
        return { body: { ...body, mode: "json", raw: jsonBodyText(value) }, headers };
    }
    if (/x-www-form-urlencoded|multipart\/form-data/i.test(type)) {
        const values = isPlainObject(example) ? example : {};
        const props = objectProperties(ctx, media.schema);
        if (/x-www-form-urlencoded/i.test(type)) {
            body.mode = "form";
            body.form = props.map((p) => {
                const value = valueText(values[p.key] !== undefined ? values[p.key] : exampleFromSchema(ctx, p.schema, "request"));
                return model.newKeyValue(p.key, value, { enabled: p.required || value !== "", description: p.schema.description || "" });
            });
        } else {
            body.mode = "multipart";
            body.multipart = props.map((p) => {
                const file = isFileSchema(p.schema);
                const value = file ? "" : valueText(values[p.key] !== undefined ? values[p.key] : exampleFromSchema(ctx, p.schema, "request"));
                if (file) ctx.fileFields++;
                return { key: p.key, type: file ? "file" : "text", value, filePath: "", contentType: "", enabled: !file && (p.required || value !== "") };
            });
        }
        return { body, headers };
    }
    if (/xml/i.test(type)) {
        if (!/^application\/xml\s*$/i.test(type)) headers.push(model.newKeyValue("Content-Type", type));
        return { body: { ...body, mode: "xml", raw: typeof example === "string" ? example : "" }, headers };
    }
    if (/^text\//i.test(type)) {
        if (!/^text\/plain\s*$/i.test(type)) headers.push(model.newKeyValue("Content-Type", type));
        return { body: { ...body, mode: "text", raw: typeof example === "string" ? example : valueText(example) }, headers };
    }
    // application/octet-stream, images, ...: the user picks a file.
    if (!/^application\/octet-stream\s*$/i.test(type)) headers.push(model.newKeyValue("Content-Type", type));
    ctx.fileFields++;
    return { body: { ...body, mode: "binary" }, headers };
}

/** Swagger 2: body / formData parameters -> { body, headers }. */
function bodyFromSwaggerParameters(ctx, params, consumes) {
    const body = model.defaultBody("none");
    const headers = [];
    const bodyParam = params.find((p) => p.in === "body");
    const formParams = params.filter((p) => p.in === "formData");
    if (bodyParam) {
        const type = pickMediaType(consumes.length ? consumes : ["application/json"]);
        const schema = bodyParam.schema || {};
        const example = bodyParam["x-example"] !== undefined ? bodyParam["x-example"] : exampleFromSchema(ctx, schema, "request");
        if (/xml/i.test(type)) {
            if (!/^application\/xml\s*$/i.test(type)) headers.push(model.newKeyValue("Content-Type", type));
            return { body: { ...body, mode: "xml", raw: typeof example === "string" ? example : "" }, headers };
        }
        if (!isJsonType(type) && /^text\//i.test(type)) {
            headers.push(model.newKeyValue("Content-Type", type));
            return { body: { ...body, mode: "text", raw: valueText(example) }, headers };
        }
        if (isJsonType(type) && !/^application\/json\s*$/i.test(type)) headers.push(model.newKeyValue("Content-Type", type));
        return { body: { ...body, mode: "json", raw: jsonBodyText(example) }, headers };
    }
    if (formParams.length) {
        const multipart = formParams.some((p) => p.type === "file") || consumes.some((t) => /multipart\/form-data/i.test(t));
        if (multipart) {
            body.mode = "multipart";
            body.multipart = formParams.map((p) => {
                const file = p.type === "file";
                if (file) ctx.fileFields++;
                const value = file ? "" : valueText(parameterValue(ctx, p));
                return { key: p.name, type: file ? "file" : "text", value, filePath: "", contentType: "", enabled: !file && (!!p.required || value !== "") };
            });
        } else {
            body.mode = "form";
            body.form = formParams.map((p) => {
                const value = valueText(parameterValue(ctx, p));
                return model.newKeyValue(p.name, value, { enabled: !!p.required || value !== "", description: parameterDescription(ctx, p) });
            });
        }
    }
    return { body, headers };
}

function credentialVariable(ctx, key, secret, description) {
    addVariable(ctx, key, "", { secret, description });
    ctx.credentials.add(key);
    return `{{${key}}}`;
}

/** A security scheme -> { auth, headers } (headers for cookie API keys). */
function authFromScheme(ctx, schemeName, scopes) {
    const auth = model.defaultAuth("none");
    const scheme = deref(ctx, ctx.securitySchemes[schemeName]);
    if (!isPlainObject(scheme)) {
        ctx.unsupportedAuth.push(schemeName);
        return { auth, headers: [] };
    }
    const type = String(scheme.type || "");
    const httpScheme = String(scheme.scheme || "").toLowerCase();
    if ((type === "http" && httpScheme === "basic") || type === "basic") {
        auth.type = "basic";
        auth.basic = {
            username: credentialVariable(ctx, "username", false, "User name for Basic auth"),
            password: credentialVariable(ctx, "password", true, "Password for Basic auth")
        };
        return { auth, headers: [] };
    }
    if (type === "http" && httpScheme === "bearer") {
        auth.type = "bearer";
        auth.bearer = { token: credentialVariable(ctx, "token", true, `Bearer token${scheme.bearerFormat ? ` (${scheme.bearerFormat})` : ""}`) };
        return { auth, headers: [] };
    }
    if (type === "apiKey") {
        const where = String(scheme.in || "header");
        const variable = credentialVariable(ctx, schemeName, true, `API key (${where} "${scheme.name}")`);
        if (where === "cookie") return { auth, headers: [model.newKeyValue("Cookie", `${scheme.name}=${variable}`)] };
        auth.type = "apikey";
        auth.apikey = { key: text(scheme.name) || "X-API-Key", value: variable, in: where === "query" ? "query" : "header" };
        return { auth, headers: [] };
    }
    if (type === "oauth2") {
        const flows = scheme.flows || {};
        const cc = flows.clientCredentials || (scheme.flow === "application" ? scheme : null);
        const pw = flows.password || (scheme.flow === "password" ? scheme : null);
        const flow = cc || pw;
        if (flow && flow.tokenUrl) {
            const tokenUrl = String(flow.tokenUrl).startsWith("/") ? `{{baseUrl}}${flow.tokenUrl}` : String(flow.tokenUrl);
            auth.type = "oauth2";
            auth.oauth2 = {
                ...auth.oauth2,
                grantType: cc ? "client_credentials" : "password",
                tokenUrl,
                clientId: credentialVariable(ctx, "clientId", false, "OAuth 2.0 client id"),
                clientSecret: credentialVariable(ctx, "clientSecret", true, "OAuth 2.0 client secret"),
                scope: (Array.isArray(scopes) ? scopes : []).join(" "),
                username: cc ? "" : credentialVariable(ctx, "username", false, "User name for the OAuth 2.0 password grant"),
                password: cc ? "" : credentialVariable(ctx, "password", true, "Password for the OAuth 2.0 password grant"),
                clientAuth: "body"
            };
            return { auth, headers: [] };
        }
    }
    if (type === "oauth2" || type === "openIdConnect") {
        // Browser based flows cannot run here: send a token the user pastes.
        auth.type = "bearer";
        auth.bearer = { token: credentialVariable(ctx, "accessToken", true, "Access token (get one from your identity provider)") };
        ctx.browserFlows.push(schemeName);
        return { auth, headers: [] };
    }
    ctx.unsupportedAuth.push(`${schemeName} (${type}${httpScheme ? ` ${httpScheme}` : ""})`);
    return { auth, headers: [] };
}

/** The requirement that is used: the first non-empty one (an empty {} only means "anonymous is allowed"). */
function firstRequirement(requirements) {
    return (Array.isArray(requirements) ? requirements : []).find((r) => isPlainObject(r) && Object.keys(r).length) || null;
}

/** A security requirement list -> { auth, headers } ([] means no auth). */
function authFromRequirements(ctx, requirements) {
    const first = firstRequirement(requirements);
    if (!first) return { auth: model.defaultAuth("none"), headers: [] };
    const names = Object.keys(first);
    if (names.length > 1) ctx.multiSchemes.add(names.join(" + "));
    return authFromScheme(ctx, names[0], first[names[0]]);
}

// ------------------------------------------------------------------ servers

function serverUrl(server) {
    let url = text(server && server.url) || "/";
    for (const [name, v] of Object.entries((server && server.variables) || {})) {
        const value = v && (v.default !== undefined ? v.default : Array.isArray(v.enum) ? v.enum[0] : "");
        url = url.split(`{${name}}`).join(text(value));
    }
    return url.replace(/\/+$/, "");
}

/** -> { baseUrls: [{ name, url }], warning } */
function baseUrls(ctx) {
    const doc = ctx.doc;
    if (ctx.swagger) {
        const schemes = Array.isArray(doc.schemes) ? doc.schemes : [];
        const scheme = schemes.includes("https") ? "https" : schemes[0] || "https";
        const basePath = text(doc.basePath).replace(/\/+$/, "");
        if (!doc.host) {
            ctx.warnings.push(`The file has no host: set {{baseUrl}} to the API address (now http://localhost${basePath}).`);
            return [{ name: "Server", url: `http://localhost${basePath}` }];
        }
        return [{ name: doc.host, url: `${scheme}://${doc.host}${basePath}` }];
    }
    const servers = (Array.isArray(doc.servers) ? doc.servers : []).filter(isPlainObject);
    if (!servers.length) {
        ctx.warnings.push("The file has no server address: set {{baseUrl}} to the API address (now http://localhost).");
        return [{ name: "Server", url: "http://localhost" }];
    }
    return servers.slice(0, 10).map((s, i) => {
        let url = serverUrl(s);
        if (url.startsWith("//")) url = `https:${url}`;
        else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith("{{")) {
            const fixed = `http://localhost${url.startsWith("/") ? url : `/${url}`}`.replace(/\/+$/, "");
            if (i === 0) ctx.warnings.push(`The server address "${s.url}" is relative: set {{baseUrl}} to the full address (now ${fixed}).`);
            url = fixed;
        }
        let name = text(s.description).trim() || url.replace(/^[a-z]+:\/\//i, "");
        if (name.length > 60) name = `${name.slice(0, 57)}...`;
        return { name, url };
    });
}

// ------------------------------------------------------------------ operations

function successResponse(ctx, responses) {
    if (!isPlainObject(responses)) return null;
    for (const code of Object.keys(responses)) {
        if (/^2\d\d$/.test(code) || /^2xx$/i.test(code)) return { code, response: deref(ctx, responses[code]) || {} };
    }
    return null;
}

function operationToRequest(ctx, path, method, pathItem, op) {
    const upper = method.toUpperCase();
    const params = mergedParameters(ctx, pathItem, op);
    let name = text(op.summary).trim() || text(op.operationId).trim() || `${upper} ${path}`;
    if (name.length > 120) name = `${name.slice(0, 117)}...`;
    const descParts = [];
    if (op.deprecated) descParts.push("Deprecated.");
    if (op.description) descParts.push(String(op.description).trim());
    else if (op.summary && op.operationId) descParts.push(`Operation ${op.operationId}.`);

    // URL: {{baseUrl}} + path with {param} -> {{param}}; an operation / path level server replaces {{baseUrl}}.
    const ownServers = !ctx.swagger && ((Array.isArray(op.servers) && op.servers.length && op.servers) || (Array.isArray(pathItem.servers) && pathItem.servers.length && pathItem.servers));
    const base = ownServers ? serverUrl(ownServers[0]) : "{{baseUrl}}";
    const url = base + path.replace(/\{([^{}]+)\}/g, "{{$1}}");

    // Path template names without a declared parameter still need a variable.
    const declared = new Set(params.filter((x) => x.in === "path").map((x) => x.name));
    for (const m of path.matchAll(/\{([^{}]+)\}/g)) {
        if (!declared.has(m[1])) params.push({ name: m[1], in: "path", required: true });
    }
    for (const p of params.filter((x) => x.in === "path")) {
        const existing = ctx.pathParams.get(p.name);
        if (existing) { existing.used.push(`${upper} ${path}`); continue; }
        let value = parameterValue(ctx, p);
        if (value === undefined) {
            const { type, format } = parameterType(ctx, p);
            value = type === "integer" || type === "number" ? 1 : format === "uuid" ? SAMPLE_UUID : "";
        }
        ctx.pathParams.set(p.name, { value: valueText(value), description: text(p.description).trim(), used: [`${upper} ${path}`] });
    }

    const query = params.filter((p) => p.in === "query").map((p) => {
        const value = valueText(parameterValue(ctx, p));
        // Optional parameters are listed but disabled, so the first try sends only what the API needs.
        return model.newKeyValue(p.name, value, { enabled: !!p.required, description: parameterDescription(ctx, p) });
    });
    const headers = params.filter((p) => p.in === "header" && !SKIPPED_HEADERS.has(String(p.name).toLowerCase())).map((p) => model.newKeyValue(
        p.name, valueText(parameterValue(ctx, p)), { enabled: !!p.required, description: parameterDescription(ctx, p) }));
    const cookies = params.filter((p) => p.in === "cookie");
    if (cookies.length) {
        headers.push(model.newKeyValue("Cookie", cookies.map((p) => `${p.name}=${valueText(parameterValue(ctx, p))}`).join("; "), {
            enabled: cookies.some((p) => p.required), description: `Cookie parameters: ${cookies.map((p) => p.name).join(", ")}`
        }));
    }

    // Body
    let bodyResult;
    if (ctx.swagger) {
        const consumes = Array.isArray(op.consumes) ? op.consumes : Array.isArray(ctx.doc.consumes) ? ctx.doc.consumes : [];
        bodyResult = bodyFromSwaggerParameters(ctx, params, consumes);
    } else {
        bodyResult = bodyFromRequestBody(ctx, op.requestBody);
    }
    headers.push(...bodyResult.headers);

    // Response: Accept header, status assertion, (disabled) schema assertion.
    const assertions = [];
    const success = successResponse(ctx, op.responses);
    let responseTypes = [];
    let responseSchema = null;
    if (success) {
        if (ctx.swagger) {
            responseTypes = Array.isArray(op.produces) ? op.produces : Array.isArray(ctx.doc.produces) ? ctx.doc.produces : [];
            if (success.response.schema && (!responseTypes.length || responseTypes.some(isJsonType))) responseSchema = success.response.schema;
        } else if (isPlainObject(success.response.content)) {
            responseTypes = Object.keys(success.response.content);
            const jsonType = responseTypes.find(isJsonType);
            if (jsonType && success.response.content[jsonType]) responseSchema = success.response.content[jsonType].schema || null;
        }
        if (/^\d{3}$/.test(success.code)) assertions.push(model.newAssertion("status", "equals", success.code));
        else assertions.push(model.newAssertion("status", "gte", "200"), model.newAssertion("status", "lt", "300"));
        if (responseSchema) {
            const schema = toJsonSchema(ctx, responseSchema);
            const schemaText = JSON.stringify(schema, null, 2);
            if (Object.keys(schema).length && !ctx.schemaTooBig && schemaText.length <= MAX_SCHEMA_TEXT) {
                const a = model.newAssertion("schema", "validSchema", schemaText);
                a.enabled = false;
                assertions.push(a);
                ctx.schemaAssertions++;
            }
        }
    }
    if (responseTypes.length > 1) {
        const jsonType = responseTypes.find(isJsonType);
        if (jsonType) headers.push(model.newKeyValue("Accept", jsonType));
    }

    // Auth: operation security differs from the global one -> own auth; [] -> none.
    let auth = model.defaultAuth("inherit");
    if (Array.isArray(op.security) && JSON.stringify(firstRequirement(op.security)) !== JSON.stringify(firstRequirement(ctx.globalSecurity))) {
        const result = authFromRequirements(ctx, op.security);
        auth = result.auth;
        headers.push(...result.headers);
    }

    ctx.requests++;
    return model.newRequest(name, {
        description: descParts.join("\n\n"),
        method: upper,
        url,
        params: query,
        headers,
        auth,
        body: bodyResult.body,
        assertions
    });
}

/** OpenAPI 3.x / Swagger 2.0 document -> { suite, warnings, source }. */
function importOpenApi(doc) {
    const swagger = isSwagger(doc);
    if (!swagger && !isOpenApi(doc)) throw new Error("Not an OpenAPI 3 or Swagger 2.0 definition");
    const ctx = {
        doc, swagger, warnings: [], externalRefs: new Set(), brokenRefs: new Set(), variables: new Map(), credentials: new Set(),
        pathParams: new Map(), unsupportedAuth: [], browserFlows: [], multiSchemes: new Set(), requests: 0, fileFields: 0,
        schemaAssertions: 0,
        securitySchemes: (swagger ? doc.securityDefinitions : doc.components && doc.components.securitySchemes) || {},
        globalSecurity: Array.isArray(doc.security) ? doc.security : []
    };
    const info = isPlainObject(doc.info) ? doc.info : {};
    const servers = baseUrls(ctx);
    addVariable(ctx, "baseUrl", servers[0].url, { description: "API address (from the definition's servers)" });

    const suiteAuth = authFromRequirements(ctx, ctx.globalSecurity);

    // Folders from tags: declared tags first (in their order), then tags as they appear.
    const folders = new Map();
    const tagInfo = new Map((Array.isArray(doc.tags) ? doc.tags : []).filter((t) => t && t.name).map((t) => [String(t.name), t]));
    const folderFor = (tag) => {
        if (!folders.has(tag)) {
            const t = tagInfo.get(tag) || {};
            folders.set(tag, model.newFolder(tag, { description: text(t.description).trim() }));
        }
        return folders.get(tag);
    };
    for (const tag of tagInfo.keys()) folderFor(tag);
    const loose = [];
    let skippedTrace = 0;

    const paths = isPlainObject(doc.paths) ? doc.paths : {};
    for (const [path, rawItem] of Object.entries(paths)) {
        const pathItem = deref(ctx, rawItem);
        if (!isPlainObject(pathItem)) continue;
        for (const [method, op] of Object.entries(pathItem)) {
            if (!OPERATION_METHODS.includes(method.toLowerCase()) || !isPlainObject(op)) continue;
            if (method.toLowerCase() === "trace") { skippedTrace++; continue; }
            const request = operationToRequest(ctx, path, method.toLowerCase(), pathItem, op);
            const tag = Array.isArray(op.tags) && op.tags.length ? String(op.tags[0]) : null;
            if (tag) folderFor(tag).items.push(request);
            else loose.push(request);
        }
    }
    const items = [...[...folders.values()].filter((f) => f.items.length), ...loose];

    for (const [key, p] of ctx.pathParams) {
        const description = [p.description, `Path parameter of ${p.used.slice(0, 3).join(", ")}${p.used.length > 3 ? ", ..." : ""}`].filter(Boolean).join(". ");
        addVariable(ctx, key, p.value, { description });
    }

    let name = text(info.title).trim() || (swagger ? "Swagger import" : "OpenAPI import");
    if (name.length > 100) name = `${name.slice(0, 97)}...`;
    const description = [text(info.description).trim(), info.version !== undefined ? `API version ${info.version}.` : ""].filter(Boolean).join("\n\n");
    const environments = servers.length > 1
        ? servers.map((s) => model.newEnvironment(s.name, [model.newVariable("baseUrl", s.url, { description: "API address" })]))
        : [];
    const suite = model.newSuite(name, {
        description,
        variables: [...ctx.variables.values()],
        headers: suiteAuth.headers,
        auth: suiteAuth.auth,
        environments,
        activeEnvironmentId: environments.length ? environments[0].id : null,
        items
    });

    const warnings = ctx.warnings;
    if (!ctx.requests) warnings.push("The definition has no operations under \"paths\": the suite is empty.");
    if (environments.length) warnings.push(`${plural(environments.length, "server")} became environments; choose one in the environment selector.`);
    if (ctx.credentials.size) warnings.push(`Fill in the credentials in the suite variables: ${listNames([...ctx.credentials], 6)}.`);
    const emptyPathParams = [...ctx.pathParams].filter(([, p]) => p.value === "").map(([k]) => k);
    if (emptyPathParams.length) warnings.push(`Path parameters without an example are empty suite variables; give them values: ${listNames(emptyPathParams)}.`);
    if (ctx.browserFlows.length) warnings.push(`OAuth 2.0 browser flows / OpenID Connect cannot run here; changed to a Bearer token {{accessToken}}: ${listNames(ctx.browserFlows)}.`);
    if (ctx.unsupportedAuth.length) warnings.push(`Unsupported security schemes were left out: ${listNames(ctx.unsupportedAuth)}.`);
    if (ctx.multiSchemes.size) warnings.push(`Only the first scheme is used where several are required together: ${listNames([...ctx.multiSchemes])}.`);
    if (ctx.fileFields) warnings.push("Some requests upload files: pick the files in their Body tab.");
    if (ctx.schemaAssertions) warnings.push("Requests with a JSON response schema have a disabled \"matches schema\" assertion; enable it to validate responses.");
    if (skippedTrace) warnings.push(`${plural(skippedTrace, "TRACE operation")} skipped.`);
    if (ctx.externalRefs.size) warnings.push(`References to other files were not followed: ${listNames([...ctx.externalRefs])}. Bundle the definition into one file for complete examples.`);
    if (ctx.brokenRefs.size) warnings.push(`Some references were not found in the file: ${listNames([...ctx.brokenRefs])}.`);
    return { suite, warnings, source: swagger ? "swagger" : "openapi", stats: { requests: ctx.requests, folders: items.filter((i) => i.type === "folder").length } };
}

module.exports = { isOpenApi, isSwagger, importOpenApi, exampleFromSchema, toJsonSchema };
