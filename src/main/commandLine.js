"use strict";
// Command line version of API Tester (spec §3.2), for CI pipelines, Docker and quick checks:
//   api-tester run <suite.apisuite> [options]      runs a suite, prints progress and a summary, writes reports
//   api-tester echo-server [--port 3999]           runs the local echo server
// Pure Node.js (no Electron imports). Used by src/cli.js (Node.js, or Electron's Node via ELECTRON_RUN_AS_NODE)
// and by the desktop app's command line mode (src/main/main.js).
// Exit codes: 0 everything passed, 1 failures / errors, 2 usage error (bad option, file not found, invalid file).
const fs = require("fs");
const os = require("os");
const path = require("path");
const model = require("../core/model");
const { normalizeSettings } = require("./workspace");

const VERSION = (() => {
    try {
        return require("../../package.json").version;
    } catch (_) {
        return "1.0.0";
    }
})();

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const REPORTERS = ["cli", "junit", "html", "json"];
const DEFAULT_OUT_DIR = "api-tester-reports";
const DEFAULT_ECHO_PORT = 3999;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const VAR_ENV_PREFIX = "API_TESTER_VAR_";

const HELP = `API Tester ${VERSION} - command line

Usage:
  api-tester run <suite> [options]       Run the requests of a suite and check their assertions
  api-tester echo-server [options]       Start the local echo server (for the sample suite and first tries)
  api-tester --help | --version

<suite> is a suite exported from the app (.apisuite). Postman collections, OpenAPI / Swagger files
and cURL commands in a text file work too.

Options for run:
  -e, --env <name|id>        Environment to use (default: the suite's active environment)
  -n, --iterations <n>       Run the selection n times (default 1)
  -d, --data <file>          CSV or JSON data file: one iteration per row, columns become variables
  -f, --folder <name|id>     Only run this folder or request; repeat for more (also "Folder/Sub")
      --delay <ms>           Pause between requests
      --bail                 Stop at the first failed request
      --timeout <ms>         Timeout for requests that do not set their own (default 30000, 0 = none)
  -k, --insecure             Do not verify TLS certificates, for every request (self-signed test servers)
      --strict-tls           Always verify TLS certificates, also for requests whose Settings turn it off
                             (also API_TESTER_STRICT_TLS=1)
      --var <key=value>      Set a variable (overrides environment, suite and global values); repeatable.
                             Visible to other users in the process list: use --var-env for secrets
      --public-var <key=value>
                             Like --var, but the value is never masked in the output and the reports (for
                             values that are not secret, such as a base URL with a path); repeatable
      --var-env <key=NAME>   Set the variable key to the value of the environment variable NAME; repeatable
      --globals <file>       Global variables: JSON {"key": "value"}, a list of variables, or a Postman globals file
      --ca-file <pem>        Also trust the CA certificates in this PEM file (company root behind a TLS-inspecting
                             proxy); repeatable. Also API_TESTER_CA_FILE and NODE_EXTRA_CA_CERTS
      --allow-file <path>    Allow uploads of this file, or of the files in this folder; repeatable. Without it,
                             only files in the suite's folder are uploaded (multipart file fields, binary bodies).
                             Hidden files and folders (.env, .git, .ssh ...) and SSH keys are only uploaded when
                             --allow-file names them; a suite in the home folder or at the top of a disk needs
                             --allow-file for every file
  -r, --reporter <list>      Comma separated: cli, junit, html, json (default cli)
  -o, --out <dir>            Folder for junit / html / json reports (default ./${DEFAULT_OUT_DIR})
      --proxy <url>          HTTP proxy for all requests (default: HTTPS_PROXY / HTTP_PROXY when set; hosts in
                             NO_PROXY, default localhost,127.0.0.1, are reached directly)
      --no-color             Plain text output (also when NO_COLOR is set or output is not a terminal)
      --echo-server          Start the local echo server during the run (port 3999, or --echo-port <n>)

Variables from the environment: API_TESTER_VAR_<key>=value sets the variable <key> (like --var-env).
Values from API_TESTER_VAR_*, --var-env and --var are masked (•••••) in the output and the reports.
--var values that are a plain base address (https://host:port, no path), small numbers or true / false stay
readable; an address with a path (webhook, signed URL) is masked - use --public-var for one that is not secret.

Options for echo-server:
  -p, --port <n>             TCP port (default ${DEFAULT_ECHO_PORT})
      --host <address>       Address to listen on (default 127.0.0.1; 0.0.0.0 = reachable from other machines)
      --allow-host <name>    Also answer requests for this host name (default: localhost and the listen
                             address only, against DNS rebinding); repeatable (also API_TESTER_ECHO_ALLOWED_HOSTS)

Examples:
  api-tester run "My API.apisuite" --env Staging
  api-tester run suite.apisuite --env CI --var-env token=API_TOKEN --reporter cli,junit --out reports
  api-tester run suite.apisuite --data users.csv --folder "Users" --bail

Exit codes: 0 all passed, 1 failures or errors (also: a report could not be written), 2 invalid options or files.
`;

class UsageError extends Error {}

// ------------------------------------------------------------------ argument parsing

// option -> [key, kind]; kind: "value" (last wins), "list" (repeatable), "flag"
const OPTIONS = {
    "--env": ["env", "value"], "-e": ["env", "value"],
    "--iterations": ["iterations", "value"], "-n": ["iterations", "value"],
    "--data": ["data", "value"], "-d": ["data", "value"],
    "--folder": ["folders", "list"], "-f": ["folders", "list"],
    "--delay": ["delay", "value"],
    "--bail": ["bail", "flag"],
    "--timeout": ["timeout", "value"],
    "--insecure": ["insecure", "flag"], "-k": ["insecure", "flag"],
    "--strict-tls": ["strictTls", "flag"],
    "--var": ["vars", "list"],
    "--public-var": ["publicVars", "list"],
    "--var-env": ["varEnv", "list"],
    "--globals": ["globals", "value"],
    "--allow-file": ["allowFiles", "list"],
    "--ca-file": ["caFiles", "list"],
    "--reporter": ["reporters", "list"], "-r": ["reporters", "list"], "--reporters": ["reporters", "list"],
    "--out": ["out", "value"], "-o": ["out", "value"],
    "--proxy": ["proxy", "value"],
    "--no-color": ["noColor", "flag"],
    "--color": ["color", "flag"],
    "--echo-server": ["echoServer", "flag"],
    "--echo-port": ["echoPort", "value"],
    "--port": ["port", "value"], "-p": ["port", "value"],
    "--host": ["host", "value"],
    "--allow-host": ["allowHosts", "list"],
    "--help": ["help", "flag"], "-h": ["help", "flag"],
    "--version": ["version", "flag"], "-v": ["version", "flag"]
};
// accepted and ignored: launchers and Electron pass them through
const IGNORED = ["--cli", "--no-sandbox", "--disable-gpu", "--in-process-gpu"];
const RUN_ONLY = ["env", "iterations", "data", "folders", "delay", "bail", "timeout", "insecure", "strictTls", "vars", "publicVars", "varEnv", "globals", "allowFiles",
    "reporters", "out", "proxy", "echoServer", "echoPort"];
