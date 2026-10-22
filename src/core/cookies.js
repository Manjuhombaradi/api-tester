"use strict";
// Cookie jar helpers (tough-cookie): one jar per suite session / runner run, so a login response's
// Set-Cookie is sent with the following requests like a browser would.
const { CookieJar, MemoryCookieStore } = require("tough-cookie");

const JAR_OPTIONS = {
    looseMode: true, // accept "name" cookies without "=" like browsers
    allowSpecialUseDomain: true, // localhost, *.local, *.test ... are normal hosts for testers
    rejectPublicSuffixes: true
};

function createCookieJar() {
    return new CookieJar(new MemoryCookieStore(), JAR_OPTIONS);
}

/** Plain JSON object (store it as is; deserializeJar turns it back into a jar). */
function serializeJar(jar) {
    if (!jar) return null;
    try {
        return jar.serializeSync();
    } catch {
        return null;
    }
}

/** Jar from serializeJar output; anything invalid gives an empty jar. */
function deserializeJar(obj) {
    if (!obj || typeof obj !== "object") return createCookieJar();
    try {
        const restored = CookieJar.deserializeSync(obj, new MemoryCookieStore());
        return restored || createCookieJar();
    } catch {
        return createCookieJar();
    }
}

function expiresToIso(expires) {
    if (!expires || expires === "Infinity") return null;
    const d = expires instanceof Date ? expires : new Date(expires);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** -> [{ domain, path, name, value, expires (ISO or null = session), httpOnly, secure, hostOnly, sameSite }] (expired ones left out). */
function listCookies(jar) {
    const data = serializeJar(jar);
    if (!data || !Array.isArray(data.cookies)) return [];
    const now = Date.now();
    return data.cookies
        .map((c) => ({
            domain: c.domain || "",
            path: c.path || "/",
            name: c.key || "",
            value: c.value === undefined || c.value === null ? "" : String(c.value),
            expires: expiresToIso(c.expires),
            httpOnly: !!c.httpOnly,
            secure: !!c.secure,
            hostOnly: !!c.hostOnly,
            sameSite: c.sameSite || null,
            maxAge: c.maxAge
        }))
        .filter((c) => {
            if (typeof c.maxAge === "number" && c.maxAge <= 0) return false;
            return !c.expires || new Date(c.expires).getTime() > now;
        })
        .map(({ maxAge, ...c }) => c) // eslint-disable-line no-unused-vars
        .sort((a, b) => a.domain.localeCompare(b.domain) || a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
}

function clearCookies(jar) {
    if (!jar) return;
    try {
        jar.removeAllCookiesSync();
    } catch {
        // stores without sync support are not used here
    }
}

/** Removes one cookie (e.g. a "delete" button in a cookie list). */
function removeCookie(jar, { domain, path = "/", name }) {
    if (!jar || !jar.store) return;
    try {
        jar.store.removeCookie(domain, path, name, () => {});
    } catch {
        // ignore: nothing to remove
    }
}

module.exports = { createCookieJar, serializeJar, deserializeJar, listCookies, clearCookies, removeCookie };
