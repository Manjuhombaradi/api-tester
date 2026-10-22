"use strict";
// Postman importer: collections v2.0 / v2.1 (folders, requests, auth, bodies, variables, scripts) and
// environment / globals exports. Postman scripts cannot run here (pm.* API); they are kept as comments and
// the common checks in them (status, response time, headers, JSON values, pm.*.set captures) are converted
// to no-code assertions and captures.
const model = require("../model");
const { DYNAMIC_VARIABLES } = require("../variables");
const { text, descriptionText, listNames, plural, splitQuery, parseQueryString, safeDecode } = require("./common");

// Postman dynamic variables with an equivalent here under another name.
const DYNAMIC_ALIASES = { $randomUUID: "$guid", $randomAlphaNumeric: "$randomString" };

// ------------------------------------------------------------------ detection

function isPostmanCollection(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || !obj.info || typeof obj.info !== "object") return false;
    const schema = String(obj.info.schema || "");
    return /schema\.getpostman\.com|schema\.postman\.com|\/collection\/v2/i.test(schema) || (Array.isArray(obj.item) && (obj.info._postman_id || obj.info.name));
}

/** Old v1 collections ({ requests: [...], order: [...] }) are not supported: the caller shows a hint. */
function isPostmanCollectionV1(obj) {
    return !!obj && typeof obj === "object" && Array.isArray(obj.requests) && (Array.isArray(obj.order) || Array.isArray(obj.folders)) && !obj.info;
}

function isPostmanEnvironment(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || !Array.isArray(obj.values)) return false;
    return typeof obj._postman_variable_scope === "string" || (typeof obj.name === "string" && obj.values.every((v) => v && typeof v === "object" && "key" in v));
}

function collectionVersion(obj) {
    const m = /\/v(\d+\.\d+)(?:\.\d+)?\//.exec(String(obj.info?.schema || ""));
    return m ? m[1] : "2.1";
}

// ------------------------------------------------------------------ building blocks

function convertVariables(list) {
    return (Array.isArray(list) ? list : []).filter((v) => v && typeof v === "object" && (v.key || v.id)).map((v) => model.newVariable(
        text(v.key ?? v.id), text(v.value), { enabled: v.disabled !== true && v.enabled !== false, secret: v.type === "secret", description: descriptionText(v.description) }
    ));
}

function convertHeaders(header) {
    if (typeof header === "string") {
        // v1 / early v2.0 exports: "Name: value\nOther: value"
        return header.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
            const i = line.indexOf(":");
            const disabled = line.startsWith("//");
            const clean = disabled ? line.slice(2).trim() : line;
            const j = disabled ? clean.indexOf(":") : i;
            return model.newKeyValue(j > 0 ? clean.slice(0, j).trim() : clean, j > 0 ? clean.slice(j + 1).trim() : "", { enabled: !disabled });
        });
    }
    return (Array.isArray(header) ? header : []).filter((h) => h && typeof h === "object" && h.key).map((h) => model.newKeyValue(
        text(h.key), text(h.value), { enabled: h.disabled !== true, description: descriptionText(h.description) }
    ));
}

function headerValue(headers, name) {
    const h = headers.find((x) => x.enabled && x.key.toLowerCase() === name.toLowerCase());
    return h ? h.value : "";
}

function urlFromParts(url) {
    const join = (v, sep) => (Array.isArray(v) ? v.map((p) => (p && typeof p === "object" ? text(p.value) : text(p))).join(sep) : text(v));
    let out = "";
    if (url.protocol) out += `${url.protocol}://`;
    out += join(url.host, ".");
    if (url.port) out += `:${url.port}`;
    const path = join(url.path, "/");
    if (path) out += path.startsWith("/") ? path : `/${path}`;
    return out;
}