const ECHO_ONLY = ["port", "host", "allowHosts"];

/** argv -> { command, positional: [], options: {} }; throws UsageError for unknown or incomplete options. */
function parseArgs(argv) {
    const options = { folders: [], vars: [], publicVars: [], varEnv: [], allowFiles: [], allowHosts: [], caFiles: [], reporters: [] };
    const positional = [];
    let onlyPositional = false;
    for (let i = 0; i < argv.length; i++) {
        const raw = String(argv[i]);
        if (onlyPositional || raw === "-" || !raw.startsWith("-")) {
            positional.push(raw);
            continue;
        }
        if (raw === "--") {
            onlyPositional = true;
            continue;
        }
        if (IGNORED.includes(raw)) continue;
        let name = raw;
        let inline = null;
        const eq = raw.indexOf("=");
        if (raw.startsWith("--") && eq > 2) {
            name = raw.slice(0, eq);
            inline = raw.slice(eq + 1);
        }
        const spec = OPTIONS[name];
        if (!spec) throw new UsageError(`Unknown option ${name}. Run "api-tester --help" to see the options.`);
        const [key, kind] = spec;
        if (kind === "flag") {
            if (inline !== null) throw new UsageError(`${name} does not take a value`);
            options[key] = true;
            continue;
        }
        let value = inline;
        if (value === null) {
            value = argv[i + 1];
            if (value === undefined || (String(value).startsWith("--") && String(value).length > 2)) throw new UsageError(`${name} needs a value`);
            value = String(value);
            i++;
        }
        if (kind === "list") options[key].push(value);
        else options[key] = value;
    }
    return { command: positional[0] || null, positional: positional.slice(1), options };
}

function intOption(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (value === undefined || value === null) return undefined;
    const n = Number(value);
    if (!/^\s*-?\d+\s*$/.test(String(value)) || !Number.isSafeInteger(n) || n < min || n > max) {
        throw new UsageError(`${name} must be a whole number${max < Number.MAX_SAFE_INTEGER ? ` from ${min} to ${max}` : ` of at least ${min}`} (got "${value}")`);
    }
    return n;
}

// ------------------------------------------------------------------ output helpers

// One writer per stream. When the reader goes away (`api-tester run … | head -1` closes the pipe: EPIPE), the
// stream emits "error"; unhandled, that would crash the process before the reports are written. Instead, further
// output to that stream is dropped and the run finishes normally (reports, exit code).
const writers = new WeakMap();
function safeWriter(stream) {
    if (!stream || typeof stream.write !== "function") return () => {};
    if (writers.has(stream)) return writers.get(stream);
    const state = { broken: false };
    if (typeof stream.on === "function") stream.on("error", () => { state.broken = true; });
    const write = (text) => {
        if (state.broken || stream.destroyed) return;
        try {
            stream.write(text);
        } catch (_) {
            state.broken = true;
        }
    };
    writers.set(stream, write);
    return write;
}

function createOutput({ stdout, stderr, color }) {
    const paint = (code) => (text) => (color ? `\u001b[${code}m${text}\u001b[0m` : String(text));
    const writeOut = safeWriter(stdout);
    const writeErr = safeWriter(stderr);
    return {
        out: (line = "") => writeOut(`${line}\n`),
        err: (line = "") => writeErr(`${line}\n`),
        green: paint("32"),
        red: paint("31"),
        yellow: paint("33"),
        dim: paint("2"),
        bold: paint("1"),
        cyan: paint("36"),
        color
    };
}

function wantsColor(options, stream, env) {
    if (options.noColor || env.NO_COLOR) return false;
    if (options.color || (env.FORCE_COLOR && env.FORCE_COLOR !== "0")) return true;
    return !!(stream && stream.isTTY);
}

