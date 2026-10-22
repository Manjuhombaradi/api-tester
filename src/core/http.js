"use strict";
// HTTP client of API Tester. Built on node http / https (not fetch) so it can measure timings (DNS, connect,
// TLS, first byte, download), report TLS details and every redirect hop, decode compressed bodies and cap
// huge responses. sendRequest never rejects for network problems: the response then has status 0 and
// error { code, message } with a message a tester can act on.
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const { performance } = require("perf_hooks");
const { Cookie, defaultPath } = require("tough-cookie");

const APP_VERSION = (() => {
    try {
        return require("../../package.json").version || "1.0.0";
    } catch {
        return "1.0.0";
    }
})();
const USER_AGENT = `API-Tester/${APP_VERSION}`;

/** App settings used for values that are missing (same shape as the Settings dialog). */
const DEFAULT_SETTINGS = {
    timeoutMs: 30000,
    followRedirects: true,
    verifyTls: true,
    proxy: { enabled: false, url: "", noProxy: "localhost,127.0.0.1" },
    maxResponseMB: 20
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_HEADER_BYTES = 64 * 1024; // node's default (16 KB) is too small for some cookie-heavy APIs
const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

// ------------------------------------------------------------------ small helpers

function firstNumber(...values) {
    for (const v of values) {
        if (v === null || v === undefined || v === "") continue;
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) return n;
    }
    return 0;
}

function round(ms) {
    return ms === null || ms === undefined || !Number.isFinite(ms) ? null : Math.max(0, Math.round(ms * 10) / 10);
}

