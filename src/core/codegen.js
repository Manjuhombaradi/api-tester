"use strict";
// Code snippets for the Code view: a PreparedRequest (prepare.js) as cURL, JavaScript fetch, Python
// requests and PowerShell Invoke-RestMethod, so testers can hand a request to developers or scripts.
const path = require("path");
const { toCurl, snippetHeaders, snippetBodyKind } = require("./curl");

const js = (s) => JSON.stringify(String(s ?? ""));

function indentRest(text, spaces) {
    const pad = " ".repeat(spaces);
    return text.split("\n").map((line, i) => (i ? pad + line : line)).join("\n");
}

/** Parsed JSON body when re-printing it is safe (no big integers that JavaScript would round). */
function jsonValue(prepared) {
    if (!["json", "graphql"].includes(prepared.bodyMode) || !prepared.bodyText) return undefined;
    if (/\d{16,}/.test(prepared.bodyText)) return undefined;
    try {
        const v = JSON.parse(prepared.bodyText);
        return v && typeof v === "object" ? v : undefined;
    } catch {
        return undefined;
    }
}

function fileNameOf(part) {
    return part.fileName || path.basename(part.filePath || "file");
}

// ------------------------------------------------------------------ JavaScript (fetch)

function toFetch(prepared) {
    const p = prepared || {};
    const method = String(p.method || "GET").toUpperCase();
    const kind = snippetBodyKind(p);
    const headers = snippetHeaders(p);
    const before = [];
    let body = null;
    let needsFs = false;

    if (kind === "multipart") {
        before.push("const form = new FormData();");
        for (const part of p.multipart) {
            if (part.type === "file") {
                needsFs = true;
                const type = part.contentType ? `, { type: ${js(part.contentType)} }` : "";
                before.push(`form.append(${js(part.key)}, await openAsBlob(${js(part.filePath)}${type}), ${js(fileNameOf(part))});`);
            } else if (part.contentType) {
                before.push(`form.append(${js(part.key)}, new Blob([${js(part.value)}], { type: ${js(part.contentType)} }));`);
            } else {
                before.push(`form.append(${js(part.key)}, ${js(part.value)});`);
            }
        }
        body = "form";
    } else if (kind === "binary") {
        needsFs = true;
        body = `await openAsBlob(${js(p.binaryPath)})`;
    } else if (kind === "text") {
        const value = jsonValue(p);
        if (p.bodyMode === "form" && Array.isArray(p.form) && p.form.length) {
            body = `new URLSearchParams([\n${p.form.map(([k, v]) => `        [${js(k)}, ${js(v)}]`).join(",\n")}\n    ])`;
        } else if (value !== undefined) {
            body = `JSON.stringify(${indentRest(JSON.stringify(value, null, 4), 4)})`;
        } else {
            body = js(p.bodyText);
        }
    }

    const options = [`method: ${js(method)}`];
    if (headers.length) options.push(`headers: {\n${headers.map(([k, v]) => `        ${js(k)}: ${js(v)}`).join(",\n")}\n    }`);
    if (body) options.push(`body: ${body}`);
    if (p.settings && p.settings.followRedirects === false) options.push("redirect: \"manual\"");
    if (p.settings && p.settings.timeoutMs > 0) options.push(`signal: AbortSignal.timeout(${Math.round(p.settings.timeoutMs)})`);

    const lines = [];
    if (needsFs) lines.push("import { openAsBlob } from \"node:fs\"; // Node.js 20+; in a browser use a File from <input type=\"file\">", "");
    if (p.settings && p.settings.verifyTls === false) lines.push("// TLS certificate checks are off for this request: in Node.js run with NODE_TLS_REJECT_UNAUTHORIZED=0", "");
    lines.push(...before);
    if (before.length) lines.push("");
    lines.push(`const response = await fetch(${js(p.url)}, {\n    ${options.join(",\n    ")}\n});`);
    lines.push("console.log(response.status, response.statusText);");
    lines.push("console.log(await response.text());");
    return lines.join("\n");
}

// ------------------------------------------------------------------ Python (requests)

