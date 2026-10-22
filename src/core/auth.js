"use strict";
// OAuth 2.0 access tokens for the "oauth2" auth type: client credentials and password grants, client
// authentication in the body or as HTTP Basic, and an in-memory cache so a suite run fetches a token once.
const crypto = require("crypto");
const { sendRequest, USER_AGENT } = require("./http");

const EXPIRY_MARGIN_MS = 30 * 1000; // a cached token is renewed 30 s before it expires
const UNKNOWN_EXPIRY_CACHE_MS = 10 * 60 * 1000; // token responses without expires_in: reuse for 10 minutes
const GRANT_TYPES = ["client_credentials", "password"];

/** Cache for getOAuth2Token: a Map (key -> { token, validUntil }); call .clear() to forget all tokens. */
function createOAuthCache() {
    return new Map();
}

const inFlight = new WeakMap(); // cache -> Map(key -> Promise): parallel requests share one token request

function str(v) {
    return v === undefined || v === null ? "" : String(v).trim();
}

function normalizeConfig(oauth2) {
    const o = oauth2 || {};
    return {
        grantType: str(o.grantType) || "client_credentials",
        tokenUrl: str(o.tokenUrl),
        clientId: str(o.clientId),
        clientSecret: o.clientSecret === undefined || o.clientSecret === null ? "" : String(o.clientSecret),
        scope: str(o.scope),
        audience: str(o.audience),
        username: str(o.username),
        password: o.password === undefined || o.password === null ? "" : String(o.password),
        clientAuth: o.clientAuth === "basic" ? "basic" : "body"
    };
}

function cacheKey(o) {
    // secrets are part of the key (hashed), so changed credentials never reuse a token fetched with the old ones
    const secrets = crypto.createHash("sha256").update(`${o.clientSecret}\u0000${o.grantType === "password" ? o.password : ""}`).digest("hex");
    return JSON.stringify([o.grantType, o.tokenUrl, o.clientId, o.scope, o.audience, o.grantType === "password" ? o.username : "", o.clientAuth, secrets]);
}

function validate(o) {
    if (!GRANT_TYPES.includes(o.grantType)) throw new Error(`OAuth 2.0: grant type "${o.grantType}" is not supported (use client_credentials or password)`);
    if (!o.tokenUrl) throw new Error("OAuth 2.0: the Token URL is empty");
    if (!o.clientId) throw new Error("OAuth 2.0: the Client ID is empty");
    if (o.grantType === "password" && !o.username) throw new Error("OAuth 2.0 (password grant): the user name is empty");
}

function snippet(text, max = 300) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** RFC 6749 2.3.1: client id / secret are form-encoded before they go into the Basic header. */
function formEncode(s) {
    return encodeURIComponent(s).replace(/%20/g, "+");
}

function parseTokenBody(response) {
    if (response.json && typeof response.json === "object") return response.json;
    const text = response.bodyText || "";
    // some providers (e.g. GitHub) answer with a form-encoded body
    if (/x-www-form-urlencoded/i.test(response.contentType) || /^[\w.-]+=[^&]*(&[\w.-]+=[^&]*)*$/.test(text.trim())) {
        return Object.fromEntries(new URLSearchParams(text.trim()));
    }
    return null;
}