/** Postman url (string or object) -> { url (without query), params: KV[] }. Path variables (:id) become values or {{id}}. */
function convertUrl(url, ctx, requestName) {
    if (!url) return { url: "", params: [] };
    const obj = typeof url === "string" ? { raw: url } : url;
    const raw = typeof obj.raw === "string" ? obj.raw : urlFromParts(obj);
    const { base, query } = splitQuery(raw);
    // Postman keeps query values as typed (maybe percent-encoded); the Params table holds plain values.
    const params = Array.isArray(obj.query)
        ? obj.query.filter((q) => q && typeof q === "object" && (q.key || q.value)).map((q) => model.newKeyValue(
            safeDecode(text(q.key)), safeDecode(text(q.value)), { enabled: q.disabled !== true, description: descriptionText(q.description) }))
        : parseQueryString(query).map((q) => model.newKeyValue(q.key, q.value));

    const pathVars = new Map((Array.isArray(obj.variable) ? obj.variable : []).filter((v) => v && v.key).map((v) => [String(v.key), text(v.value)]));
    // Only the path part: "http://host:8080/users/:id" -> port stays, ":id" is replaced.
    const schemeEnd = base.indexOf("://");
    const pathStart = base.indexOf("/", schemeEnd >= 0 ? schemeEnd + 3 : 0);
    let finalUrl = base;
    if (pathStart >= 0) {
        const path = base.slice(pathStart).replace(/\/:([A-Za-z_][\w.-]*)/g, (match, name) => {
            const value = pathVars.get(name);
            if (value) return `/${value}`;
            ctx.pathVariables.push(`${requestName} (:${name})`);
            return `/{{${name}}}`;
        });
        finalUrl = base.slice(0, pathStart) + path;
    }
    return { url: finalUrl, params };
}

function convertBody(body, headers, ctx, requestName) {
    const out = model.defaultBody("none");
    if (!body || typeof body !== "object" || !body.mode) return out;
    switch (body.mode) {
        case "raw": {
            const raw = text(body.raw);
            if (!raw) return out;
            const language = String(body.options?.raw?.language || "").toLowerCase();
            const contentType = headerValue(headers, "Content-Type").toLowerCase();
            const trimmed = raw.trim();
            let mode = "text";
            if (language === "json" || contentType.includes("json")) mode = "json";
            else if (language === "xml" || contentType.includes("xml")) mode = "xml";
            else if (language === "" && !contentType && (trimmed.startsWith("{") || trimmed.startsWith("["))) mode = "json";
            else if (language === "" && !contentType && trimmed.startsWith("<?xml")) mode = "xml";
            return { ...out, mode, raw };
        }
        case "urlencoded":
            return {
                ...out, mode: "form",
                form: (Array.isArray(body.urlencoded) ? body.urlencoded : []).filter((p) => p && p.key).map((p) => model.newKeyValue(
                    text(p.key), text(p.value), { enabled: p.disabled !== true, description: descriptionText(p.description) }))
            };
        case "formdata":
            return {
                ...out, mode: "multipart",
                multipart: (Array.isArray(body.formdata) ? body.formdata : []).filter((p) => p && p.key).map((p) => {
                    const isFile = p.type === "file";
                    const src = Array.isArray(p.src) ? p.src[0] : p.src;
                    if (isFile) {
                        ctx.fileParts.push(requestName);
                        if (Array.isArray(p.src) && p.src.length > 1) ctx.multiFileParts.push(requestName);
                    }
                    return {
                        key: text(p.key), type: isFile ? "file" : "text", value: isFile ? "" : text(p.value), filePath: isFile ? text(src) : "",
                        contentType: text(p.contentType), enabled: p.disabled !== true
                    };
                })
            };
        case "file": {
            const src = text(body.file?.src);
            if (!src && body.file?.content) return { ...out, mode: "text", raw: text(body.file.content) };
            if (src) ctx.fileParts.push(requestName);
            return { ...out, mode: "binary", binaryPath: src };
        }
        case "graphql": {
            const vars = body.graphql?.variables;
            let variables = "";
            if (typeof vars === "string") variables = vars;
            else if (vars && typeof vars === "object") variables = JSON.stringify(vars, null, 2);
            return { ...out, mode: "graphql", graphql: { query: text(body.graphql?.query), variables } };
        }
        default:
            ctx.unsupportedBodies.push(`${requestName} (${body.mode})`);
            return out;
    }
}

/** Postman auth parameters: v2.1 [{key, value}] lists, v2.0 plain objects. */
function authParams(auth, type) {
    const v = auth[type];
    if (Array.isArray(v)) {
        const out = {};
        for (const p of v) if (p && p.key) out[p.key] = p.value;
        return out;
    }
    return v && typeof v === "object" ? v : {};
}