const fmtMs = (ms) => (Number.isFinite(ms) ? (ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`) : "-");

function shorten(text, max) {
    const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ------------------------------------------------------------------ file loading

function readTextFile(file, what) {
    let stat;
    try {
        stat = fs.statSync(file);
    } catch (err) {
        throw new UsageError(err.code === "ENOENT" ? `${what} not found: ${file}` : `Cannot open ${file}: ${err.message}`);
    }
    if (!stat.isFile()) throw new UsageError(`${what} is not a file: ${file}`);
    if (stat.size > MAX_FILE_BYTES) throw new UsageError(`${what} is too large: ${file}`);
    try {
        return fs.readFileSync(file, "utf8").replace(/^﻿/, "");
    } catch (err) {
        throw new UsageError(`Cannot read ${file}: ${err.message}`);
    }
}

/**
 * Suite file -> { suite, warnings }. Every format goes through the importer (as in the app), so its notes are shown:
 * blank Auth credentials, a file from a newer version, what a Postman / OpenAPI import could not convert.
 * API Tester files keep their ids (so --env / --folder ids work).
 */
function loadSuite(file, options = {}) {
    const text = readTextFile(file, "Suite file");
    const name = path.basename(file);
    let result;
    let suite;
    try {
        result = require("../core/suiteFile").importText(text, name);
        if (result && Array.isArray(result.suites) && result.suites.length) suite = model.normalizeSuite(result.suites[0]);
    } catch (err) {
        throw new UsageError(`${name}: ${err.message}`);
    }
    if (!suite) {
        throw new UsageError(`${name} contains no suite${result && result.kind === "environment" ? " (it is an environment file; use it with --globals or import it in the app)" : ""}`);
    }
    const warnings = cliWarnings(result.warnings || [], options);
    if (result.suites.length > 1) warnings.push(`${name} contains ${result.suites.length} suites; running the first one, "${suite.name}".`);
    return { suite, warnings };
}

/** Importer notes, worded for the command line. options: the run options (--strict-tls, --insecure), localFilesNote. */
function cliWarnings(warnings, options = {}) {
    const out = [];
    for (const warning of warnings) {
        const text = String(warning);
        // empty secret variables are checked by the run itself: only those it needs, with the --var to set them
        if (/^Secret values were not included/i.test(text)) continue;
        if (/^Credentials are empty in the Auth tab/i.test(text)) {
            // secret Auth fields are blanked on export; a {{variable}} in that field can be set from the command line
            out.push(`${text.replace(/[;,]?\s*fill them in\.?$/i, "")} (they were not exported). In the app, put a variable there, for example {{token}}, export again and run with --var-env token=API_TOKEN (or API_TESTER_VAR_token)`);
            continue;
        }
        // security notes of the import (suiteFile.securityNotes), with the command line options that apply
        if (/^Local files:/.test(text)) {
            out.push(text.replace(/ API Tester asks before it reads each file;.*$/, options.localFilesNote ||
                " Only files in the suite's folder (not hidden files such as .env or .git, nor SSH keys), or allowed with --allow-file <path>, are read."));
            continue;
        }
        if (/^Scripts:/.test(text)) {
            out.push(text.replace(/ Scripts cannot read files.*$/, " They can read and change variables (also secret ones) and the request."));
            continue;
        }
        if (/^TLS certificate checks are off/.test(text)) {
            if (options.insecure) continue; // --insecure turns them off for every request anyway
            out.push(text.replace(/ Turn "Verify TLS" back on.*$/, options.strictTls ? " --strict-tls verifies them anyway." : " Add --strict-tls to verify them anyway."));
            continue;
        }
        out.push(text);
    }
    return out;
}

/** Globals file -> Variable[]: {"key": "value"}, [{key, value}], Postman globals / environment ({values}), {variables}. */
function loadGlobals(file) {
    const text = readTextFile(file, "Globals file");
    let data;
    try {
        data = JSON.parse(text);
    } catch (err) {
        const { where, message } = require("../core/datafile").jsonErrorDetails(text, err);
        throw new UsageError(`Globals file ${path.basename(file)} is not valid JSON${where ? ` (line ${where.line}, column ${where.column})` : ""}: ${message}`);
    }
    let list;
    if (Array.isArray(data)) list = data;
    else if (data && Array.isArray(data.values)) list = data.values;
    else if (data && Array.isArray(data.variables)) list = data.variables;
    else if (data && typeof data === "object") list = Object.entries(data).map(([key, value]) => ({ key, value: typeof value === "string" ? value : JSON.stringify(value) }));
    else throw new UsageError(`Globals file ${path.basename(file)} must contain an object or a list of variables`);
    return list.filter((v) => v && typeof v === "object" && v.key).map((v) => model.newVariable(String(v.key), v.value == null ? "" : String(v.value), {
        enabled: v.enabled !== false,
        secret: !!v.secret || v.type === "secret"
    }));
}

function parseVarOption(text, option = "--var") {
    const eq = text.indexOf("=");
    if (eq < 1) throw new UsageError(`${option} needs key=value (got "${text}")`);
    return [text.slice(0, eq).trim(), text.slice(eq + 1)];
}

/**
 * --var values that are a plain base address (scheme, host and port only: https://api.example.com:8443/), small
 * numbers or true / false are not masked (a base URL must stay readable). An address with a path, query or user
 * name is masked: webhooks and signed URLs carry their secret there (https://hooks.example.com/services/T0/B0/xyz).
 */
function looksPublic(value) {
    const v = String(value).trim();
    return /^https?:\/\/[^\s@?#/\\]+\/?$/i.test(v) || /^(true|false|null)$/i.test(v) || /^-?\d{1,4}$/.test(v);
}

/**
 * Variables given on the command line, lowest precedence first: API_TESTER_VAR_<key> environment variables, then
 * --var-env key=NAME, then --var key=value, then --public-var key=value. -> [{ key, value, secret, from }]. Values
 * from the environment are always secret (masked in output and reports); --var values too, unless they look like a
 * base address or a number; --public-var values never.
 */
function commandLineVariables(options, env) {
    const out = [];
    for (const [name, value] of Object.entries(env || {})) {
        if (!name.startsWith(VAR_ENV_PREFIX) || name.length === VAR_ENV_PREFIX.length || value === undefined) continue;
        out.push({ key: name.slice(VAR_ENV_PREFIX.length), value: String(value), secret: true, from: name });
    }
    for (const text of options.varEnv || []) {
        const eq = text.indexOf("=");
        if (eq < 1 || eq === text.length - 1) throw new UsageError(`--var-env needs key=ENVIRONMENT_VARIABLE (got "${text}")`);
        const key = text.slice(0, eq).trim();
        const name = text.slice(eq + 1).trim();
        if (env[name] === undefined) throw new UsageError(`--var-env ${key}=${name}: the environment variable ${name} is not set`);
        out.push({ key, value: String(env[name]), secret: true, from: name });
    }
    for (const text of options.vars || []) {
        const [key, value] = parseVarOption(text);
        out.push({ key, value, secret: !looksPublic(value), from: "--var" });
    }
    for (const text of options.publicVars || []) {
        const [key, value] = parseVarOption(text, "--public-var");
        out.push({ key, value, secret: false, from: "--public-var" });
    }
    return out;
}

/** Inside folder (or the file itself)? Both real paths. */
function isInside(file, folder) {
    const rel = path.relative(folder, file);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function realPathOf(p) {
    try {
        return fs.realpathSync(p);
    } catch (_) {
        return path.resolve(p);
    }
}

// names that often hold credentials: hidden files and folders (.ssh, .aws, .git/config, .env, .npmrc ...), private
// SSH keys and the Windows profile data folder; uploaded only when --allow-file names them (or a folder inside them)
const PRIVATE_NAME = /^(?:\..*|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|appdata)$/i;

/** The first name below root that holds credentials ("" = none). file is inside root. */
function privateSegment(file, root) {
    return path.relative(root, file).split(/[\\/]+/).find((name) => name && name !== "." && PRIVATE_NAME.test(name)) || "";
}

/**
 * approveFile for the runner (see core/prepare.js): a shared suite must not upload files of this computer, so only
 * files in the suite's folder or given with --allow-file are read (checked as written, then as the real file: a
 * link pointing outside does not count). Not even there: hidden files / folders and SSH keys below such a folder,
 * unless --allow-file names them. A suite in the home folder or at the top of a disk (an ancestor of the home
 * folder) has no folder of its own: every file needs --allow-file. Nothing on disk is read for a path before
 * it is allowed as written (prepare.js asks with realPath null first).
 * -> approveFile(file, details), plus .why(filePath, realPath) (the reason a file was refused, for the message) and
 *    .suiteFolderNote (for the "Local files" note).
 */
function createFileApprover(suiteDir, allowed, { home = os.homedir() } = {}) {
    const both = (p) => [...new Set([path.resolve(p), realPathOf(p)])]; // the folder as given and as it really is
    const suiteForms = both(suiteDir);
    const homeForms = home ? both(home) : [];
    // the suite's folder counts only when it is a folder of its own, not the home folder or one above it
    const suiteTooWide = suiteForms.some((s) => homeForms.some((h) => isInside(h, s)) || path.parse(s).root === s);
    const roots = suiteTooWide ? [] : [suiteForms];
    for (const entry of allowed || []) {
        const full = path.resolve(String(entry));
        if (!fs.existsSync(full)) throw new UsageError(`--allow-file: ${full} does not exist`);
        roots.push(both(full));
    }
    /** "" when allowed, else why not: "outside" | "private:<name>" */
    const check = (p) => {
        let reason = "outside";
        for (const forms of roots) {
            for (const root of forms) {
                if (!isInside(p, root)) continue;
                const name = privateSegment(p, root);
                if (!name) return "";
                reason = `private:${name}`;
            }
        }
        return reason;
    };
    const verdict = (file, realPath) => {
        const paths = [path.resolve(String(file))];
        if (typeof realPath === "string" && realPath) paths.push(realPath);
        for (const p of paths) {
            const reason = check(p);
            if (reason) return { reason, path: p };
        }
        return null;
    };
    const approve = (file, details) => !verdict(file, details && details.realPath);
    approve.why = (filePath, realPath) => {
        const v = verdict(filePath, realPath);
        if (!v) return "";
        if (v.reason.startsWith("private:")) {
            const name = v.reason.slice("private:".length);
            const what = name.startsWith(".") ? `"${name}" is hidden (its name starts with "."), and hidden files and folders often hold credentials (.env, .git/config, .ssh)`
                : /^appdata$/i.test(name) ? `"${name}" holds the data of Windows programs, credentials too`
                    : `"${name}" is the usual name of an SSH private key`;
            return `${what}, so it is only uploaded when --allow-file names it`;
        }
        if (suiteTooWide) return `the suite file is in ${suiteForms[0]}, which is your home folder or a folder above it, so files next to it are not uploaded unless you allow them`;
        return "it is not in the suite's folder";
    };
    approve.suiteFolderNote = suiteTooWide
        ? ` The suite file is in your home folder or a folder above it (${suiteForms[0]}), so no file is read unless you allow it with --allow-file <path>.`
        : " Only files in the suite's folder (not hidden files such as .env or .git, nor SSH keys), or allowed with --allow-file <path>, are read.";
    return approve;
}

function findEnvironment(suite, query) {
    const list = suite.environments || [];
    const q = String(query);
    const hit = list.find((e) => e.id === q) || list.find((e) => e.name === q) || list.find((e) => e.name.toLowerCase() === q.toLowerCase());
    if (hit) return hit;
    const names = list.map((e) => `"${e.name}"`).join(", ");
    throw new UsageError(`Environment "${q}" not found in the suite. ${list.length ? `Available: ${names}` : "The suite has no environments."}`);
}

/** --folder values -> item ids. A value matches an id, a name or a path like "Folder/Sub/Request". */
function findItems(suite, queries) {
    const ids = [];
    const all = [];
    model.walkItems(suite.items, (item, parents) => {
        all.push({ item, path: [...parents.map((p) => p.name), item.name].join("/") });
    });
    for (const query of queries) {
        const q = String(query).trim();
        const lower = q.toLowerCase();
        let hits = all.filter((x) => x.item.id === q || x.item.name === q || x.path === q);
        if (!hits.length) hits = all.filter((x) => x.item.name.toLowerCase() === lower || x.path.toLowerCase() === lower);
        if (!hits.length) {
            const folders = all.filter((x) => x.item.type === "folder").map((x) => `"${x.path}"`).slice(0, 20);
            throw new UsageError(`No folder or request "${q}" in the suite.${folders.length ? ` Folders: ${folders.join(", ")}` : ""}`);
        }
        for (const h of hits) if (!ids.includes(h.item.id)) ids.push(h.item.id);
    }
    return ids;
}

const PROXY_VARIABLES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];

/** --proxy, else the proxy environment variables -> { url, from } (url "" = no proxy). */
function proxySetting(options, env) {
    if (options.proxy !== undefined) return { url: String(options.proxy).trim(), from: "--proxy" };
    const name = PROXY_VARIABLES.find((n) => env[n]);
    return { url: name ? String(env[name]).trim() : "", from: name || "" };
}

/** A bad proxy is a usage error before the run, not one error per request. Same rules as the HTTP client. */
function checkProxy({ url, from }) {
    if (!url) return;
    const full = /^[a-z][a-z\d+.-]*:\/\//i.test(url) ? url : `http://${url}`;
    let parsed;
    try {
        parsed = new URL(full);
    } catch (_) {
        throw new UsageError(`The proxy URL "${url}" (${from}) is not valid. Example: --proxy http://proxy.example.com:8080`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new UsageError(`The proxy URL "${url}" (${from}) is not supported: use an http:// or https:// proxy`);
    }
}

/**
 * Secret variables the run needs but that have no value (secret values are blank in shared files), checked the way
 * the requests see them: suite, folders of the selected requests, environment (with --var), data columns, globals.
 */
function findMissingSecrets({ suite, planned, environment, globals, data }) {
    const candidates = new Set();
    const collect = (list) => {
        for (const v of list || []) if (v && v.key && v.secret && v.enabled !== false && !v.value) candidates.add(v.key);
    };
    collect(suite.variables);
    collect(environment ? environment.variables : []);
    collect(globals);
    const chains = new Map(); // distinct folder chains of the selected requests
    for (const { parents } of planned) {
        chains.set(parents.map((p) => p.id).join("/"), parents);
        for (const folder of parents) collect(folder.variables);
    }
    if (!candidates.size) return [];
    const { createScope } = require("../core/variables");
    const row = data && data.length ? data[0] : null;
    const scopes = [...chains.values()].map((parents) => createScope({ globals, suite, parents, environment, data: row }));
    return [...candidates].filter((key) => scopes.some((scope) => scope.has(key) && scope.get(key) === ""));
}

/** Creates the report folder before the run, so a bad --out is reported at once, not after a long run. */
function prepareReportFolder(outDir) {
    const dir = path.resolve(outDir || DEFAULT_OUT_DIR);
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
    } catch (err) {
        throw new UsageError(reportFolderProblem(dir, err));
    }
    return dir;
}

function reportFolderProblem(dir, err) {
    const code = err && err.code;
    const other = "Choose another folder with --out.";
    if (code === "EEXIST" || code === "ENOTDIR") {
        const file = existingFileOnPath(dir);
        return `Reports cannot be written to ${dir}: ${file && file !== dir ? `${file} is a file` : "it is a file"}, not a folder. ${other}`;
    }
    if (code === "EACCES" || code === "EPERM") {
        const docker = fs.existsSync("/.dockerenv") ? ' In Docker, mount a folder you can write to: -v "$PWD:/work" --user "$(id -u):$(id -g)".' : "";
        return `No permission to write reports to ${dir}. ${other}${docker}`;
    }
    if (code === "EROFS") return `Reports cannot be written to ${dir}: the disk is read-only. ${other}`;
    if (code === "ENOSPC") return `Reports cannot be written to ${dir}: the disk is full.`;
    return `Cannot create the report folder ${dir}: ${(err && err.message) || err}`;
}

/** The first part of a path that exists, when it is a file (why a folder cannot be created there), else null. */
function existingFileOnPath(target) {
    for (let p = target; ; p = path.dirname(p)) {
        try {
            return fs.statSync(p).isDirectory() ? null : p;
        } catch (_) { /* does not exist (yet): look at the parent */ }
        if (path.dirname(p) === p) return null;
    }
}

// Error texts of the HTTP engine point to the app's Settings; on the command line, options do that job.
function cliHints(text, { ownTimeout, insecure = false }) {
    if (typeof text !== "string" || !text) return text;
    return text
        .replace(/To accept it anyway, turn off "Verify TLS" in Settings or in the request's Settings tab\./g, "To accept it anyway, use --insecure (-k).")
        .replace(/TLS certificate verification was off(?: for this request \("Verify TLS" is turned off in its Settings tab\)| \(Settings > Verify TLS\))/,
            insecure ? "TLS certificate verification was off (--insecure)" : "TLS certificate verification was off for this request (\"Verify TLS\" is turned off in its Settings tab)")
        .replace(/Settings > Enforce TLS verification/g, "--strict-tls")
        .replace(/\b(i)ncrease the timeout in Settings or in the request's Settings tab\./gi, (_m, i) => (ownTimeout
            ? `${i}ncrease the timeout in the request's Settings tab in the app (--timeout only changes requests without their own timeout).`
            : `${i}ncrease it with --timeout <ms> (0 = no limit).`))
        .replace(/\s*\(Settings > Proxy\)/g, " (check --proxy, HTTPS_PROXY / HTTP_PROXY and NO_PROXY)")
        .replace(/Check Settings > Proxy, or turn the proxy off\./g, "Check --proxy, HTTPS_PROXY / HTTP_PROXY and NO_PROXY, or run without a proxy.")
        .replace(/Check Settings > Proxy, or /g, "Check --proxy / HTTPS_PROXY, or ");
}

/**
 * Rewrites the hints in a request result in place (the terminal output and the reports use it). approver: the
 * run's createFileApprover (says why a file was refused).
 */
function applyCliHints(result, suite, options = {}, approver = null) {
    if (!result) return;
    const found = result.requestId ? model.findItem(suite, result.requestId) : null;
    const settings = found && found.item && found.item.settings;
    const ctx = { ownTimeout: !!settings && settings.timeoutMs !== null && settings.timeoutMs !== undefined && settings.timeoutMs !== "", insecure: !!options.insecure };
    if (result.errorCode === "FILE_NOT_APPROVED" && result.fileApproval) {
        // the app asks; here the user allows files with an option
        const { filePath, realPath } = result.fileApproval;
        const link = realPath && realPath !== filePath ? `, a link to ${realPath}` : "";
        const why = (approver && approver.why && approver.why(filePath, realPath)) || "it is not in the suite's folder";
        const text = `This request uploads the local file ${filePath}${link}, which is not allowed: ${why}. ` +
            `To allow it, add --allow-file "${realPath || filePath}"${why.startsWith("it is not in") ? " (or a folder that contains it)" : ""}.`;
        for (const l of Array.isArray(result.logs) ? result.logs : []) if (l && l.message === result.error) l.message = text;
        result.error = text;
    }
    result.error = cliHints(result.error, ctx);
    if (result.response && result.response.error) result.response.error.message = cliHints(result.response.error.message, ctx);
    for (const a of Array.isArray(result.assertions) ? result.assertions : []) if (a) a.message = cliHints(a.message, ctx);
    for (const l of Array.isArray(result.logs) ? result.logs : []) if (l) l.message = cliHints(l.message, ctx);
}

// ------------------------------------------------------------------ run

async function runCommand(positional, options, io, env) {
    for (const key of ECHO_ONLY) {
        const v = options[key];
        if (v === undefined || (Array.isArray(v) && !v.length)) continue;
        throw new UsageError(key === "allowHosts" ? "--allow-host is an option of echo-server" : `--${key} is an option of echo-server (use --echo-port with run)`);
    }
    if (!positional.length) throw new UsageError('Missing the suite file: api-tester run <suite.apisuite>');
    if (positional.length > 1) throw new UsageError(`Unexpected argument "${positional[1]}" (put names with spaces in quotes)`);

    const suiteFile = path.resolve(positional[0]);
    const iterations = intOption(options.iterations, "--iterations", { min: 1, max: 100000 });
    const delayMs = intOption(options.delay, "--delay", { min: 0, max: 600000 });
    const timeoutMs = intOption(options.timeout, "--timeout", { min: 0, max: 3600000 });
    const echoPort = intOption(options.echoPort, "--echo-port", { min: 1, max: 65535 });
    const reporters = [];
    for (const r of options.reporters.length ? options.reporters : ["cli"]) {
        for (const name of String(r).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
            if (!REPORTERS.includes(name)) throw new UsageError(`Unknown reporter "${name}" (use ${REPORTERS.join(", ")})`);
            if (!reporters.includes(name)) reporters.push(name);
        }
    }

    const strictTls = !!options.strictTls || /^(1|true|yes)$/i.test(String(env.API_TESTER_STRICT_TLS || ""));
    if (strictTls && options.insecure) {
        throw new UsageError(`--insecure cannot be used together with ${options.strictTls ? "--strict-tls" : "API_TESTER_STRICT_TLS (set in the environment)"}`);
    }
    // company root certificates: read here because the installed runtime ignores NODE_EXTRA_CA_CERTS itself
    const { applyExtraCaFiles, envCaFiles } = require("../core/tlsTrust");
    const caFiles = [...envCaFiles(env),
        ...(env.API_TESTER_CA_FILE ? [{ path: env.API_TESTER_CA_FILE, label: "API_TESTER_CA_FILE" }] : []),
        ...(options.caFiles || []).map((f) => ({ path: path.resolve(f), label: "--ca-file" }))];
    if (caFiles.length) {
        try {
            const ca = applyExtraCaFiles(caFiles);
            io.err(io.dim(`Trusting ${ca.count} extra CA certificate(s)`));
        } catch (err) {
            throw new UsageError(err.message);
        }
    }
    const approveFile = createFileApprover(path.dirname(suiteFile), options.allowFiles);

    const { suite, warnings } = loadSuite(suiteFile, { strictTls, insecure: !!options.insecure, localFilesNote: approveFile.suiteFolderNote });
    for (const w of warnings) io.err(io.yellow(`Note: ${w}`));

    // environment, then the command line variables on top of it (a temporary environment when the suite has none)
    let environment = options.env !== undefined ? findEnvironment(suite, options.env) : (suite.environments.find((e) => e.id === suite.activeEnvironmentId) || null);
    const commandVars = commandLineVariables(options, env);
    const overrides = commandVars.map((v) => [v.key, v.value]);
    if (commandVars.length) {
        if (!environment) {
            environment = model.newEnvironment("Command line", []);
            suite.environments.push(environment);
        }
        for (const { key, value, secret } of commandVars) {
            const existing = environment.variables.find((v) => v.key === key);
            if (existing) {
                existing.value = value;
                existing.enabled = true;
                existing.secret = !!existing.secret || secret;
            } else {
                environment.variables.push(model.newVariable(key, value, { secret }));
            }
        }
    }
    const maskedNames = [...new Set(environment ? environment.variables.filter((v) => v.secret && commandVars.some((c) => c.key === v.key)).map((v) => v.key) : [])];
    const globals = options.globals ? loadGlobals(path.resolve(options.globals)) : [];

    const itemIds = options.folders.length ? findItems(suite, options.folders) : [];
    const planned = model.collectRequests(suite, itemIds);
    if (!planned.length) throw new UsageError(itemIds.length ? "The selected folders contain no requests." : "The suite contains no requests.");

    let data = null;
    if (options.data) {
        const dataFile = path.resolve(options.data);
        const text = readTextFile(dataFile, "Data file");
        try {
            data = require("../core/datafile").parseDataFile(text, path.basename(dataFile));
        } catch (err) {
            throw new UsageError(`${path.basename(dataFile)}: ${err.message}`);
        }
        if (!data.length) throw new UsageError(`Data file ${path.basename(dataFile)} has no rows`);
    }

    // secret values are blank in shared files: say which ones still need a value
    const missingSecrets = findMissingSecrets({ suite, planned, environment, globals, data });

    const proxy = proxySetting(options, env);
    checkProxy(proxy);
    // --timeout is the default for requests without their own timeout; --insecure applies to every request
    // (like curl -k), also to those whose Settings tab turns Verify TLS on
    if (options.insecure) {
        model.walkItems(suite.items, (item) => {
            if (item.type === "request" && item.settings) item.settings.verifyTls = false;
        });
    }
    const settings = normalizeSettings({
        timeoutMs: timeoutMs === undefined ? undefined : timeoutMs,
        verifyTls: !options.insecure,
        enforceTlsVerification: strictTls,
        proxy: { enabled: !!proxy.url, url: proxy.url, noProxy: env.NO_PROXY || env.no_proxy || "localhost,127.0.0.1" }
    });

    // report files: the folder is checked now, so a bad --out does not show up only after a long run
    const fileReporters = reporters.filter((r) => r !== "cli");
    const reportDir = fileReporters.length ? prepareReportFolder(options.out) : null;
    if (!fileReporters.length && options.out !== undefined) io.err(io.yellow("Note: --out is only used with --reporter junit, html or json."));

    const runner = require("../core/runner");
    const reportersModule = require("../core/reporters");

    // optional local echo server for the duration of the run
    let echo = null;
    if (options.echoServer) {
        const port = echoPort || DEFAULT_ECHO_PORT;
        try {
            echo = await require("../core/echoServer").startEchoServer({ port, host: "127.0.0.1" });
            // another port: a variable that points to the default one (the sample's baseUrl) needs --var
            const pointsToDefault = port === DEFAULT_ECHO_PORT ? null : [...(environment ? environment.variables : []), ...suite.variables]
                .find((v) => v && v.key && v.enabled !== false && !overrides.some(([k]) => k === v.key) && new RegExp(`//(127\\.0\\.0\\.1|localhost):${DEFAULT_ECHO_PORT}\\b`).test(String(v.value || "")));
            io.out(io.dim(`Echo server running at ${echo.url}${pointsToDefault ? ` ({{${pointsToDefault.key}}} points to port ${DEFAULT_ECHO_PORT}: add --var ${pointsToDefault.key}=${echo.url})` : ""}`));
        } catch (err) {
            if (/in use/i.test(err.message)) io.err(io.yellow(`Port ${port} is in use; assuming the echo server already runs there.`));
            else throw new Error(`The echo server could not start: ${err.message}`);
        }
    }

    // Ctrl+C: first stop the run (summary and reports are still written), a second one exits at once
    const controller = new AbortController();
    let interrupts = 0;
    const onSignal = () => {
        interrupts++;
        if (interrupts === 1) {
            io.err(io.yellow("\nStopping after the current request… (press Ctrl+C again to quit at once)"));
            controller.abort();
        } else {
            process.exit(130);
        }
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    const totalIterations = Math.max(iterations || 1, data ? data.length : 0);
    io.out(io.bold(`API Tester ${VERSION} · ${suite.name}`));
    io.out(io.dim(`Environment: ${environment ? environment.name : "none"} · ${planned.length} request${planned.length === 1 ? "" : "s"}${totalIterations > 1 ? ` × ${totalIterations} iterations` : ""}${data ? ` (data: ${path.basename(options.data)}, ${data.length} rows)` : ""}`));
    if (missingSecrets.length) {
        io.err(io.yellow(`Secret variables without a value: ${missingSecrets.join(", ")}. Set them from environment variables: ` +
            `${missingSecrets.map((n) => `${VAR_ENV_PREFIX}${n}=…`).join(" ")} (or --var-env ${missingSecrets[0]}=NAME)`));
    }
    if (maskedNames.length) io.out(io.dim(`Masked in the output and reports: ${maskedNames.map((n) => `{{${n}}}`).join(", ")}`));
    if (proxy.url) {
        // requests can be routed through a proxy by the environment alone: say so (without the proxy's credentials)
        let label = proxy.url;
        try {
            const u = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(proxy.url) ? proxy.url : `http://${proxy.url}`);
            label = `${u.protocol}//${u.host}`;
        } catch (_) { /* checked by checkProxy */ }
        io.out(io.dim(`Proxy: ${label} (from ${proxy.from}; not for NO_PROXY hosts)`));
    }
    if (options.insecure) io.err(io.yellow("TLS certificates are not verified for any request (--insecure)."));
    else if (strictTls) io.out(io.dim("TLS certificates are verified for every request (--strict-tls)."));
    io.out("");

    // live progress: one line per request as it finishes (same format as the reports), then a summary
    let lastIteration = null;
    let iterationNumber = 0; // counted here, independent of how the runner numbers iterations
    let run;
    try {
        run = await runner.runSuite({
            suite,
            itemIds,
            globals,
            environmentId: environment ? environment.id : null,
            iterations: iterations || 1,
            data,
            delayMs: delayMs || 0,
            stopOnFailure: !!options.bail,
            settings,
            signal: controller.signal,
            baseDir: path.dirname(suiteFile), // relative file paths (multipart, binary bodies) next to the suite
            approveFile, // only files in the suite's folder or allowed with --allow-file are uploaded
            onEvent: (event) => {
                if (!event || event.type !== "request-done") return;
                if (event.iteration !== lastIteration) {
                    lastIteration = event.iteration;
                    iterationNumber++;
                    if (totalIterations > 1) io.out(io.cyan(`${iterationNumber > 1 ? "\n" : ""}Iteration ${iterationNumber} of ${totalIterations}`));
                }
                applyCliHints(event.result, suite, options, approveFile);
                printResult(event.result, io, reportersModule);
            }
        });
    } finally {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
        if (echo) await echo.close().catch(() => {});
    }

    io.out("");
    printSummary(run, io);

    const reports = reportDir ? writeReports(run, fileReporters, reportDir, suite, reportersModule, io) : { written: [], failed: [] };
    if (reports.written.length) io.out("");
    for (const file of reports.written) io.out(`Report: ${file}`);
    // a CI job must not pass without the report files it asked for
    if (reports.failed.length) io.err(io.red(io.bold(`Not written: ${reports.failed.join(", ")} report${reports.failed.length === 1 ? "" : "s"}`)));

    const results = Array.isArray(run.results) ? run.results : [];
    const allPassed = !run.stopped && results.length > 0 && results.every((r) => r && r.passed);
    return allPassed && !reports.failed.length ? EXIT_OK : EXIT_FAILED;
}

/** One line per request plus the reasons when it did not pass. */
function printResult(result, io, reportersModule) {
    if (!result) return;
    if (typeof reportersModule.formatResultLine === "function") {
        io.out(`  ${reportersModule.formatResultLine(result, { color: io.color })}`);
        if (!result.passed && typeof reportersModule.formatResultDetails === "function") {
            for (const line of reportersModule.formatResultDetails(result, { color: io.color, indent: "      " })) io.out(line);
        }
    } else {
        const response = result.response || {};
        const label = result.passed ? io.green("PASS") : io.red(result.error && !response.status ? "ERROR" : "FAIL");
        io.out(`  ${label} ${String(result.method || "").padEnd(6)} ${result.name}  ${io.dim(`${response.status || ""}  ${fmtMs(result.durationMs)}`)}`);
        if (result.error) io.out(`      ${io.red(shorten(result.error, 300))}`);
        for (const a of result.assertions || []) {
            if (!a.passed && !a.skipped) io.out(`      ${io.red("✗")} ${shorten(a.label, 160)}${a.message ? io.dim(` - ${shorten(a.message, 200)}`) : ""}`);
        }
    }
    const unresolved = result.prepared && Array.isArray(result.prepared.unresolved) ? result.prepared.unresolved : [];
    if (unresolved.length) io.out(`      ${io.yellow(`! Unknown variables: ${unresolved.map((n) => `{{${n}}}`).join(", ")}`)}`);
}

/** Totals after the run (the per-request lines were printed while it ran). */
function printSummary(run, io) {
    const s = run.stats || {};
    const requests = Number(s.requests) || 0;
    const passed = Number(s.passed) || 0;
    const failed = Number(s.failed) || 0;
    const errors = Number(s.errors) || 0;
    const parts = [`${passed} passed`];
    if (failed) parts.push(io.red(`${failed} failed`));
    if (errors) parts.push(io.yellow(`${errors} ${errors === 1 ? "error" : "errors"}`));
    io.out(`${io.bold("Requests:")}  ${requests} (${parts.join(", ")})`);
    const checks = Number(s.assertions) || 0;
    const checksFailed = Number(s.assertionsFailed) || 0;
    io.out(`${io.bold("Checks:")}    ${checks} (${Number(s.assertionsPassed) || 0} passed${checksFailed ? `, ${io.red(`${checksFailed} failed`)}` : ""})`);
    io.out(`${io.bold("Time:")}      ${fmtMs(run.durationMs)} total, ${fmtMs(s.avgResponseMs)} average response`);
    if (run.stopped) {
        const why = run.stopReason === "failure" ? "after the first failure (--bail)" : run.stopReason === "cancelled" ? "by the user" : "early";
        io.out(io.yellow(`Stopped ${why}${run.error ? `: ${run.error}` : ""}${run.total ? ` (${requests} of ${run.total} requests ran)` : ""}`));
    }
    if (requests === 0) io.out(io.yellow("No requests ran"));
    else if (passed < requests) io.out(io.red(io.bold(`${requests - passed} of ${requests} requests did not pass`)));
    else if (run.stopped) io.out(io.yellow(io.bold("The requests that ran passed, but the run did not finish")));
    else io.out(io.green(io.bold("All requests passed")));
}

/** Suite name -> file name without spaces or special characters (easy to use in CI globs): "My API" -> "my-api". */
function reportBaseName(name) {
    const slug = String(name || "")
        .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80);
    return slug || "suite";
}