function fmtDuration(ms) {
    return ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`;
}

/** Effective send options: request-level settings (prepared.settings) win over app settings. */
function resolveSendOptions(prepared, settings) {
    const app = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    const ps = (prepared && prepared.settings) || {};
    return {
        timeoutMs: firstNumber(ps.timeoutMs, app.timeoutMs, DEFAULT_SETTINGS.timeoutMs),
        followRedirects: typeof ps.followRedirects === "boolean" ? ps.followRedirects : app.followRedirects !== false,
        maxRedirects: firstNumber(ps.maxRedirects, 10),
        verifyTls: typeof ps.verifyTls === "boolean" ? ps.verifyTls : app.verifyTls !== false,
        maxBytes: Math.max(1024, Math.floor((Number(app.maxResponseMB) > 0 ? Number(app.maxResponseMB) : DEFAULT_SETTINGS.maxResponseMB) * 1024 * 1024)),
        proxy: app.proxy || DEFAULT_SETTINGS.proxy
    };
}

/** Accepts [[name, value], ...] (the PreparedRequest form) or a { name: value | value[] } object (from scripts). */
function headerPairs(headers) {
    if (Array.isArray(headers)) {
        return headers
            .filter((h) => Array.isArray(h) && h[0] !== undefined && String(h[0]).trim())
            .map(([k, v]) => [String(k).trim(), v === null || v === undefined ? "" : String(v)]);
    }
    if (headers && typeof headers === "object") {
        const out = [];
        for (const [k, v] of Object.entries(headers)) {
            if (!String(k).trim()) continue;
            for (const x of Array.isArray(v) ? v : [v]) out.push([String(k).trim(), x === null || x === undefined ? "" : String(x)]);
        }
        return out;
    }
    return [];
}

function toBodyBuffer(body) {
    if (body === null || body === undefined) return null;
    if (Buffer.isBuffer(body)) return body.length ? body : null;
    if (typeof body === "string") return body.length ? Buffer.from(body, "utf8") : null;
    if (body instanceof ArrayBuffer) return Buffer.from(body);
    if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    return Buffer.from(JSON.stringify(body), "utf8"); // a script set an object: send it as JSON text
}

const lower = (s) => String(s).toLowerCase();
const without = (pairs, ...names) => pairs.filter(([k]) => !names.includes(lower(k)));

const SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;
const VARIABLE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const EXAMPLE_URL = "https://api.example.com/users";
const urlError = (message) => Object.assign(new Error(message), { code: "INVALID_URL" });

/**
 * Parses the URL to send; adds http:// when the scheme is missing. Throws a readable Error (code INVALID_URL /
 * UNSUPPORTED_PROTOCOL). Messages quote the URL as given, not with the added scheme.
 */
function parseTarget(rawUrl) {
    const original = String(rawUrl ?? "").trim();
    if (!original) throw urlError(`The URL is empty. Enter an address like ${EXAMPLE_URL}`);
    const noHost = () => urlError(`The URL "${original}" has no host name. Enter a full address like ${EXAMPLE_URL}`);
    let text = original;
    if (text.startsWith("//")) text = `http:${text}`;
    else if (!SCHEME_PATTERN.test(text)) {
        if (text.startsWith("/")) throw noHost(); // e.g. "{{baseUrl}}/users" with an empty baseUrl
        text = `http://${text}`;
    }
    // "http:///users": WHATWG URL would take "users" as the host name
    if (/^https?:\/\/(?:[/\\?#]|$)/i.test(text)) throw noHost();
    const authority = text.replace(SCHEME_PATTERN, "").split(/[/\\?#]/)[0];
    const invalid = () => {
        const names = [...new Set([...original.matchAll(VARIABLE_PATTERN)].map((m) => m[1]))];
        if (!names.length || !/\{\{|\}\}|%7b%7b|%7d%7d/i.test(authority)) return urlError(`Invalid URL "${original}". Check it for typing errors and spaces.`);
        const one = names.length === 1;
        const list = names.map((n) => `{{${n}}}`);
        const joined = one ? list[0] : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
        return urlError(`Unknown variable${one ? "" : "s"} ${joined} in the URL. Select an environment that defines ${one ? "it" : "them"}, or add ${one ? "it as a variable" : "them as variables"}.`);
    };
    let url;
    try {
        url = new URL(text);
    } catch {
        throw invalid();
    }
    // WHATWG URL accepts "{{name}}" as a host name; it can only be an unresolved variable
    if (/[{}]|%7b|%7d/i.test(url.hostname)) throw invalid();
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw Object.assign(new Error(`Unsupported protocol "${url.protocol}" (use http:// or https://)`), { code: "UNSUPPORTED_PROTOCOL" });
    }
    if (!url.hostname) throw noHost();
    return url;
}

// ------------------------------------------------------------------ proxy

let proxyModules = null;

/** https-proxy-agent / http-proxy-agent are ES modules: require() works on Node 22.12+, import() is the fallback. */
async function loadProxyModules() {
    if (proxyModules) return proxyModules;
    let httpsMod;
    let httpMod;
    try {
        httpsMod = require("https-proxy-agent");
        httpMod = require("http-proxy-agent");
    } catch {
        httpsMod = await import("https-proxy-agent");
        httpMod = await import("http-proxy-agent");
    }
    proxyModules = { HttpsProxyAgent: httpsMod.HttpsProxyAgent, HttpProxyAgent: httpMod.HttpProxyAgent };
    return proxyModules;
}

/** true when the host matches the no-proxy list: "*", "host", ".domain" / "domain" (suffix), "host:port", IPs. */
function bypassesProxy(target, noProxy) {
    const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const port = target.port || (target.protocol === "https:" ? "443" : "80");
    for (const raw of String(noProxy || "").split(/[\s,;]+/)) {
        let entry = raw.trim().toLowerCase();
        if (!entry) continue;
        if (entry === "*") return true;
        let entryPort = "";
        const m = entry.match(/^\[?([^\]]+?)\]?:(\d+)$/);
        if (m && (entry.startsWith("[") || entry.split(":").length === 2)) {
            entry = m[1];
            entryPort = m[2];
        }
        entry = entry.replace(/^\[|\]$/g, "");
        if (entryPort && entryPort !== port) continue;
        const domain = entry.replace(/^\*?\./, "");
        if (host === domain || host.endsWith(`.${domain}`)) return true;
    }
    return false;
}

/**
 * -> { agent, label: "host:port" of the proxy (no credentials, for messages) } or null when no proxy is used
 * for this target. signal destroys the agent's socket to the proxy (req.destroy() cannot reach it while the
 * agent is still connecting or waiting for the CONNECT answer).
 */
async function proxyAgentFor(target, proxy, verifyTls, signal) {
    if (!proxy || !proxy.enabled || !String(proxy.url || "").trim()) return null;
    if (bypassesProxy(target, proxy.noProxy)) return null;
    let proxyUrl = String(proxy.url).trim();
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(proxyUrl)) proxyUrl = `http://${proxyUrl}`;
    let parsed;
    try {
        parsed = new URL(proxyUrl);
    } catch {
        parsed = null;
    }
    if (!parsed || !parsed.hostname) {
        throw Object.assign(new Error(`The proxy URL "${proxy.url}" is not valid (Settings > Proxy)`), { code: "PROXY_ERROR" });
    }
    const { HttpsProxyAgent, HttpProxyAgent } = await loadProxyModules();
    const agent = target.protocol === "https:" ? new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: verifyTls, signal }) : new HttpProxyAgent(proxyUrl, { signal });
    return { agent, label: `${parsed.hostname}:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}` };
}

// ------------------------------------------------------------------ errors

const PROXY_CONNECT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN", "ENETDOWN", "EADDRNOTAVAIL"]);

/**
 * An error raised while the proxy agent was still connecting (before it handed a socket to the request) is
 * about the proxy, not the target server: { code: "PROXY_ERROR", message } or null when it is something else
 * (e.g. a TLS error of the target inside the tunnel).
 */
