"use strict";
// cURL support: parseCurl turns a pasted command (bash / zsh, Windows cmd with ^, PowerShell with `,
// "Copy as cURL" from browsers, Postman, Insomnia) into a request; toCurl turns a PreparedRequest back into
// a readable multi-line bash command.
const { newRequest, newKeyValue, defaultAuth, defaultBody } = require("./model");
const { splitUrlCredentials } = require("./prepare");

// ------------------------------------------------------------------ tokenizing

/** Windows cmd.exe style: ^ line continuations or ^" escapes (Chrome "Copy as cURL (cmd)"). */
function isWindowsCmd(src) {
    return /\^\n/.test(src) || /\^"/.test(src);
}

function readAnsiC(src, start) {
    // bash $'...' quoting (used by Chrome "Copy as cURL (bash)" for bodies with special characters)
    let out = "";
    let i = start;
    const simple = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", "\"": "\"", "?": "?" };
    while (i < src.length) {
        const c = src[i];
        if (c === "'") return { value: out, end: i + 1 };
        if (c !== "\\") {
            out += c;
            i++;
            continue;
        }
        const n = src[i + 1];
        if (n in simple) {
            out += simple[n];
            i += 2;
        } else if (n === "x") {
            const m = /^[0-9a-fA-F]{1,2}/.exec(src.slice(i + 2));
            if (m) { out += String.fromCharCode(parseInt(m[0], 16)); i += 2 + m[0].length; } else { out += "\\x"; i += 2; }
        } else if (n === "u" || n === "U") {
            const m = (n === "u" ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/).exec(src.slice(i + 2));
            if (m) { out += String.fromCodePoint(parseInt(m[0], 16)); i += 2 + m[0].length; } else { out += `\\${n}`; i += 2; }
        } else if (/[0-7]/.test(n || "")) {
            const m = /^[0-7]{1,3}/.exec(src.slice(i + 1));
            out += String.fromCharCode(parseInt(m[0], 8));
            i += 1 + m[0].length;
        } else if (n === undefined) {
            i++;
        } else {
            out += `\\${n}`;
            i += 2;
        }
    }
    throw new Error("The cURL command has an unclosed $'...' quote");
}

/** POSIX shell words: '...', "...", $'...', backslash escapes, \ and ` line continuations. Stops at | ; > && ||. */
function tokenizePosix(src) {
    const tokens = [];
    let cur = null;
    let i = 0;
    const add = (s) => { cur = (cur === null ? "" : cur) + s; };
    while (i < src.length) {
        const c = src[i];
        const n = src[i + 1];
        if (c === "\\") {
            if (n === "\n") { i += 2; continue; } // line continuation
            if (n === undefined) { i++; continue; }
            add(n);
            i += 2;
            continue;
        }
        if (c === "`" && n === "\n") { i += 2; continue; } // PowerShell line continuation
        if (/\s/.test(c)) {
            if (cur !== null) { tokens.push(cur); cur = null; }
            i++;
            continue;
        }
        if (cur === null && (c === "|" || c === ";" || c === ">" || (c === "&" && n === "&"))) break; // end of the curl command
        if (cur === null && c === "#") { // comment line
            const nl = src.indexOf("\n", i);
            i = nl < 0 ? src.length : nl;
            continue;
        }
        if (c === "'") {
            const end = src.indexOf("'", i + 1);
            if (end < 0) throw new Error("The cURL command has an unclosed ' quote");
            add(src.slice(i + 1, end));
            i = end + 1;
            continue;
        }
        if (c === "$" && n === "'") {
            const r = readAnsiC(src, i + 2);
            add(r.value);
            i = r.end;
            continue;
        }
        if (c === "\"") {
            let s = "";
            i++;
            while (i < src.length && src[i] !== "\"") {
                if (src[i] === "\\" && i + 1 < src.length && "$`\"\\\n".includes(src[i + 1])) {
                    if (src[i + 1] !== "\n") s += src[i + 1];
                    i += 2;
                } else {
                    s += src[i];
                    i++;
                }
            }
            if (i >= src.length) throw new Error("The cURL command has an unclosed \" quote");
            add(s);
            i++;
            continue;
        }
        add(c);
        i++;
    }
    if (cur !== null) tokens.push(cur);
    return tokens;
}