/** Writes the junit / html / json reports into dir (created by prepareReportFolder) -> { written: paths, failed: names }. */
function writeReports(run, reporters, dir, suite, reportersModule, io) {
    const base = reportBaseName(suite.name);
    const kinds = {
        junit: { file: `${base}.junit.xml`, render: reportersModule.toJUnit },
        html: { file: `${base}.report.html`, render: reportersModule.toHtml },
        json: { file: `${base}.report.json`, render: reportersModule.toJson }
    };
    const written = [];
    const failed = [];
    for (const name of reporters) {
        const kind = kinds[name];
        if (!kind) continue;
        const file = path.join(dir, kind.file);
        try {
            fs.mkdirSync(dir, { recursive: true }); // the folder can disappear during a long run
            fs.writeFileSync(file, kind.render(run));
            written.push(file);
        } catch (err) {
            failed.push(name);
            const why = {
                EACCES: "no permission",
                EPERM: "no permission",
                EROFS: "the disk is read-only",
                ENOSPC: "the disk is full",
                EISDIR: "a folder with that name is in the way",
                ENOTDIR: "the report folder is gone or is a file"
            }[err && err.code] || (err && err.message) || String(err);
            io.err(io.red(`Could not write the ${name} report ${file}: ${why}`));
        }
    }
    return { written, failed };
}

