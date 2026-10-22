"use strict";
// Small file logger for the desktop app: <dir>/api-tester.log, rotated to api-tester.old.log at 5 MB
// (one previous file is kept). Logging must never break the app, so every failure is swallowed.
// The folder is 0700 and the files 0600 (POSIX): only the current user can read them. Every entry starts with
// a timestamp at the start of a line; text from outside (URLs, server messages, file names) cannot start a
// line of its own, so it cannot fake an entry.
const fs = require("fs");
const path = require("path");

const LOG_MAX_BYTES = 5 * 1024 * 1024;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const MAX_MESSAGE_CHARS = 64 * 1024;

/** One log entry: control characters removed, follow-up lines (stack traces) indented. */
function cleanMessage(text) {
    let s = String(text);
    if (s.length > MAX_MESSAGE_CHARS) s = `${s.slice(0, MAX_MESSAGE_CHARS)}… (cut)`;
    return s
        .replace(/\r\n?/g, "\n")
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, "?")
        .replace(/\n/g, "\n    ");
}

function createLogger(dir, { fileName = "api-tester.log", maxBytes = LOG_MAX_BYTES, mirror = null } = {}) {
    const file = path.join(dir, fileName);
    const oldFile = path.join(dir, fileName.replace(/\.log$/, "") + ".old.log");
    let stream = null;
    let bytes = 0; // size of the log file including what this run wrote

    function open(rotate) {
        fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
        if (process.platform !== "win32") {
            try { fs.chmodSync(dir, DIR_MODE); } catch (_) { /* not ours */ }
            try { fs.chmodSync(oldFile, FILE_MODE); } catch (_) { /* none yet */ }
        }
        let size = 0;
        try { size = fs.statSync(file).size; } catch (_) { /* new file */ }
        let flags = "a";
        if (rotate || size > maxBytes) {
            try {
                fs.renameSync(file, oldFile);
            } catch (_) {
                flags = "w"; // cannot rotate: start over rather than letting the file grow without limit
            }
            size = 0;
        }
        bytes = size;
        // opened synchronously, so a rotation right after renames the file this stream writes to
        const fd = fs.openSync(file, flags, FILE_MODE);
        try { fs.fchmodSync(fd, FILE_MODE); } catch (_) { /* a log file of an older version was 0644 */ }
        stream = fs.createWriteStream(file, { fd });
        stream.on("error", () => { /* logging must never break the app */ });
    }

    function write(level, message) {
        const text = message instanceof Error ? (message.stack || message.message) : String(message);
        try {
            if (!stream) open(false);
            const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${cleanMessage(text)}\n`;
            stream.write(line);
            bytes += Buffer.byteLength(line);
            if (bytes > maxBytes) {
                stream.end(); // pending writes of the old stream still land in the renamed file
                open(true);
            }
        } catch (_) { /* logging must never break the app */ }
        if (mirror) {
            try { mirror(level, text); } catch (_) { /* ignore */ }
        }
    }

    return {
        file,
        dir,
        info: (message) => write("info", message),
        warn: (message) => write("warn", message),
        error: (message) => write("error", message),
        close() {
            if (stream) {
                try { stream.end(); } catch (_) { /* ignore */ }
                stream = null;
            }
        }
    };
}

module.exports = { createLogger, cleanMessage };