async function requestToken(o, settings, signal) {
    const form = new URLSearchParams();
    form.set("grant_type", o.grantType);
    if (o.grantType === "password") {
        form.set("username", o.username);
        form.set("password", o.password);
    }
    if (o.scope) form.set("scope", o.scope);
    if (o.audience) form.set("audience", o.audience);
    const headers = [
        ["Content-Type", "application/x-www-form-urlencoded"],
        ["Accept", "application/json"],
        ["User-Agent", USER_AGENT]
    ];
    if (o.clientAuth === "basic") {
        headers.push(["Authorization", `Basic ${Buffer.from(`${formEncode(o.clientId)}:${formEncode(o.clientSecret)}`).toString("base64")}`]);
    } else {
        form.set("client_id", o.clientId);
        if (o.clientSecret) form.set("client_secret", o.clientSecret);
    }
    const s = settings || {};
    // Redirects are not followed: the client secret and the password (in the body or the Basic header) must only
    // go to the token URL the user entered, never to an address a server answers with.
    const response = await sendRequest({
        method: "POST",
        url: o.tokenUrl,
        headers,
        body: Buffer.from(form.toString(), "utf8"),
        settings: { timeoutMs: s.timeoutMs, followRedirects: false, maxRedirects: 0, verifyTls: s.verifyTls }
    }, { settings: s, cookieJar: null, signal, secretValues: [o.clientSecret, o.password].filter(Boolean) });

    if (response.error) {
        if (response.error.code === "ABORTED") throw Object.assign(new Error("Request cancelled"), { code: "ABORTED" });
        throw new Error(`OAuth 2.0 token request to ${o.tokenUrl} failed: ${response.error.message}`);
    }
    if (response.status >= 300 && response.status < 400) {
        const location = response.headersMap && response.headersMap.location;
        throw new Error(`OAuth 2.0 token endpoint ${o.tokenUrl} answered with a redirect (${response.status}${location ? ` to ${location}` : ""}). ` +
            "Redirects are not followed for token requests, so the client secret and password only go to the Token URL you entered. " +
            "If the new address is right, enter it as the Token URL.");
    }
    const data = parseTokenBody(response);
    if (response.status < 200 || response.status >= 300) {
        const reason = data && (data.error_description || data.error) ? [data.error, data.error_description].filter(Boolean).join(": ") : snippet(response.bodyText);
        throw new Error(`OAuth 2.0 token endpoint returned ${response.status} ${response.statusText}${reason ? `: ${reason}` : ""}`);
    }
    const accessToken = data && data.access_token ? String(data.access_token) : "";
    if (!accessToken) throw new Error(`OAuth 2.0 token response has no "access_token": ${snippet(response.bodyText) || "(empty body)"}`);
    const expiresIn = Number(data.expires_in);
    const tokenType = !data.token_type || /^bearer$/i.test(String(data.token_type)) ? "Bearer" : String(data.token_type);
    return {
        accessToken,
        tokenType,
        expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
        scope: data.scope ? String(data.scope) : o.scope,
        refreshToken: data.refresh_token ? String(data.refresh_token) : null
    };
}

/**
 * Returns a token for an oauth2 config whose {{variables}} are already resolved.
 *  settings: effective settings (timeoutMs, verifyTls, proxy, ...); cache: from createOAuthCache() or null;
 *  signal: AbortSignal; forceRefresh: ignore a cached token.
 * -> { accessToken, tokenType, expiresAt (ms epoch or null), scope, refreshToken, fromCache }
 * Errors -> Error with the token endpoint's status and body.
 */
async function getOAuth2Token(oauth2, { settings = null, cache = null, signal = null, forceRefresh = false } = {}) {
    const o = normalizeConfig(oauth2);
    validate(o);
    const key = cacheKey(o);
    if (cache && !forceRefresh) {
        const hit = cache.get(key);
        if (hit && hit.validUntil > Date.now()) return { ...hit.token, fromCache: true };
    }
    let pending = cache ? inFlight.get(cache) : null;
    if (cache && !pending) {
        pending = new Map();
        inFlight.set(cache, pending);
    }
    if (pending && pending.has(key)) return { ...(await pending.get(key)), fromCache: true };

    const promise = requestToken(o, settings, signal);
    if (pending) pending.set(key, promise);
    try {
        const token = await promise;
        if (cache) {
            const validUntil = token.expiresAt ? token.expiresAt - EXPIRY_MARGIN_MS : Date.now() + UNKNOWN_EXPIRY_CACHE_MS;
            cache.set(key, { token, validUntil });
        }
        return { ...token, fromCache: false };
    } finally {
        if (pending) pending.delete(key);
    }
}

/** A still valid cached token or null (never makes a request; used by previews). */
function peekOAuth2Token(oauth2, cache) {
    if (!cache) return null;
    const o = normalizeConfig(oauth2);
    const hit = cache.get(cacheKey(o));
    return hit && hit.validUntil > Date.now() ? { ...hit.token, fromCache: true } : null;
}

/** Forgets cached tokens: all of them, or only the one for this config. */
function clearOAuthCache(cache, oauth2 = null) {
    if (!cache) return;
    if (oauth2) cache.delete(cacheKey(normalizeConfig(oauth2)));
    else cache.clear();
}

module.exports = { getOAuth2Token, createOAuthCache, peekOAuth2Token, clearOAuthCache, EXPIRY_MARGIN_MS };