/**
 * Windows cmd: first the cmd.exe layer (^ escapes the next character outside quotes, ^ + newline continues the
 * line, ^ + two newlines is a newline inside an argument), then the C runtime argument rules ("..." groups,
 * \" is a quote, "" inside quotes is a quote, other backslashes are literal).
 */
function tokenizeWindows(src) {
    let s = "";
    let cmdQuote = false;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (c === "^" && !cmdQuote) {
            const n = src[i + 1];
            if (n === "\n") {
                if (src[i + 2] === "\n") { s += "\n"; i += 2; } else { s += " "; i += 1; }
                continue;
            }
            if (n !== undefined) { s += n; i++; }
            continue;
        }
        if (c === "\"") cmdQuote = !cmdQuote;
        s += c;
    }
    const tokens = [];
    let cur = null;
    let quoted = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === "\\") {
            let n = 0;
            while (s[i + n] === "\\") n++;
            if (s[i + n] === "\"") {
                cur = (cur === null ? "" : cur) + "\\".repeat(Math.floor(n / 2));
                if (n % 2) { cur += "\""; i += n; } else i += n - 1; // even: the quote is handled next
                continue;
            }
            cur = (cur === null ? "" : cur) + "\\".repeat(n);
            i += n - 1;
            continue;
        }
        if (c === "\"") {
            if (cur === null) cur = "";
            if (quoted && s[i + 1] === "\"") { cur += "\""; i++; continue; }
            quoted = !quoted;
            continue;
        }
        if (!quoted && /\s/.test(c)) {
            if (cur !== null) { tokens.push(cur); cur = null; }
            continue;
        }
        if (!quoted && cur === null && (c === "|" || c === ">" || (c === "&" && s[i + 1] === "&"))) break;
        cur = (cur === null ? "" : cur) + c;
    }
    if (cur !== null) tokens.push(cur);
    return tokens;
}

function tokenize(text) {
    const src = String(text || "").replace(/\r\n?/g, "\n").trim();
    return isWindowsCmd(src) ? tokenizeWindows(src) : tokenizePosix(src);
}

// ------------------------------------------------------------------ options