function describeProxyError(err, proxyLabel, target) {
    const code = String((err && err.code) || "");
    const check = "Check Settings > Proxy, or turn the proxy off.";
    if (code === "ECONNRESET" || code === "EPIPE") {
        return { code, message: `The connection through the proxy ${proxyLabel} to ${target ? target.host : "the server"} was closed unexpectedly (${code}).` };
    }
    if (!PROXY_CONNECT_CODES.has(code)) return null;
    let reason;
    if (code === "ECONNREFUSED") reason = `Could not connect to the proxy ${proxyLabel} (connection refused, ${code}).`;
    else if (code === "ENOTFOUND" || code === "EAI_AGAIN") reason = `The proxy host "${proxyLabel.replace(/:\d+$/, "")}" was not found (DNS lookup failed, ${code}).`;
    else if (code === "ETIMEDOUT") reason = `Could not connect to the proxy ${proxyLabel} (connection timed out, ${code}).`;
    else reason = `The proxy ${proxyLabel} cannot be reached from this machine (${code}).`;
    return { code: "PROXY_ERROR", message: `${reason} ${check}` };
}

/** Network / TLS / parser error -> { code, message } that tells a tester what to check. */
function describeNetworkError(err, target) {
    const code = String((err && err.code) || "ERROR");
    const msg = String((err && err.message) || err || "Unknown error");
    const host = target ? target.host : "the server";
    const hostname = target ? target.hostname : "";
    const certHint = "To accept it anyway, turn off \"Verify TLS\" in Settings or in the request's Settings tab.";
    switch (code) {
        case "TIMEOUT":
        case "ABORTED":
        case "INVALID_URL":
        case "UNSUPPORTED_PROTOCOL":
        case "INVALID_HEADER":
        case "TOO_MANY_REDIRECTS":
        case "PROXY_ERROR":
            return { code, message: msg };
        case "ECONNREFUSED":
            return { code, message: `Connection refused by ${host}. Is the server running and is the port right?` };
        case "ENOTFOUND":
            return { code, message: `Host "${hostname}" not found (DNS lookup failed). Check the URL and your network.` };
        case "EAI_AGAIN":
            return { code, message: `DNS lookup for "${hostname}" failed temporarily. Check your network connection.` };
        case "ECONNRESET":
            return { code, message: `The connection to ${host} was closed unexpectedly (ECONNRESET).` };
        case "EPIPE":
            return { code, message: `The server ${host} closed the connection while the request was being sent (EPIPE).` };
        case "ETIMEDOUT":
            return { code, message: `Could not connect to ${host} (connection timed out).` };
        case "EHOSTUNREACH":
        case "ENETUNREACH":
        case "EHOSTDOWN":
        case "ENETDOWN":
            return { code, message: `${host} cannot be reached from this machine (${code}). Check the network, VPN or firewall.` };
        case "EADDRNOTAVAIL":
            return { code, message: `The address of ${host} is not available (${code}).` };
        case "DEPTH_ZERO_SELF_SIGNED_CERT":
        case "SELF_SIGNED_CERT_IN_CHAIN":
            return { code, message: `The TLS certificate of ${host} is self-signed. ${certHint}` };
        case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
        case "UNABLE_TO_GET_ISSUER_CERT":
        case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
            return { code, message: `The TLS certificate of ${host} could not be verified (unknown issuer). ${certHint}` };
        case "CERT_HAS_EXPIRED":
            return { code, message: `The TLS certificate of ${host} has expired. ${certHint}` };
        case "CERT_NOT_YET_VALID":
            return { code, message: `The TLS certificate of ${host} is not valid yet. ${certHint}` };
        case "ERR_TLS_CERT_ALTNAME_INVALID":
            return { code, message: `The TLS certificate is not valid for "${hostname}" (${(err && err.reason) || "host name mismatch"}). ${certHint}` };
        case "ERR_SSL_WRONG_VERSION_NUMBER":
        case "ERR_SSL_PACKET_LENGTH_TOO_LONG":
            return { code, message: `TLS handshake with ${host} failed. Is this an https:// URL for a server that only speaks http://?` };
        default:
            break;
    }
    // OpenSSL (node) says "wrong version number", BoringSSL (Electron) "WRONG_VERSION_NUMBER"
    if (/wrong[ _]version[ _]number|packet[ _]length[ _]too[ _]long|http[ _]request/i.test(msg)) {
        return { code, message: `TLS handshake with ${host} failed. Is this an https:// URL for a server that only speaks http://?` };
    }
    if (code === "EPROTO") {
        // keep only the readable part of OpenSSL's "write EPROTO 00...:error:0A00010B:SSL routines:func:reason:file:line"
        const reason = ((/SSL routines:[^:]*:([^:]+)/.exec(msg) || [])[1] || "").replace(/_/g, " ").toLowerCase().trim();
        return { code, message: `TLS handshake with ${host} failed${reason ? ` (${reason})` : ""}.` };
    }
    if (code.startsWith("HPE_") || code === "ERR_HTTP_INVALID_HEADER_VALUE") {
        return { code, message: `${host} sent an invalid HTTP response (${(err && err.reason) || msg}). Is it an HTTP server on this port?` };
    }
    if (code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL") || /certificate|ssl|tls/i.test(msg)) {
        return { code, message: `TLS error with ${host}: ${msg}` };
    }
    return { code, message: msg };
}

