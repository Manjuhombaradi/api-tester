"use strict";
// Local test API ("echo server"). Lets the sample suite and a user's first requests work offline, and gives
// testers predictable endpoints for status codes, delays, cookies, auth flows and a small CRUD resource.
// Pure Node (http + zlib), no state outside the server instance: users and tokens reset on every start.
//
// Web pages: CORS answers "Access-Control-Allow-Origin: *" without credentials, so a page may call the demo
// endpoints but the browser never sends its cookies or reads responses meant for a logged-in user. Requests for a
// host name other than localhost (or the address the server listens on, or names allowed with allowedHosts) get
// 421: that stops DNS rebinding, where a web page uses its own domain name to reach 127.0.0.1.
const http = require("http");
const crypto = require("crypto");
const net = require("net");
const os = require("os");
const zlib = require("zlib");

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_DELAY_MS = 10000;
const TOKEN_LIFETIME_S = 3600;
const DEMO_USER = { username: "demo", password: "demo" };
const DEMO_CLIENT = { id: "demo", secret: "secret" };

const ENDPOINTS = [
    ["ANY", "/anything[/...]", "Echoes the request: method, path, query, headers, body, json, form, files"],
    ["ANY", "/status/:code", "Responds with the given status code (200-599)"],
    ["GET", "/delay/:ms", `Waits ms milliseconds (max ${MAX_DELAY_MS}) before responding`],
    ["GET", "/redirect/:n", "Redirects n times (max 10), then lands on /anything"],
    ["GET", "/json", "Sample nested JSON document"],
    ["GET", "/xml", "Sample XML document"],
    ["GET", "/html", "Small HTML page"],
    ["GET", "/image.png", "Small PNG image"],
    ["GET", "/gzip", "JSON sent gzip compressed"],
    ["GET", "/headers", "The request headers"],
    ["GET", "/cookies", "Cookies the client sent"],
    ["GET", "/cookies/set?name=value", "Sets the given cookies"],
    ["GET", "/cookies/delete?name", "Deletes the given cookies"],
    ["GET", "/basic-auth/:user/:password", "200 when Basic auth matches user and password, else 401"],
    ["POST", "/auth/token", "OAuth2 token endpoint (client_credentials or password grant; client demo / secret)"],
    ["POST", "/login", "JSON {\"username\":\"demo\",\"password\":\"demo\"} -> {token}"],
    ["GET", "/me", "Profile; needs Authorization: Bearer <token from /login or /auth/token>"],
    ["GET", "/users", "List users (?name= filters)"],
    ["POST", "/users", "Create a user from JSON {name, email} -> 201"],
    ["GET", "/users/:id", "One user, 404 when missing"],
    ["PUT", "/users/:id", "Replace a user"],
    ["PATCH", "/users/:id", "Change some fields of a user"],
    ["DELETE", "/users/:id", "Delete a user -> 204"]
];

const SAMPLE_JSON = {
    store: {
        name: "Book Corner",
        open: true,
        rating: 4.6,
        address: { street: "12 Main Street", city: "Springfield", zip: "12345", country: "US" },
        tags: ["books", "coffee", "events"],
        books: [
            { id: 1, title: "The Pragmatic Programmer", author: "Andrew Hunt", price: 39.95, inStock: true, tags: ["software", "classic"] },
            { id: 2, title: "Clean Code", author: "Robert C. Martin", price: 32.5, inStock: true, tags: ["software"] },
            { id: 3, title: "Dune", author: "Frank Herbert", price: 9.99, inStock: false, tags: ["fiction", "classic"] }
        ],
        manager: null
    },
    page: { number: 1, size: 3, total: 3 },
    updatedAt: "2026-01-15T10:30:00Z"
};

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<catalog>
  <book id="1">
    <title>The Pragmatic Programmer</title>
    <author>Andrew Hunt</author>
    <price currency="USD">39.95</price>
  </book>
  <book id="2">
    <title>Clean Code</title>
    <author>Robert C. Martin</author>
    <price currency="USD">32.50</price>
  </book>