// short option -> long name (options that take a value)
const SHORT_WITH_VALUE = {
    X: "request", H: "header", d: "data", F: "form", u: "user", A: "user-agent", e: "referer", b: "cookie",
    c: "cookie-jar", o: "output", m: "max-time", x: "proxy", w: "write-out", T: "upload-file", E: "cert",
    K: "config", D: "dump-header", r: "range", Y: "speed-limit", y: "speed-time", z: "time-cond",
    C: "continue-at", U: "proxy-user", P: "ftp-port", Q: "quote", t: "telnet-option"
};
const SHORT_FLAGS = {
    k: "insecure", L: "location", G: "get", I: "head", s: "silent", S: "show-error", v: "verbose", i: "include",
    f: "fail", g: "globoff", N: "no-buffer", O: "remote-name", J: "remote-header-name", j: "junk-session-cookies",
    l: "list-only", n: "netrc", q: "disable", R: "remote-time", Z: "parallel", "#": "progress-bar", 0: "http1.0",
    1: "tlsv1", 2: "sslv2", 3: "sslv3", 4: "ipv4", 6: "ipv6", a: "append", B: "use-ascii", p: "proxytunnel", V: "version"
};
const LONG_WITH_VALUE = new Set([
    "request", "header", "data", "data-raw", "data-binary", "data-ascii", "data-urlencode", "json", "form", "form-string",
    "user", "url", "url-query", "user-agent", "referer", "cookie", "cookie-jar", "output", "max-time", "connect-timeout",
    "proxy", "proxy-user", "upload-file", "oauth2-bearer", "write-out", "cacert", "capath", "cert", "cert-type", "key",
    "key-type", "pass", "resolve", "connect-to", "retry", "retry-delay", "retry-max-time", "max-redirs", "limit-rate",
    "interface", "dns-servers", "local-port", "range", "config", "trace", "trace-ascii", "stderr", "dump-header",
    "keepalive-time", "expect100-timeout", "happy-eyeballs-timeout-ms", "ciphers", "tls-max", "unix-socket",
    "abstract-unix-socket", "aws-sigv4", "request-target", "noproxy", "preproxy", "socks4", "socks4a", "socks5",
    "socks5-hostname", "proxy-header", "variable", "speed-limit", "speed-time", "time-cond", "continue-at", "ftp-port",
    "quote", "telnet-option", "max-filesize", "output-dir", "create-file-mode", "pinnedpubkey", "crlfile", "hostpubmd5",
    "hostpubsha256", "login-options", "mail-from", "mail-rcpt", "proto", "proto-redir", "sasl-authzid", "service-name",
    "tlsuser", "tlspassword", "proxy-cacert", "proxy-cert", "proxy-key", "proxy-pass", "etag-save", "etag-compare"
]);
const KNOWN_FLAGS = new Set([
    ...Object.values(SHORT_FLAGS), "compressed", "location-trusted", "http1.1", "http2", "http2-prior-knowledge", "http3",
    "tlsv1.0", "tlsv1.1", "tlsv1.2", "tlsv1.3", "ssl", "ssl-reqd", "no-keepalive", "no-sessionid", "basic", "digest",
    "ntlm", "negotiate", "anyauth", "path-as-is", "raw", "tr-encoding", "no-progress-meter", "fail-with-body",
    "fail-early", "styled-output", "no-styled-output", "tcp-nodelay", "tcp-fastopen", "post301", "post302", "post303",
    "create-dirs", "ignore-content-length", "no-alpn", "no-npn", "suppress-connect-headers", "retry-connrefused",
    "retry-all-errors", "xattr", "ssl-no-revoke", "ssl-allow-beast", "cert-status", "false-start", "disallow-username-in-url",
    "no-clobber", "remove-on-error", "doh-insecure", "proxy-insecure", "compressed-ssh", "manual", "help"
]);

function splitHeader(text) {
    const s = String(text);
    const colon = s.indexOf(":");
    if (colon < 0) {
        // curl: "Name;" sends an empty header
        return s.trim().endsWith(";") ? { name: s.trim().slice(0, -1).trim(), value: "" } : null;
    }
    return { name: s.slice(0, colon).trim(), value: s.slice(colon + 1).trim() };
}