// ------------------------------------------------------------------ TLS details

function distinguishedName(obj) {
    if (!obj || typeof obj !== "object") return null;
    const parts = Object.entries(obj).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("+") : v}`);
    return parts.length ? parts.join(", ") : null;
}

function isoDate(text) {
    if (!text) return null;
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? String(text) : d.toISOString();
}

function tlsInfo(socket) {
    if (!socket || typeof socket.getPeerCertificate !== "function") return null;
    try {
        const cert = socket.getPeerCertificate(false) || {};
        const cipher = typeof socket.getCipher === "function" ? socket.getCipher() : null;
        const authError = socket.authorizationError;
        return {
            protocol: (typeof socket.getProtocol === "function" && socket.getProtocol()) || null,
            cipher: (cipher && cipher.name) || null,
            authorized: !!socket.authorized,
            authorizationError: authError ? String(authError.code || authError.message || authError) : null,
            subject: distinguishedName(cert.subject),
            issuer: distinguishedName(cert.issuer),
            validFrom: isoDate(cert.valid_from),
            validTo: isoDate(cert.valid_to),
            subjectAltName: cert.subjectaltname || null,
            fingerprint256: cert.fingerprint256 || null
        };
    } catch {
        return null;
    }
}

// ------------------------------------------------------------------ body decoding

const SYNC_FLUSH = { finishFlush: zlib.constants.Z_SYNC_FLUSH }; // tolerate servers that cut the stream short
const DECODERS = {
    gzip: () => zlib.createGunzip(SYNC_FLUSH),
    "x-gzip": () => zlib.createGunzip(SYNC_FLUSH),
    // "deflate" should be zlib-wrapped, but some servers send raw deflate: look at the first two bytes
    deflate: (first) => (first && first.length >= 2 && (first[0] & 0x0f) === 0x08 && ((first[0] << 8) | first[1]) % 31 === 0
        ? zlib.createInflate(SYNC_FLUSH)
        : zlib.createInflateRaw(SYNC_FLUSH)),
    br: () => zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH }),
    zstd: typeof zlib.createZstdDecompress === "function" ? () => zlib.createZstdDecompress() : null
};

/**
 * Reads the response body: decodes Content-Encoding (streaming, so a "zip bomb" stops at the cap) and keeps at
 * most opts.maxBytes decoded bytes. -> { body, rawBytes, truncated, warning }
 */
function readBody(res, opts) {
    return new Promise((resolve, reject) => {
        const max = opts.maxBytes;
        const out = [];
        let outSize = 0;
        const raw = []; // kept (up to the cap) only to show something when decoding fails
        let rawKept = 0;
        let rawBytes = 0;
        let truncated = false;
        let finished = false;
        let warning = null;
        let decodeFailed = false;
        let streams = null; // decoder chain, created on the first chunk

        let encodings = String(res.headers["content-encoding"] || "").toLowerCase().split(",").map((s) => s.trim()).filter((e) => e && e !== "identity");
        const unsupported = encodings.find((e) => !DECODERS[e]);
        if (unsupported) {
            warning = `The body is "${unsupported}" encoded, which cannot be decoded here; it is shown as received.`;
            encodings = [];
        }

        const cleanup = () => {
            for (const s of streams || []) s.destroy();
        };
        const finish = () => {
            if (finished) return;
            finished = true;
            cleanup();
            if (decodeFailed) {
                const body = Buffer.concat(raw, rawKept);
                resolve({ body: body.length > max ? body.subarray(0, max) : body, rawBytes, truncated: rawBytes > max, warning });
                return;
            }
            resolve({ body: Buffer.concat(out, outSize), rawBytes, truncated, warning });
        };
        const fail = (err) => {
            if (finished) return;
            finished = true;
            cleanup();
            reject(err);
        };
        const push = (chunk) => {
            if (finished) return;
            const room = max - outSize;
            if (chunk.length > room) {
                if (room > 0) {
                    out.push(chunk.subarray(0, room));
                    outSize += room;
                }
                truncated = true;
                finish(); // the caller destroys the connection: no need to download the rest
                return;
            }
            out.push(chunk);
            outSize += chunk.length;
        };
        const onDecodeError = (err) => {
            if (decodeFailed || finished) return;
            decodeFailed = true;
            warning = `Could not decompress the ${encodings.join(", ")} body (${err.message}); showing the bytes as received.`;
            for (const s of streams || []) s.destroy();
            if (res.complete) finish();
            else res.resume(); // it may be paused waiting for a "drain" that will never come now
        };
        const createStreams = (firstChunk) => {
            // Content-Encoding lists codings in the order they were applied: decode in reverse
            const list = [...encodings].reverse().map((e, i) => DECODERS[e](i === 0 ? firstChunk : null));
            for (let i = 0; i < list.length - 1; i++) list[i].pipe(list[i + 1]);
            for (const s of list) s.on("error", onDecodeError);
            const tail = list[list.length - 1];
            tail.on("data", push);
            tail.on("end", () => {
                if (!decodeFailed) finish();
            });
            return list;
        };

        res.on("data", (chunk) => {
            rawBytes += chunk.length;
            if (!encodings.length) {
                push(chunk);
                return;
            }
            if (rawKept < max) {
                raw.push(chunk);
                rawKept += chunk.length;
            }
            if (decodeFailed || finished) return;
            if (!streams) streams = createStreams(chunk);
            if (!streams[0].write(chunk)) {
                res.pause();
                streams[0].once("drain", () => res.resume());
            }
        });
        res.on("end", () => {
            if (streams && !decodeFailed) streams[0].end();
            else finish();
        });
        res.on("error", fail);
        res.on("close", () => {
            if (!res.complete && !finished) fail(Object.assign(new Error("The connection closed before the whole response was received"), { code: "ECONNRESET" }));
        });
    });
}

const TEXT_TYPES = /^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|yaml|csv|graphql|html|event-stream|x-ndjson/i;
const BINARY_TYPES = /^(image|audio|video|font)\/|octet-stream|pdf|zip|gzip|protobuf|msgpack|wasm|x-tar|vnd\.ms-|officedocument/i;

function looksLikeText(buf) {
    const sample = buf.subarray(0, 4096);
    if (sample.includes(0)) return false;
    try {
        // a multi-byte character may be cut at the end of the sample: ignore the last 3 bytes
        new TextDecoder("utf-8", { fatal: true }).decode(sample.length > 8 ? sample.subarray(0, sample.length - 3) : sample);
        return true;
    } catch {
        return false;
    }
}

function decodeText(buf, contentType) {
    if (!buf.length) return "";
    const charset = (/charset\s*=\s*"?([^";\s]+)/i.exec(contentType) || [])[1];
    let text;
    if (charset && !/^utf-?8$/i.test(charset)) {
        try {
            text = new TextDecoder(charset).decode(buf);
        } catch {
            text = undefined; // unknown charset label: fall back to UTF-8
        }
    }
    if (text === undefined) text = buf.toString("utf8");
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseJsonMaybe(text, contentType) {
    if (!text) return undefined;
    const ct = String(contentType || "").toLowerCase();
    const trimmed = text.trimStart();
    const jsonType = /json/.test(ct);
    if (!jsonType && !(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
    if (!jsonType && /html|xml/.test(ct)) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

// ------------------------------------------------------------------ cookies

function parseSetCookies(setCookies, url) {
    const out = [];
    for (const str of setCookies || []) {
        let c;
        try {
            c = Cookie.parse(str, { loose: true });
        } catch {
            c = null;
        }
        if (!c) continue;
        let expires = null;
        if (c.maxAge !== null && c.maxAge !== undefined && c.maxAge !== "Infinity" && Number.isFinite(Number(c.maxAge))) {
            expires = new Date(Date.now() + Number(c.maxAge) * 1000).toISOString();
        } else if (c.expires instanceof Date && !Number.isNaN(c.expires.getTime())) {
            expires = c.expires.toISOString();
        }
        out.push({
            name: c.key,
            value: c.value,
            domain: c.domain || url.hostname,
            path: c.path || defaultPath(url.pathname),
            expires,
            httpOnly: !!c.httpOnly,
            secure: !!c.secure,
            sameSite: c.sameSite || null
        });
    }
    return out;
}

/** Explicit Cookie header first, then jar cookies with names not already in it. */
function mergeCookieHeader(pairs, jarCookie) {
    if (!jarCookie) return pairs;
    const idx = pairs.findIndex(([k]) => lower(k) === "cookie");
    if (idx < 0) return [...pairs, ["Cookie", jarCookie]];
    const manual = pairs[idx][1];
    const names = new Set(manual.split(";").map((p) => p.split("=")[0].trim()).filter(Boolean));
    const extra = jarCookie.split("; ").filter((p) => !names.has(p.split("=")[0].trim()));
    if (!extra.length) return pairs;
    const copy = pairs.slice();
    copy[idx] = [pairs[idx][0], [manual.replace(/;\s*$/, ""), ...extra].filter(Boolean).join("; ")];
    return copy;
}

// ------------------------------------------------------------------ one request / response exchange

/** Header pairs -> object for http.request; same names (any case) become arrays. Validates names/values. */
function headerObject(pairs) {
    const obj = {};
    const names = new Map();
    for (const [name, value] of pairs) {
        try {
            http.validateHeaderName(name);
            http.validateHeaderValue(name, value);
        } catch (err) {
            throw Object.assign(new Error(`Header "${name}" is not valid: ${err.message}`), { code: "INVALID_HEADER" });
        }
        const key = names.get(lower(name));
        if (key === undefined) {
            names.set(lower(name), name);
            obj[name] = value;
        } else if (lower(name) === "cookie") {
            obj[key] = `${obj[key]}; ${value}`;
        } else {
            obj[key] = [].concat(obj[key], value);
        }
    }
    return obj;
}

function performHop(ctx, target, method, pairs, body, shouldFollow) {
    return new Promise((resolve, reject) => {
        if (ctx.failure) {
            reject(Object.assign(new Error(ctx.failure.message), { code: ctx.failure.code }));
            return;
        }
        const isHttps = target.protocol === "https:";
        const t = { start: performance.now(), socket: null, lookup: null, connect: null, secure: null, firstByte: null, end: null };
        ctx.hop = t;
        ctx.tls = null;
        let settled = false;
        const settle = (fn, value) => {
            if (settled) return;
            settled = true;
            ctx.req = null;
            ctx.failHop = null;
            fn(value);
        };
        ctx.failHop = (err) => settle(reject, err);
        let req;
        try {
            req = (isHttps ? https : http).request({
                method,
                protocol: target.protocol,
                hostname: target.hostname.replace(/^\[|\]$/g, ""),
                port: target.port || (isHttps ? 443 : 80),
                path: `${target.pathname || "/"}${target.search}`,
                headers: headerObject(pairs),
                agent: (ctx.proxy && ctx.proxy.agent) || false, // no pooling: every request gets a fresh connection and real timings
                maxHeaderSize: MAX_HEADER_BYTES,
                rejectUnauthorized: ctx.opts.verifyTls
            });
        } catch (err) {
            settle(reject, err);
            return;
        }
        ctx.req = req;
        req.on("socket", (socket) => {
            t.socket = performance.now(); // with a proxy: the proxy connection (and CONNECT tunnel) is up
            if (!socket.connecting) return; // proxy agents hand over a connected socket
            socket.once("lookup", () => { t.lookup = performance.now(); });
            socket.once("connect", () => { t.connect = performance.now(); });
            socket.once("secureConnect", () => {
                t.secure = performance.now();
                ctx.tls = tlsInfo(socket);
            });
        });
        req.on("error", (err) => settle(reject, err));
        req.on("response", (res) => {
            t.firstByte = performance.now();
            if (isHttps && !ctx.tls) ctx.tls = tlsInfo(res.socket);
            const base = {
                status: res.statusCode,
                statusText: res.statusMessage || http.STATUS_CODES[res.statusCode] || "",
                httpVersion: res.httpVersion,
                rawHeaders: res.rawHeaders,
                setCookies: [].concat(res.headers["set-cookie"] || []),
                location: res.headers.location || "",
                remoteAddress: (res.socket && res.socket.remoteAddress) || "",
                remotePort: (res.socket && res.socket.remotePort) || null,
                follow: shouldFollow(res.statusCode, res.headers.location)
            };
            if (base.follow) {
                // redirect hop: the body is not needed, just drain it
                res.on("error", (err) => settle(reject, err));
                res.on("close", () => {
                    if (!res.complete) settle(reject, Object.assign(new Error("The connection closed during a redirect"), { code: "ECONNRESET" }));
                });
                res.on("end", () => {
                    t.end = performance.now();
                    settle(resolve, { ...base, body: Buffer.alloc(0), rawBytes: 0, truncated: false, warning: null });
                });
                res.resume();
                return;
            }
            readBody(res, ctx.opts).then((r) => {
                t.end = performance.now();
                if (r.truncated) req.destroy(); // stop downloading the rest
                settle(resolve, { ...base, ...r });
            }, (err) => settle(reject, err));
        });
        if (body) req.end(body);
        else req.end();
    });
}

// ------------------------------------------------------------------ result building

function computeTimings(hop, started, endedAt, hadRedirects) {
    const end = endedAt ?? performance.now();
    if (!hop) return { dns: null, connect: null, tls: null, firstByte: null, download: null, total: round(end - started), redirect: null };
    const sentAt = hop.secure ?? hop.connect ?? hop.lookup ?? hop.start;
    return {
        dns: hop.lookup !== null ? round(hop.lookup - hop.start) : null,
        connect: hop.connect !== null ? round(hop.connect - (hop.lookup ?? hop.start)) : null,
        tls: hop.secure !== null ? round(hop.secure - (hop.connect ?? hop.lookup ?? hop.start)) : null,
        firstByte: hop.firstByte !== null ? round(hop.firstByte - sentAt) : null,
        download: hop.end !== null && hop.firstByte !== null ? round(hop.end - hop.firstByte) : null,
        total: round(end - started),
        redirect: hadRedirects ? round(hop.start - started) : null
    };
}

function emptyResponse(url) {
    return {
        status: 0,
        statusText: "",
        httpVersion: "",
        url,
        headers: [],
        headersMap: {},
        cookies: [],
        body: Buffer.alloc(0),
        bodyText: "",
        json: undefined,
        contentType: "",
        size: { headers: 0, body: 0, transferred: 0 },
        timings: { dns: null, connect: null, tls: null, firstByte: null, download: null, total: 0, redirect: null },
        redirects: [],
        remoteAddress: "",
        remotePort: null,
        truncated: false,
        tls: null,
        error: null,
        warnings: [],
        request: null
    };
}

function finalResponse(hop, target, state) {
    const headers = [];
    for (let i = 0; i + 1 < hop.rawHeaders.length; i += 2) headers.push([hop.rawHeaders[i], hop.rawHeaders[i + 1]]);
    const headersMap = {};
    for (const [k, v] of headers) {
        const key = lower(k);
        headersMap[key] = key in headersMap ? `${headersMap[key]}, ${v}` : v;
    }
    const contentType = headersMap["content-type"] || "";
    const textual = hop.body.length > 0 && (TEXT_TYPES.test(contentType) || (!BINARY_TYPES.test(contentType) && looksLikeText(hop.body)));
    const bodyText = textual ? decodeText(hop.body, contentType) : "";
    const headerBytes = Buffer.byteLength(`HTTP/${hop.httpVersion} ${hop.status} ${hop.statusText}\r\n`)
        + headers.reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(String(v)) + 4, 0) + 2;
    const warnings = [...state.warnings];
    if (hop.warning) warnings.push(hop.warning);
    if (hop.truncated) warnings.push(`The response is larger than ${Math.round(state.opts.maxBytes / 1024 / 1024 * 10) / 10} MB and was cut (Settings > Max response size).`);
    return {
        ...emptyResponse(target.href),
        status: hop.status,
        statusText: hop.statusText,
        httpVersion: hop.httpVersion,
        headers,
        headersMap,
        cookies: [...state.cookies.values()],
        body: hop.body,
        bodyText,
        json: parseJsonMaybe(bodyText, contentType),
        contentType,
        size: { headers: headerBytes, body: hop.body.length, transferred: hop.rawBytes },
        timings: computeTimings(state.ctx.hop, state.started, state.ctx.hop && state.ctx.hop.end, state.redirects.length > 0),
        redirects: state.redirects,
        remoteAddress: hop.remoteAddress,
        remotePort: hop.remotePort,
        truncated: !!hop.truncated,
        tls: state.ctx.tls,
        warnings,
        request: state.sent
    };
}

function errorResponse(error, url, state) {
    return {
        ...emptyResponse(url),
        cookies: state ? [...state.cookies.values()] : [],
        timings: state ? computeTimings(state.ctx.hop, state.started, null, state.redirects.length > 0) : emptyResponse(url).timings,
        redirects: state ? state.redirects : [],
        tls: state ? state.ctx.tls : null,
        warnings: state ? state.warnings : [],
        request: state ? state.sent : null,
        error
    };
}

// ------------------------------------------------------------------ public API

/**
 * Sends a PreparedRequest (see prepare.js). Never rejects for network errors.
 *  settings:  app settings (proxy, maxResponseMB, defaults for timeout / redirects / TLS)
 *  cookieJar: tough-cookie CookieJar or null (matching cookies are sent, Set-Cookie stored)
 *  signal:    AbortSignal (-> error code "ABORTED")
 * -> HttpResponse (see spec 2.2) plus: size.transferred (bytes on the wire), timings.redirect (ms before the
 *    final hop), remotePort, warnings[], request { method, url, headers } (what was sent in the final hop).
 */
async function sendRequest(prepared, { settings = null, cookieJar = null, signal = null } = {}) {
    const p = prepared || {};
    const opts = resolveSendOptions(p, settings);
    // failHop: ends the hop in progress at once (timeout / cancel); connectAbort: closes a pending proxy socket
    const ctx = { opts, req: null, hop: null, tls: null, failure: null, proxy: null, failHop: null, connectAbort: new AbortController() };
    const state = { ctx, opts, started: performance.now(), redirects: [], cookies: new Map(), warnings: [], sent: null };
    let method = String(p.method || "GET").trim().toUpperCase() || "GET";
    let pairs = headerPairs(p.headers);
    let body = toBodyBuffer(p.body);

    let target;
    try {
        target = parseTarget(p.url);
    } catch (err) {
        return errorResponse({ code: err.code || "INVALID_URL", message: err.message }, String(p.url || ""), state);
    }
    if (signal && signal.aborted) return errorResponse({ code: "ABORTED", message: "Request cancelled" }, target.href, state);

    const stop = (code, message) => {
        if (ctx.failure) return;
        ctx.failure = { code, message };
        const err = Object.assign(new Error(message), { code });
        if (ctx.req) ctx.req.destroy(err);
        ctx.connectAbort.abort(err);
        if (ctx.failHop) ctx.failHop(err);
    };
    const onTimeout = () => {
        const limit = fmtDuration(opts.timeoutMs);
        const hint = "Increase the timeout in Settings or in the request's Settings tab.";
        const lowerHint = `${hint.charAt(0).toLowerCase()}${hint.slice(1)}`;
        if (ctx.proxy && ctx.hop && ctx.hop.socket === null) {
            // the proxy agent has not handed over a connection yet: the proxy (or the tunnel through it) hangs
            stop("TIMEOUT", `Could not connect to ${target.host} through the proxy ${ctx.proxy.label} within ${limit} (timeout). Check Settings > Proxy, or ${lowerHint}`);
            return;
        }
        const connecting = ctx.hop && ctx.hop.connect === null && ctx.hop.firstByte === null && !ctx.proxy;
        stop("TIMEOUT", connecting
            ? `Could not connect to ${target.host} within ${limit} (timeout). Check the host, port and firewall, or ${lowerHint}`
            : `No response within ${limit} (timeout). ${hint}`);
    };
    const timer = opts.timeoutMs > 0 ? setTimeout(onTimeout, opts.timeoutMs) : null;
    const onAbort = () => stop("ABORTED", "Request cancelled");
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    try {
        for (;;) {
            ctx.proxy = await proxyAgentFor(target, opts.proxy, opts.verifyTls, ctx.connectAbort.signal);
            let hopPairs = without(pairs, "content-length", "transfer-encoding");
            if (cookieJar) {
                let jarCookie = "";
                try {
                    jarCookie = await cookieJar.getCookieString(target.href);
                } catch {
                    jarCookie = "";
                }
                hopPairs = mergeCookieHeader(hopPairs, jarCookie);
            }
            if (body) hopPairs.push(["Content-Length", String(body.length)]);
            else if (METHODS_WITH_BODY.has(method)) hopPairs.push(["Content-Length", "0"]);
            state.sent = { method, url: target.href, headers: hopPairs };

            const hop = await performHop(ctx, target, method, hopPairs, body,
                (status, location) => opts.followRedirects && REDIRECT_STATUSES.has(status) && !!location);

            for (const c of parseSetCookies(hop.setCookies, target)) state.cookies.set(`${c.domain}|${c.path}|${c.name}`, c);
            if (cookieJar && hop.setCookies.length) {
                for (const sc of hop.setCookies) {
                    try {
                        await cookieJar.setCookie(sc, target.href, { ignoreError: true });
                    } catch {
                        // a cookie the jar refuses (wrong domain, bad syntax) is simply not stored
                    }
                }
            }
            if (!hop.follow) return finalResponse(hop, target, state);

            let next = null;
            try {
                next = new URL(hop.location, target);
            } catch {
                next = null;
            }
            if (!next || (next.protocol !== "http:" && next.protocol !== "https:")) {
                state.warnings.push(`Redirect to "${hop.location}" was not followed (not an http(s) URL).`);
                return finalResponse({ ...hop, body: Buffer.alloc(0), rawBytes: 0 }, target, state);
            }
            if (state.redirects.length >= opts.maxRedirects) {
                return errorResponse({ code: "TOO_MANY_REDIRECTS", message: `Stopped after ${opts.maxRedirects} redirects (last one to ${next.href}). Is there a redirect loop?` }, target.href, state);
            }
            state.redirects.push({ status: hop.status, url: target.href, location: next.href });
            if ([301, 302, 303].includes(hop.status) && method !== "HEAD") {
                method = "GET";
                body = null;
                pairs = without(pairs, "content-type", "content-length", "transfer-encoding");
            }
            if (next.origin !== target.origin) {
                // like browsers and curl: credentials are not sent to another host
                pairs = without(pairs, "authorization", "cookie", "host", "proxy-authorization");
            }
            target = next;
        }
    } catch (err) {
        const viaProxy = ctx.proxy && ctx.hop && ctx.hop.socket === null ? describeProxyError(err, ctx.proxy.label, target) : null;
        const error = ctx.failure || viaProxy || describeNetworkError(err, target);
        return errorResponse(error, target.href, state);
    } finally {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
    }
}

module.exports = {
    sendRequest,
    DEFAULT_SETTINGS,
    USER_AGENT,
    APP_VERSION,
    describeNetworkError,
    describeProxyError,
    parseTarget,
    bypassesProxy,
    resolveSendOptions
};