/** Python string literal; multi-line text as a raw triple-quoted string when that is exact. */
function py(s) {
    const text = String(s ?? "");
    if (text.includes("\n") && !text.includes("'''") && !text.includes("\r") && !/['\\]$/.test(text)) return `r'''${text}'''`;
    return JSON.stringify(text); // JSON string escapes are valid Python escapes
}

function toPython(prepared) {
    const p = prepared || {};
    const method = String(p.method || "GET").toUpperCase();
    const kind = snippetBodyKind(p);
    const headers = snippetHeaders(p);
    const lines = ["import requests", "", `url = ${py(p.url)}`, ""];
    const args = ["url"];

    if (headers.length) {
        lines.push("headers = {", ...headers.map(([k, v]) => `    ${py(k)}: ${py(v)},`), "}", "");
        args.push("headers=headers");
    }
    if (kind === "multipart") {
        lines.push("files = [");
        for (const part of p.multipart) {
            if (part.type === "file") {
                const type = part.contentType ? `, ${py(part.contentType)}` : "";
                lines.push(`    (${py(part.key)}, (${py(fileNameOf(part))}, open(${JSON.stringify(part.filePath)}, "rb")${type})),`);
            } else {
                const type = part.contentType ? `, ${py(part.contentType)}` : "";
                lines.push(`    (${py(part.key)}, (None, ${py(part.value)}${type})),`);
            }
        }
        lines.push("]", "");
        args.push("files=files");
    } else if (kind === "binary") {
        lines.push(`payload = open(${JSON.stringify(p.binaryPath)}, "rb")`, "");
        args.push("data=payload");
    } else if (kind === "text") {
        if (p.bodyMode === "form" && Array.isArray(p.form) && p.form.length) {
            lines.push("payload = [", ...p.form.map(([k, v]) => `    (${py(k)}, ${py(v)}),`), "]", "");
            args.push("data=payload"); // requests form-encodes the list itself
        } else {
            lines.push(`payload = ${py(p.bodyText)}`, "");
            // requests sends str bodies as Latin-1: non-ASCII text must be encoded explicitly
            args.push(/[^\x00-\x7f]/.test(p.bodyText) ? "data=payload.encode(\"utf-8\")" : "data=payload"); // eslint-disable-line no-control-regex
        }
    }
    const s = p.settings || {};
    if (s.timeoutMs > 0) args.push(`timeout=${Math.round(s.timeoutMs / 100) / 10}`);
    if (s.verifyTls === false) args.push("verify=False");
    if (s.followRedirects === false) args.push("allow_redirects=False");

    lines.push(`response = requests.request(${py(method)}, ${args.join(", ")})`, "", "print(response.status_code)", "print(response.text)");
    return lines.join("\n");
}

// ------------------------------------------------------------------ PowerShell (Invoke-RestMethod)

/** PowerShell single-quoted string: only quotes (incl. typographic ones) need doubling. */
function ps(s) {
    return `'${String(s ?? "").replace(/['\u2018\u2019\u201A\u201B]/g, (c) => c + c)}'`;
}

const PS_METHODS = { GET: "Get", POST: "Post", PUT: "Put", PATCH: "Patch", DELETE: "Delete", HEAD: "Head", OPTIONS: "Options", TRACE: "Trace", MERGE: "Merge" };

function toPowerShell(prepared) {
    const p = prepared || {};
    const method = String(p.method || "GET").toUpperCase();
    const kind = snippetBodyKind(p);
    const lines = [];
    const params = [["Uri", ps(p.url)]];
    if (PS_METHODS[method]) params.push(["Method", ps(PS_METHODS[method])]);
    else params.push(["CustomMethod", ps(method)]); // PowerShell 7+

    // Content-Type and User-Agent have their own parameters (Windows PowerShell 5.1 rejects them in -Headers)
    const headers = [];
    for (const [k, v] of snippetHeaders(p)) {
        const n = String(k).toLowerCase();
        if (n === "content-type") params.push(["ContentType", ps(v)]);
        else if (n === "user-agent") params.push(["UserAgent", ps(v)]);
        else if (n === "accept" && v === "*/*") continue; // the default
        else headers.push([k, v]);
    }
    if (headers.length) {
        lines.push("$headers = @{", ...headers.map(([k, v]) => `    ${ps(k)} = ${ps(v)}`), "}", "");
        params.push(["Headers", "$headers"]);
    }
    const notes = [];
    if (kind === "multipart") {
        lines.push("$form = @{");
        for (const part of p.multipart) {
            lines.push(part.type === "file" ? `    ${ps(part.key)} = Get-Item -LiteralPath ${ps(part.filePath)}` : `    ${ps(part.key)} = ${ps(part.value)}`);
        }
        lines.push("}", "");
        params.push(["Form", "$form"]);
        notes.push("-Form needs PowerShell 7+");
    } else if (kind === "binary") {
        params.push(["InFile", ps(p.binaryPath)]);
    } else if (kind === "text") {
        params.push(["Body", ps(p.bodyText)]);
    }
    const s = p.settings || {};
    if (s.timeoutMs > 0) params.push(["TimeoutSec", String(Math.max(1, Math.ceil(s.timeoutMs / 1000)))]);
    if (s.verifyTls === false) {
        params.push(["SkipCertificateCheck", "$true"]);
        notes.push("-SkipCertificateCheck needs PowerShell 7+");
    }
    if (s.followRedirects === false) params.push(["MaximumRedirection", "0"]);
    if (!PS_METHODS[method]) notes.push("-CustomMethod needs PowerShell 7+");

    const width = Math.max(...params.map(([k]) => k.length));
    if (notes.length) lines.unshift(`# ${notes.join("; ")}`);
    lines.push("$params = @{", ...params.map(([k, v]) => `    ${k.padEnd(width)} = ${v}`), "}", "");
    lines.push("$response = Invoke-RestMethod @params", "$response");
    return lines.join("\n");
}

// ------------------------------------------------------------------ public API

/** -> { curl, fetch (JavaScript), python (requests), powershell (Invoke-RestMethod) } */
function codeSnippets(prepared) {
    const p = prepared || {};
    return { curl: toCurl(p), fetch: toFetch(p), python: toPython(p), powershell: toPowerShell(p) };
}

module.exports = { codeSnippets, toCurl, toFetch, toPython, toPowerShell };
