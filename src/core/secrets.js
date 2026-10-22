"use strict";
// What counts as a credential, shared by the runner (masking results), the reporters, the HTTP client (headers
// that are not sent to another server on a redirect) and suite export (Auth fields left out of shared files).
// Masking writes "•••••" and keeps the part that is not secret: "Bearer •••••", "session=•••••; Path=/".

const MASK = "•••••";
const MIN_SECRET_CHARS = 3; // shorter values are not masked (they would hide "1", "ok", ... everywhere)

/** Auth tab fields that hold credentials: [auth type, field]. */
const SECRET_AUTH_FIELDS = [["basic", "password"], ["bearer", "token"], ["apikey", "value"], ["oauth2", "clientSecret"], ["oauth2", "password"]];

/** Header values that are always masked in results, history and reports. */
const MASKED_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);

// Header names that usually carry a credential (X-API-Key, X-Auth-Token, Api-Key, X-Session-Id, X-Amz-Security-Token,
// Ocp-Apim-Subscription-Key, ...): name parts separated by "-" or "_". CORS response headers only describe a policy.
const CREDENTIAL_NAME_RE = /(?:^|[-_])(?:auth|authorization|authentication|token|secret|password|passwd|pwd|key|apikey|session|sessionid|cookie|credentials?|signature)(?:[-_]|$)/i;

const hasVariable = (value) => /\{\{[^{}]+\}\}/.test(String(value || ""));

/** true for Authorization, Cookie, ... and for names that look like they carry a credential (X-API-Key, X-Auth-Token). */
function isCredentialHeader(name, extraNames = null) {
    const n = String(name || "").trim().toLowerCase();
    if (!n) return false;
    if (MASKED_HEADERS.has(n) || (extraNames && extraNames.has(n))) return true;
    if (n.startsWith("access-control-")) return false;
    return CREDENTIAL_NAME_RE.test(n);
}

/**
 * Masked form of a credential header value: "Bearer abc" -> "Bearer •••••", "a=1; b=2" (Cookie) -> "a=•••••; b=•••••",
 * "sid=x; Path=/; HttpOnly" (Set-Cookie) -> "sid=•••••; Path=/; HttpOnly", anything else -> "•••••". Empty stays empty.
 */
function maskHeaderValue(name, value) {
    const v = String(value ?? "");
    if (!v.trim()) return v;
    const n = String(name || "").trim().toLowerCase();
    if (n === "cookie") {
        return v.split(";").map((part) => {
            const eq = part.indexOf("=");
            return eq < 0 ? part : `${part.slice(0, eq + 1)}${MASK}`;
        }).join(";");
    }
    if (n === "set-cookie") {
        const semi = v.indexOf(";");
        const first = semi < 0 ? v : v.slice(0, semi);
        const eq = first.indexOf("=");
        return `${eq < 0 ? MASK : `${first.slice(0, eq + 1)}${MASK}`}${semi < 0 ? "" : v.slice(semi)}`;
    }
    if (n === "authorization" || n === "proxy-authorization") {
        const m = /^(\s*[A-Za-z][\w.-]*\s+)\S/.exec(v);
        if (m) return `${m[1]}${MASK}`;
    }
    return v === MASK ? v : MASK;
}

/** [[name, value]] or { name: value | value[] } with credential header values masked by name. */
function maskHeadersByName(headers, extraNames = null) {
    const one = (name, value) => (isCredentialHeader(name, extraNames) ? maskHeaderValue(name, value) : value);
    if (Array.isArray(headers)) return headers.map((pair) => (Array.isArray(pair) ? [pair[0], one(pair[0], pair[1]), ...pair.slice(2)] : pair));
    if (headers && typeof headers === "object") {
        const out = {};
        for (const [k, v] of Object.entries(headers)) out[k] = Array.isArray(v) ? v.map((x) => one(k, x)) : one(k, v);
        return out;
    }
    return headers;
}

const MIN_HEADER_SECRET_CHARS = 8; // credential header values shorter than this are not treated as secrets elsewhere

/**
 * The secret parts of a credential header value, to mask them wherever else they show up (an API echoing the
 * token in its body): "Bearer abc..." -> the token; "Basic <base64>" -> base64 and the password; "a=1; b=2" (Cookie)
 * -> the cookie values; otherwise the value. Only values of at least 8 characters (tokens, not "test" or "1").
 */
function credentialParts(name, value) {
    const n = String(name || "").trim().toLowerCase();
    const v = String(value ?? "").trim();
    if (!v || !isCredentialHeader(n)) return [];
    const out = [];
    if (n === "cookie") {
        for (const part of v.split(";")) {
            const eq = part.indexOf("=");
            if (eq > 0) out.push(part.slice(eq + 1).trim());
        }
    } else if (n === "set-cookie") {
        return [];
    } else {
        const m = /^([A-Za-z][\w.-]*)\s+(\S.*)$/.exec(v);
        if (m && (n === "authorization" || n === "proxy-authorization")) {
            out.push(m[2]);
            if (/^basic$/i.test(m[1])) {
                try {
                    const decoded = Buffer.from(m[2], "base64").toString("utf8");
                    const colon = decoded.indexOf(":");
                    if (colon >= 0 && !decoded.includes("\uFFFD")) out.push(decoded.slice(colon + 1));
                } catch {
                    // not base64: only the token itself
                }
            }
        } else {
            out.push(v);
        }
    }
    return out.filter((x) => x && x.length >= MIN_HEADER_SECRET_CHARS && x !== MASK && !hasVariable(x));
}

/** Response cookies [{ name, value, ... }] with the values masked. */
function maskCookies(cookies) {
    return Array.isArray(cookies) ? cookies.map((c) => (c && typeof c === "object" && c.value ? { ...c, value: MASK } : c)) : cookies;
}

/**
 * Copy of a request for the history (runner: result.historyRequest): credentials typed into the Auth tab are left
 * out (like a suite export without secrets), credential headers typed as text are masked ({{variable}} references
 * are kept: they are not secrets), and maskText (the runner's masker) hides secret values anywhere else in the copy.
 */
function redactRequest(request, maskText = null) {
    if (!request || typeof request !== "object") return request;
    const copy = JSON.parse(JSON.stringify(request));
    const auth = copy.auth;
    if (auth && typeof auth === "object") {
        for (const [group, field] of SECRET_AUTH_FIELDS) {
            const g = auth[group];
            if (g && typeof g === "object" && g[field] && !hasVariable(g[field])) g[field] = "";
        }
    }
    for (const h of Array.isArray(copy.headers) ? copy.headers : []) {
        if (h && typeof h === "object" && isCredentialHeader(h.key) && h.value && !hasVariable(h.value)) h.value = maskHeaderValue(h.key, h.value);
    }
    if (typeof maskText !== "function") return copy;
    const walk = (v) => {
        if (typeof v === "string") return maskText(v);
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === "object") {
            const out = {};
            for (const [k, x] of Object.entries(v)) out[k] = walk(x);
            return out;
        }
        return v;
    };
    return walk(copy);
}

module.exports = {
    MASK, MIN_SECRET_CHARS, SECRET_AUTH_FIELDS, MASKED_HEADERS,
    isCredentialHeader, maskHeaderValue, maskHeadersByName, maskCookies, redactRequest, credentialParts, hasVariable
};