</catalog>
`;

const SAMPLE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Echo server</title></head>
<body>
  <h1>API Tester echo server</h1>
  <p>This is a small HTML page. Try <code>GET /anything</code> or <code>GET /json</code>.</p>
</body>
</html>
`;

// ------------------------------------------------------------------ PNG (generated once, no binary assets needed)

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

/** Distance from point p to the segment a-b. */
function segmentDistance(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 64x64 RGBA icon: blue circle with a white check mark. */
function createPng() {
    const size = 64;
    const raw = Buffer.alloc((size * 4 + 1) * size);
    for (let y = 0; y < size; y++) {
        const row = y * (size * 4 + 1);
        raw[row] = 0; // filter: none
        for (let x = 0; x < size; x++) {
            const cx = x + 0.5, cy = y + 0.5;
            const inside = Math.hypot(cx - 32, cy - 32) <= 30;
            const onCheck = Math.min(segmentDistance(cx, cy, 18, 33, 28, 43), segmentDistance(cx, cy, 28, 43, 47, 22)) <= 4;
            const o = row + 1 + x * 4;
            if (inside && onCheck) raw.set([255, 255, 255, 255], o);
            else if (inside) raw.set([47, 111, 237, 255], o);
            else raw.set([0, 0, 0, 0], o);
        }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8; // bit depth
    header[9] = 6; // colour type RGBA
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk("IHDR", header),
        pngChunk("IDAT", zlib.deflateSync(raw)),
        pngChunk("IEND", Buffer.alloc(0))
    ]);
}

let pngCache = null;

// ------------------------------------------------------------------ request parsing helpers

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                const err = new Error(`Request body is larger than ${MAX_BODY_BYTES / 1024 / 1024} MB`);
                err.status = 413;
                reject(err);
                req.removeAllListeners("data");
                req.resume();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

/** URLSearchParams -> plain object; repeated keys become arrays. */
function paramsToObject(params) {
    const out = {};
    for (const [key, value] of params) {
        if (Object.prototype.hasOwnProperty.call(out, key)) out[key] = [].concat(out[key], value);
        else out[key] = value;
    }
    return out;
}

function isTextual(contentType) {
    const ct = String(contentType || "").toLowerCase();
    if (!ct) return true;
    return /^text\/|json|xml|javascript|x-www-form-urlencoded|graphql|yaml|csv/.test(ct);
}