function convertAuth(auth, level, ctx, ownerName) {
    const fallback = level === "suite" ? "none" : "inherit";
    if (!auth || typeof auth !== "object" || !auth.type) return model.defaultAuth(fallback);
    const a = model.defaultAuth(fallback);
    const p = authParams(auth, auth.type);
    switch (auth.type) {
        case "inherit":
            return a;
        case "noauth":
            a.type = "none";
            return a;
        case "basic":
            a.type = "basic";
            a.basic = { username: text(p.username), password: text(p.password) };
            return a;
        case "bearer":
            a.type = "bearer";
            a.bearer = { token: text(p.token) };
            return a;
        case "apikey":
            a.type = "apikey";
            a.apikey = { key: text(p.key) || "X-API-Key", value: text(p.value), in: p.in === "query" ? "query" : "header" };
            return a;
        case "oauth2": {
            const grant = String(p.grant_type || p.grantType || "authorization_code");
            const grantType = grant === "client_credentials" ? "client_credentials" : grant === "password_credentials" || grant === "password" ? "password" : null;
            if (!grantType) {
                // Browser based flows (authorization code, implicit, PKCE) cannot run here: use the token directly.
                a.type = "bearer";
                a.bearer = { token: text(p.accessToken) };
                ctx.oauthBrowserFlows.push(ownerName);
                return a;
            }
            a.type = "oauth2";
            a.oauth2 = {
                ...a.oauth2,
                grantType,
                tokenUrl: text(p.accessTokenUrl || p.tokenUrl),
                clientId: text(p.clientId),
                clientSecret: text(p.clientSecret),
                scope: text(p.scope),
                audience: text(p.audience),
                username: text(p.username),
                password: text(p.password),
                // Postman's default is "Send as Basic Auth header".
                clientAuth: p.client_authentication === "body" ? "body" : "basic"
            };
            return a;
        }
        default:
            // Digest, Hawk, AWS, NTLM, ...: inheriting the parent's auth instead would be wrong, so send none.
            ctx.unsupportedAuth.push(`${ownerName} (${auth.type})`);
            a.type = "none";
            return a;
    }
}

// ------------------------------------------------------------------ scripts

function scriptText(events, listen) {
    const parts = [];
    for (const e of Array.isArray(events) ? events : []) {
        if (!e || e.listen !== listen || e.disabled === true || !e.script) continue;
        const exec = Array.isArray(e.script.exec) ? e.script.exec.join("\n") : text(e.script.exec);
        if (exec.trim()) parts.push(exec);
    }
    return parts.join("\n\n");
}

function commentOut(code, phase, converted) {
    const lines = [
        `// Postman ${phase === "pre" ? "pre-request" : "test"} script, kept as a comment: Postman's pm.* API does not run in API Tester.`,
        "// Rewrite it with vars.get / vars.set, test() and expect(), or use the Assertions and Capture tabs."
    ];
    if (converted) lines.push(`// ${converted}`);
    lines.push("//");
    for (const line of code.replace(/\r\n/g, "\n").split("\n")) lines.push(line.trim() ? `// ${line}` : "//");
    return lines.join("\n");
}

const STRING_RE = String.raw`"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'`;
const PATH_RE = String.raw`((?:\.[A-Za-z_$][\w$]*|\[\s*\d+\s*\]|\[\s*(?:"[^"]*"|'[^']*')\s*\])*)`;
const VAR_GET_RE = String.raw`pm\.(?:environment|collectionVariables|globals|variables|iterationData)\.get\(\s*(?:${STRING_RE})\s*\)`;