// ------------------------------------------------------------------ echo server

async function echoCommand(positional, options, io, env) {
    for (const key of RUN_ONLY) {
        const v = options[key];
        if (v !== undefined && !(Array.isArray(v) && !v.length)) throw new UsageError("echo-server only takes --port, --host and --allow-host");
    }
    if (positional.length) throw new UsageError(`Unexpected argument "${positional[0]}"`);
    const port = intOption(options.port, "--port", { min: 0, max: 65535 });
    const host = options.host || env.API_TESTER_ECHO_HOST || "127.0.0.1";
    const allowedHosts = [...String(env.API_TESTER_ECHO_ALLOWED_HOSTS || "").split(","), ...(options.allowHosts || [])].map((h) => h.trim()).filter(Boolean);
    const { startEchoServer, isLoopbackAddress, ENDPOINTS } = require("../core/echoServer");
    let server;
    try {
        server = await startEchoServer({ port: port === undefined ? DEFAULT_ECHO_PORT : port, host, allowedHosts });
    } catch (err) {
        io.err(io.red(`ERROR: ${err.message}`));
        return EXIT_FAILED;
    }
    const where = host === "0.0.0.0" || host === "::" ? `${server.url} (all network interfaces, port ${server.port})` : server.url;
    io.out(io.bold(`API Tester echo server listening on ${where}`));
    if (!isLoopbackAddress(host)) {
        const docker = fs.existsSync("/.dockerenv");
        io.err(io.yellow(`Warning: other computers on the network can use this echo server (it listens on ${host}). It has no authentication ` +
            `and is meant for tests on this computer. ${docker
                ? `In Docker this address is needed for -p; publish the port on this computer only: -p 127.0.0.1:${server.port}:${server.port}`
                : "Use --host 127.0.0.1 unless other computers need it."}`));
    }
    if (allowedHosts.length) io.out(io.dim(`Also answers requests for: ${allowedHosts.join(", ")}`));
    io.out("");
    for (const [method, route, description] of ENDPOINTS || []) {
        io.out(`  ${String(method).padEnd(7)}${String(route).padEnd(28)}${io.dim(description)}`);
    }
    io.out("");
    io.out(io.dim("Press Ctrl+C to stop."));
    await new Promise((resolve) => {
        const stop = () => {
            process.removeListener("SIGINT", stop);
            process.removeListener("SIGTERM", stop);
            resolve();
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
    });
    io.out("Stopping…");
    await server.close();
    return EXIT_OK;
}

// ------------------------------------------------------------------ entry points

/**
 * Runs the CLI. argv: arguments after the program (no node / script path).
 * io: { stdout, stderr, env } (defaults: process streams and environment). -> Promise<exit code>
 */
async function runCli(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
    let parsed;
    const plain = createOutput({ stdout, stderr, color: false });
    try {
        parsed = parseArgs(Array.isArray(argv) ? argv : []);
    } catch (err) {
        plain.err(`ERROR: ${err.message}`);
        return EXIT_USAGE;
    }
    const { command, positional, options } = parsed;
    const io = createOutput({ stdout, stderr, color: wantsColor(options, stdout, env) });
    if (options.version || command === "version") {
        io.out(`API Tester ${VERSION}`);
        return EXIT_OK;
    }
    if (options.help || command === "help" || !command) {
        io.out(HELP.replace(/\n$/, ""));
        return EXIT_OK;
    }
    try {
        if (command === "run") return await runCommand(positional, options, io, env);
        if (command === "echo-server" || command === "echo") return await echoCommand(positional, options, io, env);
        if (/\.(apisuite|json|ya?ml|txt)$/i.test(command)) {
            throw new UsageError(`To run the suite "${command}", use: api-tester run "${command}"${positional.length ? " " + positional.join(" ") : ""}`);
        }
        throw new UsageError(`Unknown command "${command}". Use "api-tester run <suite>" or "api-tester echo-server" (see --help).`);
    } catch (err) {
        if (err instanceof UsageError) {
            io.err(io.red(`ERROR: ${err.message}`));
            return EXIT_USAGE;
        }
        io.err(io.red(`ERROR: ${(err && err.message) || err}`));
        if (env.API_TESTER_DEBUG && err && err.stack) io.err(err.stack);
        return EXIT_FAILED;
    }
}

/** For src/cli.js: runs and exits the process with the CLI's exit code once the output is flushed. */
function main(argv) {
    // output closed early (`| head`): keep running so the reports are written and the exit code is right
    const writeErr = safeWriter(process.stderr);
    safeWriter(process.stdout);
    process.on("unhandledRejection", (err) => writeErr(`Unexpected error: ${(err && err.message) || err}\n`));
    const exit = (code) => {
        process.exitCode = code;
        // flush what was written (pipes are asynchronous) before the hard exit; open sockets must not keep us alive
        flushStream(process.stdout, () => flushStream(process.stderr, () => process.exit(code)));
    };
    runCli(argv).then(exit, (err) => {
        writeErr(`ERROR: ${(err && err.message) || err}\n`);
        exit(EXIT_FAILED);
    });
}

/** Calls done once everything written to the stream so far is handed to the OS (at once when it is closed). */
function flushStream(stream, done) {
    if (!stream || stream.destroyed || stream.writableEnded) {
        done();
        return;
    }
    try {
        stream.write("", () => done());
    } catch (_) {
        done();
    }
}

module.exports = { runCli, main, parseArgs, HELP, VERSION, EXIT_OK, EXIT_FAILED, EXIT_USAGE, loadGlobals, findItems, findEnvironment, createFileApprover, commandLineVariables };
