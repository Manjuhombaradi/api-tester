"use strict";
// Extra trusted CA certificates (company root certificates, e.g. behind a TLS-inspecting proxy).
//
// The installed app has Electron's NODE_OPTIONS fuse turned off, which also makes Node ignore
// NODE_EXTRA_CA_CERTS. So the app loads extra certificates itself, from:
//   - the "Trusted CA certificates" file in Settings (desktop app),
//   - --ca-file <pem> / API_TESTER_CA_FILE (command line),
//   - NODE_EXTRA_CA_CERTS, read explicitly here so existing company setups keep working.
// They are added to Node's built-in (Mozilla) root list for every HTTPS connection: requests, OAuth 2.0
// token requests and proxies. Nothing is downloaded and the operating system store is not changed.
const fs = require("fs");
const tls = require("tls");

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
let applied = { sources: [], count: 0 };
// runtimes without tls.setDefaultCACertificates (Node < 22.19): http.js passes this list as "ca" per connection
let fallbackCa = null;

/** PEM text -> list of certificate blocks; throws a readable Error when the file holds none. */
function parsePemCertificates(text, label) {
    const blocks = String(text || "").match(PEM_BLOCK) || [];
    if (!blocks.length) throw new Error(`${label} contains no PEM certificate (-----BEGIN CERTIFICATE----- ...)`);
    for (const pem of blocks) {
        try {
            new (require("crypto").X509Certificate)(pem);
        } catch (err) {
            throw new Error(`${label} contains an invalid certificate: ${err.message}`);
        }
    }
    return blocks;
}

function readPemFile(file, label) {
    let text;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch (err) {
        throw new Error(`${label} ${file} cannot be read: ${err.code === "ENOENT" ? "file not found" : err.message}`);
    }
    return parsePemCertificates(text, `${label} ${file}`);
}

/**
 * Sets the trusted roots to Node's bundled list plus the given PEM files (later calls replace earlier ones).
 * files: [{ path, label }] ; empty list = bundled roots only. -> { count, sources }. Throws on unreadable files.
 */
function applyExtraCaFiles(files) {
    const extra = [];
    const sources = [];
    for (const f of files || []) {
        if (!f || !f.path) continue;
        const certs = readPemFile(f.path, f.label || "CA certificate file");
        extra.push(...certs);
        sources.push({ path: f.path, label: f.label || "", count: certs.length });
    }
    if (typeof tls.setDefaultCACertificates === "function") {
        const bundled = typeof tls.getCACertificates === "function" ? tls.getCACertificates("bundled") : tls.rootCertificates;
        tls.setDefaultCACertificates([...bundled, ...extra]);
        fallbackCa = null;
    } else {
        fallbackCa = extra.length ? [...tls.rootCertificates, ...extra] : null;
    }
    applied = { sources, count: extra.length };
    return applied;
}

/** The NODE_EXTRA_CA_CERTS file (if set) as an entry for applyExtraCaFiles. */
function envCaFiles(env = process.env) {
    const out = [];
    if (env.NODE_EXTRA_CA_CERTS) out.push({ path: env.NODE_EXTRA_CA_CERTS, label: "NODE_EXTRA_CA_CERTS" });
    return out;
}

function currentExtraCa() {
    return applied;
}

/** Extra "ca" option for TLS connections on runtimes that cannot change the default roots, else undefined. */
function tlsCaOption() {
    return fallbackCa || undefined;
}

module.exports = { applyExtraCaFiles, envCaFiles, parsePemCertificates, currentExtraCa, tlsCaOption };