function unescapeJs(s) {
    return s.replace(/\\(["'\\/nrt])/g, (m, c) => ({ n: "\n", r: "\r", t: "\t" }[c] || c));
}

/** JavaScript path (".data[0]['id']") -> JSONPath ("$.data[0].id"). */
function toJsonPath(path) {
    let out = "$";
    for (const m of path.matchAll(/\.([A-Za-z_$][\w$]*)|\[\s*(\d+)\s*\]|\[\s*(?:"([^"]*)"|'([^']*)')\s*\]/g)) {
        const key = m[1] ?? m[3] ?? m[4];
        if (m[2] !== undefined) out += `[${m[2]}]`;
        else out += /^[A-Za-z_]\w*$/.test(key) ? `.${key}` : `['${key.replace(/'/g, "\\'")}']`;
    }
    return out;
}

/** Literal argument -> expected text, or null when it is not a simple literal. */
function literal(arg) {
    const s = String(arg ?? "").trim();
    let m;
    if ((m = new RegExp(`^(?:${STRING_RE})$`).exec(s))) return unescapeJs(m[1] ?? m[2]);
    if (/^-?\d+(\.\d+)?$/.test(s) || ["true", "false", "null"].includes(s)) return s;
    if ((m = new RegExp(`^${VAR_GET_RE}$`).exec(s))) return `{{${unescapeJs(m[1] ?? m[2])}}}`;
    if ((m = /^\[([^[\]]*)\]$/.exec(s))) {
        const items = m[1].split(",").map((x) => literal(x));
        if (items.every((x) => x !== null)) {
            try { return JSON.stringify(items.map((x) => (/^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x))); } catch { return null; }
        }
    }
    return null;
}

/** Chai method -> { operator, negated operator, needs argument }. */
const CHAI = {
    eql: ["equals", "notEquals", true], equal: ["equals", "notEquals", true], equals: ["equals", "notEquals", true], eq: ["equals", "notEquals", true],
    include: ["contains", "notContains", true], includes: ["contains", "notContains", true], contain: ["contains", "notContains", true], contains: ["contains", "notContains", true],
    above: ["gt", "lte", true], gt: ["gt", "lte", true], greaterThan: ["gt", "lte", true],
    least: ["gte", "lt", true], gte: ["gte", "lt", true],
    below: ["lt", "gte", true], lt: ["lt", "gte", true], lessThan: ["lt", "gte", true],
    most: ["lte", "gt", true], lte: ["lte", "gt", true],
    exist: ["exists", "notExists", false], exists: ["exists", "notExists", false],
    a: ["isType", null, true], an: ["isType", null, true],
    lengthOf: ["lengthEquals", null, true],
    empty: ["isEmpty", "isNotEmpty", false],
    oneOf: ["in", "notIn", true],
    match: ["matches", null, true],
    true: ["equals", "notEquals", false, "true"], false: ["equals", "notEquals", false, "false"],
    null: ["isType", null, false, "null"],
    ok: ["exists", "notExists", false]
};

const STATUS_WORDS = {
    ok: [["equals", "200"]], created: [["equals", "201"]], accepted: [["equals", "202"]], badRequest: [["equals", "400"]],
    unauthorized: [["equals", "401"]], forbidden: [["equals", "403"]], notFound: [["equals", "404"]], rateLimited: [["equals", "429"]],
    success: [["gte", "200"], ["lt", "300"]], redirection: [["gte", "300"], ["lt", "400"]], clientError: [["gte", "400"], ["lt", "500"]],
    serverError: [["gte", "500"]], error: [["gte", "400"]], info: [["lt", "200"]]
};

/**
 * Converts common checks of a Postman test script into assertions and captures.
 * -> { assertions: Assertion[], extract: Extraction[] }
 */
function convertTestScript(code) {
    const assertions = [];
    const extract = [];
    const seen = new Set();
    const add = (source, property, operator, expected = "") => {
        const key = [source, property, operator, expected].join("\u0000");
        if (seen.has(key)) return;
        seen.add(key);
        assertions.push(model.newAssertion(source, operator, expected, property));
    };

    // Names bound to the parsed JSON body: var json = pm.response.json();
    const aliases = [];
    for (const m of code.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:pm\.response\.json\(\s*\)|JSON\.parse\(\s*(?:responseBody|pm\.response\.text\(\s*\))\s*\))/g)) {
        aliases.push(m[1].replace(/\$/g, "\\$"));
    }
    const jsonSource = `(?:pm\\.response\\.json\\(\\s*\\)${aliases.length ? `|(?<![\\w$.])(?:${aliases.join("|")})` : ""})`;
    // the argument may hold one level of parentheses; written so that an unclosed "(" fails in linear time
    // (two [^()]* next to each other would backtrack quadratically on a long script: imported content)
    const chainRe = String.raw`((?:\.(?:to|be|been|is|that|which|and|has|have|with|at|of|same|deep|not|does|own|a|an))*)\.([A-Za-z]+)\b(?:\(([^()]*(?:\([^()]*\)[^()]*)?)\))?`;

    // pm.expect(<subject>).to.<chain>(<arg>)
    const subjects = [
        { re: `${jsonSource}${PATH_RE}`, map: (g) => ({ source: "jsonpath", path: g[0] || "" }) },
        { re: String.raw`pm\.response\.code`, map: () => ({ source: "status" }) },
        { re: String.raw`pm\.response\.status`, map: () => ({ source: "statusText" }) },
        { re: String.raw`pm\.response\.responseTime`, map: () => ({ source: "responseTime" }) },
        { re: String.raw`pm\.response\.text\(\s*\)`, map: () => ({ source: "body" }) },
        { re: String.raw`pm\.response\.headers\.get\(\s*(?:${STRING_RE})\s*\)`, map: (g) => ({ source: "header", property: unescapeJs(g[0] ?? g[1]) }) }
    ];
    for (const subject of subjects) {
        const re = new RegExp(String.raw`pm\.expect\(\s*${subject.re}\s*\)${chainRe}`, "g");
        for (const m of code.matchAll(re)) {
            const groups = m.slice(1);
            const [chain, word, rawArg] = groups.slice(-3);
            const target = subject.map(groups.slice(0, -3));
            const spec = CHAI[word];
            if (!spec && word !== "property" && word !== "lengthOf") continue;
            const negated = /\.not(\.|$)/.test(chain || "");
            let source = target.source;
            let property = target.property || "";
            if (source === "jsonpath") {
                let path = target.path;
                let lengthOf = false;
                if (/\.length$/.test(path)) { path = path.slice(0, -".length".length); lengthOf = true; }
                property = toJsonPath(path);
                if (word === "property") {
                    const args = splitArgs(rawArg);
                    const key = literal(args[0]);
                    if (key === null) continue;
                    property = toJsonPath(`${path}[${JSON.stringify(key)}]`);
                    if (args.length > 1) {
                        const value = literal(args[1]);
                        if (value !== null) add("jsonpath", property, negated ? "notEquals" : "equals", value);
                    } else add("jsonpath", property, negated ? "notExists" : "exists");
                    continue;
                }
                if (lengthOf) {
                    const len = { equals: "lengthEquals", gt: "lengthGt", lt: "lengthLt" }[spec?.[negated ? 1 : 0]];
                    const value = literal(rawArg);
                    if (len && value !== null && !negated) add("jsonpath", property, len, value);
                    continue;
                }
            } else if (word === "property") continue;
            if (!spec) continue;
            const operator = negated ? spec[1] : spec[0];
            if (!operator) continue;
            let expected = spec[3] ?? "";
            if (spec[2]) {
                if (word === "match") {
                    const rm = /^\s*\/((?:\\\/|[^/])+)\/([gimsuy]*)\s*$/.exec(rawArg || "");
                    if (!rm) continue;
                    expected = `/${rm[1]}/${rm[2].replace(/[gy]/g, "")}`;
                } else {
                    const value = literal(rawArg);
                    if (value === null) continue;
                    expected = value;
                }
            }
            if (source === "status" && ["isType", "isEmpty", "isNotEmpty"].includes(operator)) continue;
            if (operator === "isType" && !["string", "number", "boolean", "object", "array", "null"].includes(expected)) continue;
            add(source, property, operator, expected);
        }
    }

    // pm.response.to.have.status(200) / ("OK")
    for (const m of code.matchAll(new RegExp(String.raw`pm\.response\.to\.(?:have|be)\.status\(\s*(?:(\d{3})|${STRING_RE})\s*\)`, "g"))) {
        if (m[1]) add("status", "", "equals", m[1]);
        else add("statusText", "", "equals", unescapeJs(m[2] ?? m[3]));
    }
    // pm.response.to.be.ok / .success / .notFound ...
    for (const m of code.matchAll(/pm\.response\.to\.(?:be|have)\.([A-Za-z]+)\b(?!\s*\()/g)) {
        for (const [op, value] of STATUS_WORDS[m[1]] || []) add("status", "", op, value);
    }
    // pm.response.to.have.header("X") / ("X", "value")
    for (const m of code.matchAll(new RegExp(String.raw`pm\.response\.to\.have\.header\(\s*(?:${STRING_RE})\s*(?:,\s*(?:${STRING_RE})\s*)?\)`, "g"))) {
        const name = unescapeJs(m[1] ?? m[2]);
        if (m[3] !== undefined || m[4] !== undefined) add("header", name, "equals", unescapeJs(m[3] ?? m[4]));
        else add("header", name, "exists");
    }
    // pm.response.to.have.jsonBody() / ("path") / ("path", value)
    for (const m of code.matchAll(/pm\.response\.to\.(?:have\.jsonBody|be\.json)\b(?:\(([^()]*)\))?/g)) {
        const args = splitArgs(m[1]);
        if (!args.length || !args[0]) { add("contentType", "", "contains", "json"); continue; }
        const path = literal(args[0]);
        if (path === null) continue;
        const property = toJsonPath(path.split(".").map((p) => (/^\d+$/.test(p) ? `[${p}]` : `[${JSON.stringify(p)}]`)).join(""));
        if (args.length > 1 && literal(args[1]) !== null) add("jsonpath", property, "equals", literal(args[1]));
        else add("jsonpath", property, "exists");
    }
    // pm.response.to.have.body("text") / pm.response.to.have.body() -> body equals / not empty
    for (const m of code.matchAll(new RegExp(String.raw`pm\.response\.to\.have\.body\(\s*(?:${STRING_RE})?\s*\)`, "g"))) {
        if (m[1] !== undefined || m[2] !== undefined) add("body", "", "equals", unescapeJs(m[1] ?? m[2]));
        else add("body", "", "isNotEmpty");
    }
    // Legacy test syntax: tests["..."] = responseCode.code === 200; responseTime < 500; responseBody.has("x")
    for (const m of code.matchAll(/responseCode\.code\s*===?\s*(\d{3})/g)) add("status", "", "equals", m[1]);
    for (const m of code.matchAll(/(?<![\w.])responseTime\s*<\s*(\d+)/g)) add("responseTime", "", "lt", m[1]);
    for (const m of code.matchAll(new RegExp(String.raw`responseBody\.has\(\s*(?:${STRING_RE})\s*\)`, "g"))) add("body", "", "contains", unescapeJs(m[1] ?? m[2]));

    // Captures: pm.environment.set("token", json.token) / postman.setEnvironmentVariable("token", json.token)
    const setRe = new RegExp(String.raw`(?:pm\.(?:environment|collectionVariables|globals|variables)\.set|postman\.set(?:Environment|Global)Variable)\(\s*(?:${STRING_RE})\s*,\s*` +
        String.raw`(?:${jsonSource}${PATH_RE}|pm\.response\.headers\.get\(\s*(?:${STRING_RE})\s*\)|pm\.cookies\.get\(\s*(?:${STRING_RE})\s*\)|(pm\.response\.code))\s*\)`, "g");
    const captured = new Set();
    for (const m of code.matchAll(setRe)) {
        const variable = unescapeJs(m[1] ?? m[2]);
        if (!variable || captured.has(variable)) continue;
        captured.add(variable);
        // Runtime scope: the value chains to the next requests without needing an active environment.
        if (m[3] !== undefined) {
            extract.push(model.newExtraction("jsonpath", toJsonPath(m[3]), variable, "runtime"));
        } else if (m[4] !== undefined || m[5] !== undefined) {
            extract.push(model.newExtraction("header", unescapeJs(m[4] ?? m[5]), variable, "runtime"));
        } else if (m[6] !== undefined || m[7] !== undefined) {
            extract.push(model.newExtraction("cookie", unescapeJs(m[6] ?? m[7]), variable, "runtime"));
        } else if (m[8]) {
            extract.push(model.newExtraction("status", "", variable, "runtime"));
        }
    }
    return { assertions, extract };
}

/** Splits "a, 'b,c', 3" at top-level commas. */
function splitArgs(argText) {
    const s = String(argText ?? "").trim();
    if (!s) return [];
    const out = [];
    let depth = 0, quote = null, start = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
        if (c === "\"" || c === "'") quote = c;
        else if (c === "[" || c === "(" || c === "{") depth++;
        else if (c === "]" || c === ")" || c === "}") depth--;
        else if (c === "," && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
    }
    out.push(s.slice(start).trim());
    return out;
}

// ------------------------------------------------------------------ items

function convertRequest(item, ctx, folderPath) {
    const name = text(item.name) || "Request";
    const fullName = [...folderPath, name].join(" / ");
    const r = typeof item.request === "string" ? { url: item.request, method: "GET" } : (item.request || {});
    const headers = convertHeaders(r.header);
    const { url, params } = convertUrl(r.url, ctx, fullName);
    const method = text(r.method || "GET").toUpperCase();
    if (!model.HTTP_METHODS.includes(method)) ctx.customMethods.push(method);

    const request = model.newRequest(name, {
        description: descriptionText(r.description) || descriptionText(item.description),
        method,
        url,
        params,
        headers,
        auth: convertAuth(r.auth, "request", ctx, fullName),
        body: convertBody(r.body, headers, ctx, fullName)
    });

    const behaviour = item.protocolProfileBehavior || {};
    if (typeof behaviour.followRedirects === "boolean") request.settings.followRedirects = behaviour.followRedirects;
    if (typeof behaviour.strictSSL === "boolean") request.settings.verifyTls = behaviour.strictSSL;

    const pre = scriptText(item.event, "prerequest");
    const test = scriptText(item.event, "test");
    if (pre) {
        request.scripts.pre = commentOut(pre, "pre");
        ctx.scripts++;
    }
    if (test) {
        const converted = convertTestScript(test);
        request.assertions = converted.assertions;
        request.extract = converted.extract;
        const parts = [];
        if (converted.assertions.length) parts.push(plural(converted.assertions.length, "assertion"));
        if (converted.extract.length) parts.push(plural(converted.extract.length, "capture"));
        request.scripts.post = commentOut(test, "post", parts.length ? `Converted to ${parts.join(" and ")}: see the Assertions and Capture tabs.` : "");
        ctx.scripts++;
        if (parts.length) ctx.convertedScripts++;
        ctx.assertions += converted.assertions.length;
        ctx.captures += converted.extract.length;
    }
    if (Array.isArray(item.variable) && item.variable.length) ctx.requestVariables.push(fullName);
    ctx.requests++;
    return request;
}

function convertItems(items, ctx, folderPath) {
    const out = [];
    for (const item of Array.isArray(items) ? items : []) {
        if (!item || typeof item !== "object") continue;
        if (Array.isArray(item.item)) {
            const name = text(item.name) || "Folder";
            const path = [...folderPath, name];
            if (scriptText(item.event, "prerequest") || scriptText(item.event, "test")) ctx.containerScripts.push(path.join(" / "));
            out.push(model.newFolder(name, {
                description: descriptionText(item.description),
                auth: convertAuth(item.auth, "folder", ctx, path.join(" / ")),
                variables: convertVariables(item.variable),
                items: convertItems(item.item, ctx, path)
            }));
            ctx.folders++;
        } else if (item.request !== undefined) {
            out.push(convertRequest(item, ctx, folderPath));
        }
    }
    return out;
}

/** Replaces Postman-only dynamic variable names and lists the ones without an equivalent. */
function mapDynamicVariables(suite, ctx) {
    const json = JSON.stringify(suite).replace(/\{\{\s*(\$[A-Za-z]+)\s*\}\}/g, (match, name) => {
        if (DYNAMIC_ALIASES[name]) return `{{${DYNAMIC_ALIASES[name]}}}`;
        if (!DYNAMIC_VARIABLES[name]) ctx.unknownDynamic.push(name);
        return match;
    });
    return JSON.parse(json);
}

/** Postman collection (v2.0 / v2.1) -> { suite, warnings }. */
function importPostmanCollection(obj) {
    const ctx = {
        requests: 0, folders: 0, scripts: 0, convertedScripts: 0, assertions: 0, captures: 0,
        pathVariables: [], fileParts: [], multiFileParts: [], unsupportedBodies: [], unsupportedAuth: [], oauthBrowserFlows: [],
        containerScripts: [], requestVariables: [], customMethods: [], unknownDynamic: []
    };
    const name = text(obj.info?.name) || "Postman collection";
    let suite = model.newSuite(name, {
        description: descriptionText(obj.info?.description),
        variables: convertVariables(obj.variable),
        auth: convertAuth(obj.auth, "suite", ctx, "Collection"),
        items: convertItems(obj.item, ctx, [])
    });
    if (scriptText(obj.event, "prerequest") || scriptText(obj.event, "test")) ctx.containerScripts.unshift("the collection");
    suite = mapDynamicVariables(suite, ctx);

    const warnings = [];
    if (ctx.scripts) {
        let w = `${plural(ctx.scripts, "Postman script")} kept as comments in the Scripts tab (Postman's pm.* API does not run here).`;
        if (ctx.convertedScripts) w += ` Checks from ${plural(ctx.convertedScripts, "test script")} were converted to ${plural(ctx.assertions, "assertion")} and ${plural(ctx.captures, "capture")}.`;
        warnings.push(w);
    }
    if (ctx.containerScripts.length) warnings.push(`Scripts on ${listNames(ctx.containerScripts)} were not imported: only requests have scripts here.`);
    if (ctx.unsupportedAuth.length) warnings.push(`Unsupported auth types were left out (set the auth again): ${listNames(ctx.unsupportedAuth)}.`);
    if (ctx.oauthBrowserFlows.length) warnings.push(`OAuth 2.0 browser flows (authorization code / implicit) cannot run here; changed to Bearer token, paste a token: ${listNames(ctx.oauthBrowserFlows)}.`);
    // file uploads: listed with their paths in the security notes of the import (suiteFile.js)
    if (ctx.multiFileParts.length) warnings.push(`Only the first file of multi-file fields was kept: ${listNames(ctx.multiFileParts)}.`);
    if (ctx.unsupportedBodies.length) warnings.push(`Unsupported body types were left empty: ${listNames(ctx.unsupportedBodies)}.`);
    if (ctx.pathVariables.length) warnings.push(`Path variables without a value became {{variables}}; give them values: ${listNames(ctx.pathVariables)}.`);
    if (ctx.requestVariables.length) warnings.push(`Request-level variables are not supported and were skipped: ${listNames(ctx.requestVariables)}.`);
    if (ctx.customMethods.length) warnings.push(`Uncommon HTTP methods kept as is: ${listNames(ctx.customMethods)}.`);
    if (ctx.unknownDynamic.length) warnings.push(`Postman dynamic variables without an equivalent here were left as is: ${listNames(ctx.unknownDynamic)}.`);
    if (collectionVersion(obj) === "1.0") warnings.push("This looks like an old collection format; if something is missing, export it again from Postman as Collection v2.1.");
    return { suite, warnings, stats: { requests: ctx.requests, folders: ctx.folders } };
}

/** Postman environment or globals export -> { environment, warnings }. */
function importPostmanEnvironment(obj) {
    const warnings = [];
    const isGlobals = obj._postman_variable_scope === "globals";
    const name = text(obj.name) || (isGlobals ? "Postman globals" : "Postman environment");
    const variables = (obj.values || []).filter((v) => v && typeof v === "object" && v.key).map((v) => model.newVariable(
        text(v.key), text(v.value), { enabled: v.enabled !== false && v.disabled !== true, secret: v.type === "secret", description: descriptionText(v.description) }
    ));
    if (isGlobals) warnings.push(`Postman globals were imported as an environment named "${name}". Copy them to Globals if you need them everywhere.`);
    const emptySecrets = variables.filter((v) => v.secret && !v.value).map((v) => v.key);
    if (emptySecrets.length) warnings.push(`Secret values are empty; fill them in: ${listNames(emptySecrets)}.`);
    return { environment: model.newEnvironment(name, variables), warnings };
}

module.exports = {
    isPostmanCollection, isPostmanCollectionV1, isPostmanEnvironment,
    importPostmanCollection, importPostmanEnvironment, convertTestScript, toJsonPath
};
