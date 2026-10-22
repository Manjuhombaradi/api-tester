"use strict";
// Small helpers shared by the importers.

/** Any value -> string ("" for null / undefined, JSON for objects). */
function text(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "object") {
        try { return JSON.stringify(value); } catch { return ""; }
    }
    return String(value);
}

/** Descriptions are plain strings or { content, type } objects (Postman). */
function descriptionText(value) {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && typeof value.content === "string") return value.content;
    return "";
}

/** ["a", "b", "c", "d"] -> "a, b, c and 1 more" (for short, readable warnings). */
function listNames(names, max = 4) {
    const unique = [...new Set(names.filter(Boolean).map(String))];
    if (unique.length <= max) return unique.map((n) => `"${n}"`).join(", ");
    return `${unique.slice(0, max).map((n) => `"${n}"`).join(", ")} and ${unique.length - max} more`;
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** Splits "a?b#c" into { base: "a#c" without query, query: "b" } (the fragment stays on the base). */
function splitQuery(url) {
    const s = String(url || "");
    const hashAt = s.indexOf("#");
    const hash = hashAt >= 0 ? s.slice(hashAt) : "";
    const noHash = hashAt >= 0 ? s.slice(0, hashAt) : s;
    const q = noHash.indexOf("?");
    if (q < 0) return { base: s, query: "" };
    return { base: noHash.slice(0, q) + hash, query: noHash.slice(q + 1) };
}

function safeDecode(value) {
    try { return decodeURIComponent(value); } catch { return value; }
}

/** "a=1&b&c=x%20y" -> [{ key, value }] (decoded, + kept as is). */
function parseQueryString(query) {
    return String(query || "").split("&").filter((p) => p !== "").map((pair) => {
        const i = pair.indexOf("=");
        return i < 0 ? { key: safeDecode(pair), value: "" } : { key: safeDecode(pair.slice(0, i)), value: safeDecode(pair.slice(i + 1)) };
    });
}

module.exports = { text, descriptionText, listNames, plural, splitQuery, parseQueryString, safeDecode };