function headerParam(headerValue, name) {
    const m = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;]*))`, "i").exec(String(headerValue || ""));
    return m ? (m[1] !== undefined ? m[1] : m[2].trim()) : null;
}

/** Minimal multipart/form-data parser: -> { fields: {name: value}, files: [{field, fileName, contentType, size}] }. */
function parseMultipart(buffer, boundary) {
    const fields = {};
    const files = [];
    const delimiter = Buffer.from(`--${boundary}`);
    let pos = buffer.indexOf(delimiter);
    while (pos !== -1) {
        let start = pos + delimiter.length;
        if (buffer.slice(start, start + 2).toString() === "--") break; // closing delimiter
        if (buffer.slice(start, start + 2).toString() === "\r\n") start += 2;
        const next = buffer.indexOf(delimiter, start);
        if (next === -1) break;
        let part = buffer.slice(start, next);
        if (part.slice(-2).toString() === "\r\n") part = part.slice(0, -2);
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd !== -1) {
            const headers = {};
            for (const line of part.slice(0, headerEnd).toString("utf8").split("\r\n")) {
                const i = line.indexOf(":");
                if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
            }
            const content = part.slice(headerEnd + 4);
            const disposition = headers["content-disposition"] || "";
            const name = headerParam(disposition, "name") || "";
            const fileName = headerParam(disposition, "filename");
            if (fileName !== null) {
                files.push({ field: name, fileName, contentType: headers["content-type"] || "application/octet-stream", size: content.length });
            } else if (Object.prototype.hasOwnProperty.call(fields, name)) {
                fields[name] = [].concat(fields[name], content.toString("utf8"));
            } else {
                fields[name] = content.toString("utf8");
            }
        }
        pos = next;
    }
    return { fields, files };
}

function parseCookies(header) {
    const out = {};
    for (const part of String(header || "").split(";")) {
        const i = part.indexOf("=");
        if (i <= 0) continue;
        const name = part.slice(0, i).trim();
        let value = part.slice(i + 1).trim();
        try { value = decodeURIComponent(value); } catch { /* keep raw value */ }
        if (name) out[name] = value;
    }
    return out;
}

/** application/json, text/json and any "+json" type (application/vnd.api+json, application/problem+json, ...). Not ndjson. */
function isJsonType(contentType) {
    const mediaType = String(contentType || "").split(";")[0].trim().toLowerCase();
    return /^[a-z0-9.+-]+\/(?:[a-z0-9.!#$&^_-]*\+)?json$/.test(mediaType);
}

/**
 * Parses the body as JSON (if it is sent or looks like JSON) and as a form; -> { text, json, form, files, jsonError }.
 * jsonError is the parser's message when the body should be JSON but is not (null otherwise), so endpoints can
 * answer 400 with the real reason instead of a misleading "wrong password" or "field missing".
 */
function parseBody(buffer, contentType) {
    const ct = String(contentType || "").toLowerCase();
    const result = { text: "", json: null, form: {}, files: [], jsonError: null };
    if (!buffer.length) return result;
    if (ct.startsWith("multipart/form-data")) {
        const boundary = headerParam(contentType, "boundary");
        if (boundary) {
            const parsed = parseMultipart(buffer, boundary);
            result.form = parsed.fields;
            result.files = parsed.files;
        }
        result.text = multipartPreview(buffer);
        return result;
    }
    if (!isTextual(ct)) {
        result.text = `<binary data, ${buffer.length} bytes>`;
        return result;
    }
    result.text = buffer.toString("utf8");
    const trimmed = result.text.trim(); // also drops a byte order mark
    if (ct.includes("x-www-form-urlencoded")) {
        result.form = paramsToObject(new URLSearchParams(result.text));
        return result;
    }
    // JSON when the content type says so, or when a body without a JSON type clearly starts like JSON.
    if (trimmed && (isJsonType(ct) || trimmed.startsWith("{") || trimmed.startsWith("["))) {
        try {
            result.json = JSON.parse(trimmed);
        } catch (err) {
            // JSON Lines (application/x-ndjson, ...) is many documents, so failing to read it as one is no error.
            const jsonLines = ct.includes("json") && !isJsonType(ct);
            if (!jsonLines) result.jsonError = String(err && err.message ? err.message : err);
        }
    }
    return result;
}

/** Multipart bodies may contain binary files: keep the echo readable and small. */
function multipartPreview(buffer) {
    const limit = 64 * 1024;
    const text = buffer.slice(0, limit).toString("utf8").replace(/[\u0000-\u0008\u000e-\u001f�]+/g, "�");
    return buffer.length > limit ? `${text}\n… (${buffer.length} bytes in total)` : text;
}

function parseBasicAuth(header) {
    const m = /^Basic\s+(.+)$/i.exec(String(header || "").trim());
    if (!m) return null;
    const decoded = Buffer.from(m[1], "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i < 0) return null;
    return { username: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

function bearerToken(header) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(String(header || "").trim());
    return m ? m[1] : null;
}

// ------------------------------------------------------------------ host check (DNS rebinding)

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const ANY_ADDRESS = new Set(["", "0.0.0.0", "::"]);

function isLoopbackAddress(address) {
    const a = String(address || "").toLowerCase();
    return a === "localhost" || a === "::1" || /^127\.\d+\.\d+\.\d+$/.test(a) || a === "::ffff:127.0.0.1";
}

/** Host header -> host name in lower case without port and brackets ("[::1]:3999" -> "::1"). */
function hostName(hostHeader) {
    const h = String(hostHeader || "").trim().toLowerCase();
    if (h.startsWith("[")) {
        const end = h.indexOf("]");
        return end > 0 ? h.slice(1, end) : h;
    }
    const colon = h.indexOf(":");
    return (colon >= 0 && colon === h.lastIndexOf(":") ? h.slice(0, colon) : h).replace(/\.$/, "");
}

/**
 * -> (hostHeader) => true when the request may be answered. Always: localhost, *.localhost, 127.0.0.1, [::1]. When
 * listening on another address: that address, any IP address (DNS cannot rebind an IP) and this computer's name.
 * allowedHosts: more names ("*" turns the check off).
 */
function createHostCheck(listenHost, allowedHosts = []) {
    const host = String(listenHost || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
    const names = new Set(LOOPBACK_HOSTS);
    const loopbackOnly = !ANY_ADDRESS.has(host) && isLoopbackAddress(host);
    if (host && !ANY_ADDRESS.has(host)) names.add(host);
    if (!loopbackOnly) {
        const own = String(os.hostname() || "").toLowerCase();
        if (own) {
            names.add(own);
            names.add(own.endsWith(".local") ? own : `${own}.local`);
        }
    }
    for (const n of Array.isArray(allowedHosts) ? allowedHosts : []) {
        const name = hostName(n);
        if (name) names.add(name);
    }
    if (names.has("*")) return () => true;
    return (hostHeader) => {
        if (hostHeader === undefined) return true; // HTTP/1.0 tools without a Host header (browsers always send one)
        const name = hostName(hostHeader);
        if (!name) return false;
        if (names.has(name) || name.endsWith(".localhost")) return true;
        if (net.isIP(name)) return loopbackOnly ? isLoopbackAddress(name) : true;
        return false;
    };
}

// ------------------------------------------------------------------ server

function seedUsers() {
    const now = "2026-01-01T09:00:00.000Z";
    return new Map([
        [1, { id: 1, name: "Ada Lovelace", email: "ada@example.com", role: "admin", createdAt: now }],
        [2, { id: 2, name: "Alan Turing", email: "alan@example.com", role: "user", createdAt: now }],
        [3, { id: 3, name: "Grace Hopper", email: "grace@example.com", role: "user", createdAt: now }]
    ]);
}

function createHandler(state, hostAllowed = () => true) {
    function send(res, status, body, headers = {}) {
        if (res.headersSent || res.destroyed) return;
        let payload = body;
        const h = { "X-Echo-Server": "API Tester", "X-Request-Id": crypto.randomUUID(), ...headers };
        if (body === null || body === undefined || status === 204 || status === 304) {
            payload = null;
        } else if (!Buffer.isBuffer(body) && typeof body !== "string") {
            payload = JSON.stringify(body, null, 2);
            h["Content-Type"] = h["Content-Type"] || "application/json; charset=utf-8";
        } else if (!h["Content-Type"]) {
            h["Content-Type"] = "text/plain; charset=utf-8";
        }
        if (payload !== null) h["Content-Length"] = Buffer.byteLength(payload);
        res.writeHead(status, h);
        res.end(payload === null ? undefined : payload);
    }

    const error = (res, status, message, extra = {}, headers = {}) => send(res, status, { error: message, ...extra }, headers);

    const invalidJsonMessage = (body) => `The body is not valid JSON: ${body.jsonError}`;

    /** Answers 400 when the body should be JSON but cannot be parsed; -> true when the request was answered. */
    function rejectInvalidJson(res, body) {
        if (!body.jsonError) return false;
        error(res, 400, invalidJsonMessage(body));
        return true;
    }

    function methodNotAllowed(res, method, allowed) {
        error(res, 405, `Method ${method} is not allowed here. Use ${allowed.join(" or ")}.`, {}, { Allow: allowed.join(", ") });
    }

    function issueToken(kind, details) {
        // Drop expired tokens so a long running server does not grow without bound.
        const now = Date.now();
        for (const [t, info] of state.tokens) if (info.expiresAt <= now) state.tokens.delete(t);
        const token = crypto.randomBytes(20).toString("hex");
        state.tokens.set(token, { kind, ...details, expiresAt: now + TOKEN_LIFETIME_S * 1000 });
        return token;
    }

    function echo(req, url, body) {
        const out = {
            method: req.method,
            path: url.pathname,
            url: req.url,
            query: paramsToObject(url.searchParams),
            headers: req.headers,
            body: body.text,
            json: body.json,
            form: body.form,
            files: body.files,
            ip: req.socket.remoteAddress || ""
        };
        // Explains why "json" is null when the body was meant to be JSON (the echo itself still answers 200).
        if (body.jsonError) out.jsonError = invalidJsonMessage(body);
        return out;
    }

    function userInput(json, res, partial) {
        if (!json || typeof json !== "object" || Array.isArray(json)) {
            error(res, 400, "Send a JSON object, for example {\"name\": \"Ada\", \"email\": \"ada@example.com\"}");
            return null;
        }
        const out = {};
        for (const key of ["name", "email", "role"]) {
            if (json[key] === undefined) continue;
            if (typeof json[key] !== "string") { error(res, 400, `"${key}" must be a text value`); return null; }
            out[key] = json[key].trim();
        }
        if (!partial && !out.name) { error(res, 400, "\"name\" is required"); return null; }
        if (partial && out.name === "") { error(res, 400, "\"name\" must not be empty"); return null; }
        if (out.email && !/^[^@\s]+@[^@\s]+$/.test(out.email)) { error(res, 400, `"${out.email}" is not a valid e-mail address`); return null; }
        return out;
    }

    async function handleUsers(req, res, url, id) {
        const method = req.method;
        if (id === null) {
            if (method === "GET" || method === "HEAD") {
                const filter = String(url.searchParams.get("name") || "").toLowerCase();
                const users = [...state.users.values()].filter((u) => !filter || u.name.toLowerCase().includes(filter));
                return send(res, 200, { total: users.length, users });
            }
            if (method === "POST") {
                const body = parseBody(await readBody(req), req.headers["content-type"]);
                if (rejectInvalidJson(res, body)) return;
                const input = userInput(body.json, res, false);
                if (!input) return;
                const user = { id: state.nextUserId++, name: input.name, email: input.email || "", role: input.role || "user", createdAt: new Date().toISOString() };
                state.users.set(user.id, user);
                return send(res, 201, user, { Location: `/users/${user.id}` });
            }
            return methodNotAllowed(res, method, ["GET", "POST"]);
        }
        const user = state.users.get(Number(id));
        if (!["GET", "HEAD", "PUT", "PATCH", "DELETE"].includes(method)) return methodNotAllowed(res, method, ["GET", "PUT", "PATCH", "DELETE"]);
        if (!user) return error(res, 404, `User ${id} not found`);
        if (method === "GET" || method === "HEAD") return send(res, 200, user);
        if (method === "DELETE") {
            state.users.delete(user.id);
            return send(res, 204, null);
        }
        const body = parseBody(await readBody(req), req.headers["content-type"]);
        if (rejectInvalidJson(res, body)) return;
        const input = userInput(body.json, res, method === "PATCH");
        if (!input) return;
        const updated = method === "PUT"
            ? { id: user.id, name: input.name, email: input.email || "", role: input.role || "user", createdAt: user.createdAt }
            : { ...user, ...input };
        updated.updatedAt = new Date().toISOString();
        state.users.set(user.id, updated);
        return send(res, 200, updated);
    }

    async function handleToken(req, res) {
        if (req.method !== "POST") return methodNotAllowed(res, req.method, ["POST"]);
        const body = parseBody(await readBody(req), req.headers["content-type"]);
        if (body.jsonError) return send(res, 400, { error: "invalid_request", error_description: invalidJsonMessage(body) });
        const p = body.json && typeof body.json === "object" ? body.json : body.form;
        const basic = parseBasicAuth(req.headers.authorization);
        const clientId = basic ? basic.username : p.client_id;
        const clientSecret = basic ? basic.password : p.client_secret;
        const grant = p.grant_type;
        if (grant !== "client_credentials" && grant !== "password") {
            return send(res, 400, { error: "unsupported_grant_type", error_description: "Use grant_type client_credentials or password" });
        }
        if (clientId !== DEMO_CLIENT.id || clientSecret !== DEMO_CLIENT.secret) {
            return send(res, 401, { error: "invalid_client", error_description: "Unknown client. Use client_id \"demo\" and client_secret \"secret\"." },
                { "WWW-Authenticate": "Basic realm=\"echo\"" });
        }
        if (grant === "password" && (p.username !== DEMO_USER.username || p.password !== DEMO_USER.password)) {
            return send(res, 400, { error: "invalid_grant", error_description: "Wrong username or password. Use demo / demo." });
        }
        const scope = typeof p.scope === "string" ? p.scope : "";
        const token = issueToken(grant, { clientId, scope, username: grant === "password" ? DEMO_USER.username : null });
        return send(res, 200, { access_token: token, token_type: "Bearer", expires_in: TOKEN_LIFETIME_S, scope }, { "Cache-Control": "no-store" });
    }

    async function handleLogin(req, res) {
        if (req.method !== "POST") return methodNotAllowed(res, req.method, ["POST"]);
        const body = parseBody(await readBody(req), req.headers["content-type"]);
        if (rejectInvalidJson(res, body)) return;
        const p = body.json && typeof body.json === "object" ? body.json : body.form;
        if (p.username !== DEMO_USER.username || p.password !== DEMO_USER.password) {
            return error(res, 401, "Invalid username or password. Use demo / demo.");
        }
        const token = issueToken("login", { username: DEMO_USER.username });
        return send(res, 200, { token, tokenType: "Bearer", expiresIn: TOKEN_LIFETIME_S, user: { username: DEMO_USER.username, name: "Demo User" } });
    }

    function handleMe(req, res) {
        if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, req.method, ["GET"]);
        const token = bearerToken(req.headers.authorization);
        const info = token ? state.tokens.get(token) : null;
        if (!info || info.expiresAt <= Date.now()) {
            const message = token ? "The bearer token is unknown or expired. Log in again." : "Missing bearer token. Call POST /login or POST /auth/token first.";
            return error(res, 401, message, {}, { "WWW-Authenticate": "Bearer realm=\"echo\"" });
        }
        const viaClient = info.kind === "client_credentials";
        return send(res, 200, {
            id: viaClient ? 0 : 1,
            username: viaClient ? `client:${info.clientId}` : info.username,
            name: viaClient ? "Demo Client (service account)" : "Demo User",
            email: viaClient ? "" : "demo@example.com",
            roles: viaClient ? ["service"] : ["user", "tester"],
            scope: info.scope || "",
            authenticatedWith: info.kind,
            tokenExpiresAt: new Date(info.expiresAt).toISOString()
        });
    }

    function handleDelay(req, res, ms) {
        const wait = Math.max(0, Math.min(MAX_DELAY_MS, Math.round(ms)));
        const started = Date.now();
        const timer = setTimeout(() => {
            state.timers.delete(timer);
            send(res, 200, { delayMs: wait, waitedMs: Date.now() - started });
        }, wait);
        state.timers.add(timer);
        // The client gave up (cancel / timeout): stop waiting.
        res.on("close", () => { clearTimeout(timer); state.timers.delete(timer); });
    }

    async function route(req, res) {
        const url = new URL(req.url || "/", "http://localhost");
        const path = url.pathname.replace(/\/+$/, "") || "/";
        const method = req.method;
        let m;

        if (method === "OPTIONS" && !/^\/anything(\/|$)/.test(path)) return send(res, 204, null);

        if (path === "/") {
            return send(res, 200, {
                name: "API Tester echo server",
                description: "A local test API. Data resets when the server restarts.",
                endpoints: ENDPOINTS.map(([verb, p, description]) => ({ method: verb, path: p, description }))
            });
        }
        if (path === "/anything" || path.startsWith("/anything/")) {
            const body = parseBody(await readBody(req), req.headers["content-type"]);
            return send(res, 200, echo(req, url, body));
        }
        if ((m = /^\/status\/(\d{3})$/.exec(path))) {
            const code = Number(m[1]);
            if (code < 200 || code > 599) return error(res, 400, "Status code must be between 200 and 599");
            await readBody(req);
            const headers = {};
            if (code >= 300 && code < 400 && code !== 304) headers.Location = "/anything";
            if (code === 401) headers["WWW-Authenticate"] = "Basic realm=\"echo\"";
            return send(res, code, { status: code, statusText: http.STATUS_CODES[code] || "Unknown" }, headers);
        }
        if ((m = /^\/delay\/(\d+(?:\.\d+)?)$/.exec(path))) {
            if (method !== "GET" && method !== "HEAD") return methodNotAllowed(res, method, ["GET"]);
            return handleDelay(req, res, Number(m[1]));
        }
        if ((m = /^\/redirect\/(\d+)$/.exec(path))) {
            const n = Math.min(10, Number(m[1]));
            return send(res, 302, { redirectsLeft: n }, { Location: n <= 1 ? "/anything" : `/redirect/${n - 1}` });
        }
        if (path === "/json") return send(res, 200, SAMPLE_JSON);
        if (path === "/xml") return send(res, 200, SAMPLE_XML, { "Content-Type": "application/xml; charset=utf-8" });
        if (path === "/html") return send(res, 200, SAMPLE_HTML, { "Content-Type": "text/html; charset=utf-8" });
        if (path === "/image.png") {
            pngCache = pngCache || createPng();
            return send(res, 200, pngCache, { "Content-Type": "image/png", "Cache-Control": "max-age=3600" });
        }
        if (path === "/gzip") {
            const json = JSON.stringify({ gzipped: true, message: "This response was compressed with gzip", store: SAMPLE_JSON.store.name }, null, 2);
            return send(res, 200, zlib.gzipSync(json), { "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "gzip" });
        }
        if (path === "/headers") return send(res, 200, { headers: req.headers });
        if (path === "/cookies") return send(res, 200, { cookies: parseCookies(req.headers.cookie) });
        if (path === "/cookies/set") {
            const cookies = parseCookies(req.headers.cookie);
            const setCookie = [];
            for (const [name, value] of url.searchParams) {
                if (!name) continue;
                setCookie.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}; Path=/`);
                cookies[name] = value;
            }
            if (!setCookie.length) return error(res, 400, "Add the cookies to set as query parameters, for example /cookies/set?session=abc");
            return send(res, 200, { cookies }, { "Set-Cookie": setCookie });
        }
        if (path === "/cookies/delete") {
            const cookies = parseCookies(req.headers.cookie);
            const setCookie = [];
            for (const name of url.searchParams.keys()) {
                setCookie.push(`${encodeURIComponent(name)}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
                delete cookies[name];
            }
            return send(res, 200, { cookies }, setCookie.length ? { "Set-Cookie": setCookie } : {});
        }
        if ((m = /^\/basic-auth\/([^/]+)\/([^/]+)$/.exec(path))) {
            const given = parseBasicAuth(req.headers.authorization);
            const user = decodeURIComponent(m[1]), password = decodeURIComponent(m[2]);
            if (!given || given.username !== user || given.password !== password) {
                return error(res, 401, "Wrong or missing Basic credentials", {}, { "WWW-Authenticate": "Basic realm=\"echo\"" });
            }
            return send(res, 200, { authenticated: true, user });
        }
        if (path === "/auth/token") return handleToken(req, res);
        if (path === "/login") return handleLogin(req, res);
        if (path === "/me") return handleMe(req, res);
        if (path === "/users") return handleUsers(req, res, url, null);
        if ((m = /^\/users\/([^/]+)$/.exec(path))) return handleUsers(req, res, url, decodeURIComponent(m[1]));

        return error(res, 404, `Nothing at ${req.method} ${url.pathname}`, { hint: "GET / lists all endpoints of the echo server" });
    }

    return (req, res) => {
        if (!hostAllowed(req.headers.host)) {
            // DNS rebinding: a web page reaching this server under its own domain name gets no answer it could use
            const name = hostName(req.headers.host);
            readBody(req).catch(() => {});
            error(res, 421, `This echo server does not answer requests for the host name "${name}".`, {
                hint: "It answers localhost, 127.0.0.1 and [::1] (and the address it listens on). This protects it against web pages that " +
                    `use DNS rebinding. To use another name, start it with --allow-host ${name} (or API_TESTER_ECHO_ALLOWED_HOSTS=${name}).`
            }, { Connection: "close" });
            return;
        }
        // CORS, so the echo server can also be called from a browser page - without credentials (cookies)
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "*");
        res.setHeader("Access-Control-Expose-Headers", "*");
        route(req, res).catch((err) => {
            if (err && err.status === 413) {
                // Answer first, then drop the connection instead of reading the rest of the upload.
                res.on("finish", () => req.socket.destroy());
                error(res, 413, err.message, {}, { Connection: "close" });
                return;
            }
            error(res, 500, `Echo server error: ${err && err.message ? err.message : err}`);
        });
    };
}

/**
 * Starts the echo server. -> Promise<{ port, url, host, close() }>.
 * port 0 picks a free port. close() resolves when the server has stopped (open connections are dropped).
 * allowedHosts: host names to answer besides localhost / the listen address (see createHostCheck).
 */
function startEchoServer({ port = 3999, host = "127.0.0.1", allowedHosts = [] } = {}) {
    return new Promise((resolve, reject) => {
        const wanted = Number(port);
        if (!Number.isInteger(wanted) || wanted < 0 || wanted > 65535) {
            reject(new Error(`Invalid port "${port}": use a number between 1 and 65535`));
            return;
        }
        const state = { users: seedUsers(), nextUserId: 4, tokens: new Map(), timers: new Set() };
        const server = http.createServer(createHandler(state, createHostCheck(host, allowedHosts)));
        server.keepAliveTimeout = 5000;
        server.on("clientError", (err, socket) => {
            if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
            else socket.destroy();
        });
        const onStartError = (err) => {
            if (err.code === "EADDRINUSE") reject(new Error(`Port ${wanted} is already in use (another program, or the echo server is already running). Choose another port.`));
            else if (err.code === "EACCES") reject(new Error(`No permission to use port ${wanted}. Choose a port above 1024.`));
            else if (err.code === "EADDRNOTAVAIL") reject(new Error(`Address ${host} is not available on this computer`));
            else reject(new Error(`Cannot start the echo server: ${err.message}`));
        };
        server.once("error", onStartError);
        server.listen(wanted, host, () => {
            server.off("error", onStartError);
            server.on("error", () => { /* runtime socket errors are per connection; keep serving */ });
            const actualPort = server.address().port;
            const urlHost = host === "0.0.0.0" || host === "::" || !host ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
            let closing = null;
            resolve({
                port: actualPort,
                host,
                url: `http://${urlHost}:${actualPort}`,
                close() {
                    if (closing) return closing;
                    closing = new Promise((done) => {
                        for (const t of state.timers) clearTimeout(t);
                        state.timers.clear();
                        server.close(() => done());
                        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
                    });
                    return closing;
                }
            });
        });
    });
}

module.exports = { startEchoServer, createHostCheck, isLoopbackAddress, ENDPOINTS, SAMPLE_JSON, DEMO_USER, DEMO_CLIENT };