/** curl --data-urlencode encodes everything except A-Z a-z 0-9 - . _ ~ (space as %20). */
function curlEncode(s) {
    return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function dataUrlencode(value, warnings) {
    const eq = value.indexOf("=");
    const at = value.indexOf("@");
    if (eq === 0) return curlEncode(value.slice(1));
    if (eq > 0 && (at < 0 || eq < at)) return `${value.slice(0, eq)}=${curlEncode(value.slice(eq + 1))}`;
    if (at >= 0) {
        warnings.push(`--data-urlencode "${value}" reads a file, which is not imported; fill in the value yourself.`);
        return at > 0 ? `${value.slice(0, at)}=` : "";
    }
    return curlEncode(value);
}

/** "a=1&b=two%20words" -> [["a","1"],["b","two words"]], or null when it is not a clean key=value list. */
function parseFormPairs(text) {
    if (!text) return null;
    const out = [];
    for (const part of text.split("&")) {
        if (!part) continue;
        const eq = part.indexOf("=");
        if (eq <= 0) return null;
        try {
            out.push([decodeURIComponent(part.slice(0, eq).replace(/\+/g, " ")), decodeURIComponent(part.slice(eq + 1).replace(/\+/g, " "))]);
        } catch {
            return null; // malformed % escape: keep the body as text
        }
    }
    return out.length ? out : null;
}

function unquote(s) {
    const t = s.trim();
    return t.length >= 2 && t.startsWith("\"") && t.endsWith("\"") ? t.slice(1, -1).replace(/\\(["\\])/g, "$1") : t;
}

/** -F "name=value", "name=@file;type=image/png;filename=x.png", "name=<file" */
function parseFormArg(arg, literal, warnings) {
    const eq = arg.indexOf("=");
    if (eq <= 0) {
        warnings.push(`Ignored form field "${arg}" (expected name=value).`);
        return null;
    }
    const key = arg.slice(0, eq);
    const rest = arg.slice(eq + 1);
    if (!literal && (rest.startsWith("@") || rest.startsWith("<"))) {
        const segments = [];
        let buf = "";
        let inQ = false;
        for (const ch of rest.slice(1)) {
            if (ch === "\"") inQ = !inQ;
            if (ch === ";" && !inQ) { segments.push(buf); buf = ""; } else buf += ch;
        }
        segments.push(buf);
        const filePath = unquote(segments.shift() || "");
        let contentType = "";
        for (const seg of segments) {
            const m = /^\s*type=(.+)$/i.exec(seg);
            if (m) contentType = unquote(m[1]);
        }
        if (rest.startsWith("<")) warnings.push(`Form field "${key}" sends the contents of ${filePath} as text; it was imported as a file part.`);
        return { key, type: "file", value: "", filePath, contentType, enabled: true };
    }
    let value = rest;
    let contentType = "";
    if (!literal) {
        const m = /^(.*?);type=([^;]+)$/i.exec(rest);
        if (m) {
            value = m[1];
            contentType = m[2].trim();
        }
        value = unquote(value);
    }
    return { key, type: "text", value, filePath: "", contentType, enabled: true };
}

function requestName(method, url) {
    let label = url;
    try {
        const u = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(url) ? url : `http://${url}`);
        label = u.pathname && u.pathname !== "/" ? decodeURIComponent(u.pathname) : u.host;
    } catch {
        label = url.replace(/^[a-z]+:\/\//i, "").split(/[?#]/)[0];
    }
    const name = `${method} ${label}`;
    return name.length > 80 ? `${name.slice(0, 77)}...` : name;
}

/** Same as parseCurl, plus warnings about options that could not be imported. -> { request, warnings } */
function parseCurlDetailed(text) {
    const tokens = tokenize(text);
    const start = tokens.findIndex((t) => /^curl(\.exe)?$/i.test(t.split(/[\\/]/).pop()));
    if (start < 0) throw new Error("This is not a cURL command (it should start with curl)");
    const args = tokens.slice(start + 1);
    const warnings = [];
    const st = {
        method: null, urls: [], headers: [], data: [], forms: [], user: null, bearer: null, get: false, head: false,
        insecure: false, location: false, timeoutMs: null, upload: null, urlQueries: [], json: false, authWarned: false
    };

    const applyValue = (name, v) => {
        switch (name) {
            case "request": st.method = v.trim().toUpperCase(); break;
            case "header": {
                if (v.startsWith("@")) { warnings.push(`Headers from file ${v.slice(1)} were not imported.`); break; }
                const h = splitHeader(v);
                if (h && h.name) st.headers.push(h);
                break;
            }
            case "data": case "data-ascii": st.data.push({ kind: "data", value: v }); break;
            case "data-raw": st.data.push({ kind: "raw", value: v }); break;
            case "data-binary": st.data.push({ kind: "binary", value: v }); break;
            case "data-urlencode": st.data.push({ kind: "urlencode", value: v }); break;
            case "json": st.data.push({ kind: "json", value: v }); st.json = true; break;
            case "form": st.forms.push(parseFormArg(v, false, warnings)); break;
            case "form-string": st.forms.push(parseFormArg(v, true, warnings)); break;
            case "user": st.user = v; break;
            case "url": st.urls.push(v); break;
            case "url-query": st.urlQueries.push(v); break;
            case "user-agent": st.headers.push({ name: "User-Agent", value: v }); break;
            case "referer": st.headers.push({ name: "Referer", value: v.replace(/;auto$/, "") }); break;
            case "cookie":
                if (v.includes("=")) st.headers.push({ name: "Cookie", value: v });
                else warnings.push(`Cookie file "${v}" was not imported.`);
                break;
            case "max-time": {
                const s = Number(v);
                if (Number.isFinite(s) && s > 0) st.timeoutMs = Math.round(s * 1000);
                break;
            }
            case "upload-file": st.upload = v; break;
            case "oauth2-bearer": st.bearer = v; break;
            case "proxy": warnings.push("The proxy option was ignored; set a proxy in Settings > Proxy."); break;
            case "cert": case "key": case "cacert": warnings.push(`--${name} (client certificates) is not supported and was ignored.`); break;
            default: break; // output, write-out, retry ...: not relevant for a request definition
        }
    };
    const applyFlag = (name) => {
        switch (name) {
            case "insecure": st.insecure = true; break;
            case "location": case "location-trusted": st.location = true; break;
            case "get": st.get = true; break;
            case "head": st.head = true; break;
            case "digest": case "ntlm": case "negotiate":
                warnings.push(`--${name} authentication is not supported; Basic auth is used instead.`);
                break;
            default:
                if (!KNOWN_FLAGS.has(name)) warnings.push(`Ignored unknown option --${name}.`);
        }
    };

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--") {
            st.urls.push(...args.slice(i + 1));
            break;
        }
        if (a.startsWith("--") && a.length > 2) {
            let name = a.slice(2);
            let inline = null;
            const eq = name.indexOf("=");
            if (eq > 0 && LONG_WITH_VALUE.has(name.slice(0, eq))) { // not curl syntax, but some generators write it
                inline = name.slice(eq + 1);
                name = name.slice(0, eq);
            }
            if (LONG_WITH_VALUE.has(name)) {
                const v = inline !== null ? inline : args[++i];
                if (v === undefined) throw new Error(`The cURL option --${name} needs a value`);
                applyValue(name, v);
            } else {
                applyFlag(name);
            }
            continue;
        }
        if (a.startsWith("-") && a.length > 1) {
            // short options can be combined (-sSL) and take their value attached (-XPOST) or as the next word
            for (let j = 1; j < a.length; j++) {
                const ch = a[j];
                if (SHORT_WITH_VALUE[ch]) {
                    const v = j + 1 < a.length ? a.slice(j + 1) : args[++i];
                    if (v === undefined) throw new Error(`The cURL option -${ch} needs a value`);
                    applyValue(SHORT_WITH_VALUE[ch], v);
                    break;
                }
                if (SHORT_FLAGS[ch]) applyFlag(SHORT_FLAGS[ch]);
                else warnings.push(`Ignored unknown option -${ch}.`);
            }
            continue;
        }
        st.urls.push(a);
    }

    if (!st.urls.length) throw new Error("No URL found in the cURL command");
    if (st.urls.length > 1) warnings.push(`Only the first URL was imported (${st.urls.length} URLs in the command).`);
    let url = st.urls[0].trim();

    // ---- body
    const files = [];
    const pieces = [];
    for (const d of st.data) {
        if (d.kind === "urlencode") { pieces.push(dataUrlencode(d.value, warnings)); continue; }
        if (d.kind !== "raw" && d.value.startsWith("@")) { files.push(d); continue; }
        pieces.push(d.value);
    }
    const dataText = pieces.join("&");
    const params = [];
    const headers = st.headers.slice();
    const findHeader = (name) => headers.find((h) => h.name.toLowerCase() === name);
    let body = defaultBody("none");

    if (st.json) {
        if (!findHeader("content-type")) headers.push({ name: "Content-Type", value: "application/json" });
        if (!findHeader("accept")) headers.push({ name: "Accept", value: "application/json" });
    }
    for (const q of st.urlQueries) {
        const pairs = parseFormPairs(q.startsWith("+") ? q.slice(1) : q.includes("=") ? q.replace(/=(.*)$/, (m, v) => `=${curlEncode(v)}`) : curlEncode(q));
        if (pairs) params.push(...pairs);
    }

    if (st.get && (pieces.length || files.length)) {
        // -G: the data goes into the query string
        const pairs = parseFormPairs(dataText);
        if (pairs) params.push(...pairs);
        else if (dataText) url += (url.includes("?") ? "&" : "?") + dataText;
        if (files.length) warnings.push("Data read from a file with -G was not imported.");
    } else if (st.forms.filter(Boolean).length) {
        body = { ...defaultBody("multipart"), multipart: st.forms.filter(Boolean) };
        if (st.data.length) warnings.push("The command has both -F and -d; only the -F form fields were imported.");
        // the boundary of a copied Content-Type would not match the new body
        const ct = findHeader("content-type");
        if (ct && /multipart\/form-data/i.test(ct.value)) headers.splice(headers.indexOf(ct), 1);
    } else if (files.length && !pieces.length) {
        body = { ...defaultBody("binary"), binaryPath: files[0].value.slice(1) };
        if (files[0].kind === "data") warnings.push(`curl -d @${body.binaryPath} removes line breaks from the file; the file is sent unchanged here.`);
        if (files.length > 1) warnings.push("Only the first data file was imported.");
    } else if (st.upload) {
        body = { ...defaultBody("binary"), binaryPath: st.upload };
    } else if (pieces.length) {
        if (files.length) warnings.push("Data read from files (@file) was not imported; only the inline data was.");
        const ctHeader = findHeader("content-type");
        const ct = ctHeader ? ctHeader.value.toLowerCase() : "";
        const trimmed = dataText.trim();
        let isJson = false;
        if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && !/x-www-form-urlencoded|xml/.test(ct)) {
            try { JSON.parse(trimmed); isJson = true; } catch { isJson = false; }
        }
        if (/json/.test(ct) || (!ct && isJson)) {
            body = { ...defaultBody("json"), raw: dataText };
        } else if (/xml/.test(ct)) {
            body = { ...defaultBody("xml"), raw: dataText };
        } else if (/x-www-form-urlencoded/.test(ct) || !ct) {
            const pairs = parseFormPairs(dataText);
            if (pairs) {
                body = { ...defaultBody("form"), form: pairs.map(([k, v]) => newKeyValue(k, v)) };
            } else {
                body = { ...defaultBody("text"), raw: dataText };
                // keep what curl would send
                if (!ct) headers.push({ name: "Content-Type", value: "application/x-www-form-urlencoded" });
            }
        } else {
            body = { ...defaultBody("text"), raw: dataText };
        }
    }

    // ---- method
    let method = st.method;
    if (!method) {
        if (st.head) method = "HEAD";
        else if (st.get) method = "GET";
        else if (body.mode === "multipart" || st.data.length) method = "POST";
        else if (st.upload) method = "PUT";
        else method = "GET";
    }

    // ---- auth (Authorization headers become the matching auth type, so they show in the Auth tab)
    // "https://user:pw@host/": curl sends these as Basic auth unless -u or an Authorization header replaces them
    const urlCredentials = splitUrlCredentials(url);
    if (urlCredentials) url = urlCredentials.url;
    let auth = defaultAuth("inherit");
    if (st.user !== null) {
        const colon = st.user.indexOf(":");
        auth = defaultAuth("basic");
        auth.basic = { username: colon < 0 ? st.user : st.user.slice(0, colon), password: colon < 0 ? "" : st.user.slice(colon + 1) };
    } else if (st.bearer !== null) {
        auth = defaultAuth("bearer");
        auth.bearer = { token: st.bearer };
    } else {
        const h = findHeader("authorization");
        const m = h && /^(Basic|Bearer)\s+(\S+)\s*$/i.exec(h.value);
        if (m && m[1].toLowerCase() === "bearer") {
            auth = defaultAuth("bearer");
            auth.bearer = { token: m[2] };
            headers.splice(headers.indexOf(h), 1);
        } else if (m) {
            const decoded = Buffer.from(m[2], "base64").toString("utf8");
            if (decoded.includes(":") && !/[\x00-\x1f\ufffd]/.test(decoded)) { // eslint-disable-line no-control-regex
                auth = defaultAuth("basic");
                auth.basic = { username: decoded.slice(0, decoded.indexOf(":")), password: decoded.slice(decoded.indexOf(":") + 1) };
                headers.splice(headers.indexOf(h), 1);
            }
        }
        if (!h && urlCredentials && (urlCredentials.username || urlCredentials.password)) {
            auth = defaultAuth("basic");
            auth.basic = { username: urlCredentials.username, password: urlCredentials.password };
        }
    }

    const request = newRequest(requestName(method, url), {
        method,
        url,
        params: params.map(([k, v]) => newKeyValue(k, v)),
        headers: headers.map((h) => newKeyValue(h.name, h.value)),
        auth,
        body,
        settings: {
            timeoutMs: st.timeoutMs,
            followRedirects: st.location ? true : null,
            verifyTls: st.insecure ? false : null
        }
    });
    return { request, warnings };
}

/** Pasted cURL command -> model request (see model.newRequest). Throws a readable Error when it cannot be parsed. */
function parseCurl(text) {
    return parseCurlDetailed(text).request;
}

// ------------------------------------------------------------------ PreparedRequest -> curl

function shellQuote(s) {
    return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/** Headers worth repeating in generated code (Content-Length / Host are computed by every client). */
function snippetHeaders(prepared) {
    const multipart = prepared.bodyMode === "multipart" && Array.isArray(prepared.multipart) && prepared.multipart.length;
    return (prepared.headers || []).filter(([k, v]) => {
        const n = String(k).toLowerCase();
        if (n === "content-length" || n === "host") return false;
        // the client builds the multipart body and its boundary itself
        return !(multipart && n === "content-type" && /^multipart\/form-data/i.test(String(v)));
    });
}

/** What kind of body generated code should send: "multipart" | "binary" | "text" | "none". */
function snippetBodyKind(prepared) {
    if (prepared.bodyMode === "multipart" && Array.isArray(prepared.multipart) && prepared.multipart.length) return "multipart";
    if (prepared.bodyMode === "binary" && prepared.binaryPath) return "binary";
    if (prepared.bodyText && !(prepared.bodyMode === "multipart" || prepared.bodyMode === "binary")) return "text";
    return "none";
}

/**
 * PreparedRequest -> multi-line bash cURL command. Uses prepared.multipart / binaryPath (from prepare.js) for
 * file uploads; otherwise bodyText.
 */
function toCurl(prepared, { multiline = true } = {}) {
    const p = prepared || {};
    const method = String(p.method || "GET").toUpperCase();
    const url = String(p.url || "");
    const kind = snippetBodyKind(p);
    const hasBody = kind !== "none";
    const first = ["curl"];
    if (method === "HEAD") first.push("--head");
    else if (!(method === "GET" && !hasBody) && !(method === "POST" && hasBody)) first.push("-X", method);
    if (p.settings && p.settings.followRedirects) first.push("-L");
    if (p.settings && p.settings.verifyTls === false) first.push("-k");
    if (/[[\]{}]/.test(url)) first.push("-g"); // stop curl from treating [] {} in the URL as globbing patterns
    first.push(shellQuote(url));

    const lines = [first.join(" ")];
    for (const [k, v] of snippetHeaders(p)) lines.push(`-H ${shellQuote(`${k}: ${v}`)}`);
    if (kind === "multipart") {
        for (const part of p.multipart) {
            const type = part.contentType ? `;type=${part.contentType}` : "";
            if (part.type === "file") lines.push(`-F ${shellQuote(`${part.key}=@${part.filePath || part.fileName || "file"}${type}`)}`);
            else if (/^[@<]/.test(part.value) || (part.value.includes(";") && !type)) lines.push(`--form-string ${shellQuote(`${part.key}=${part.value}`)}`);
            else lines.push(`-F ${shellQuote(`${part.key}=${part.value}${type}`)}`);
        }
    } else if (kind === "binary") {
        lines.push(`--data-binary ${shellQuote(`@${p.binaryPath}`)}`);
    } else if (kind === "text") {
        lines.push(`--data-raw ${shellQuote(p.bodyText)}`);
    }
    return lines.join(multiline ? " \\\n  " : " ");
}

module.exports = { parseCurl, parseCurlDetailed, toCurl, tokenize, shellQuote, snippetHeaders, snippetBodyKind };
