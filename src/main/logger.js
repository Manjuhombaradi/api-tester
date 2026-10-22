"use strict";
// Small file logger for the desktop app: <dir>/api-tester.log, rotated to api-tester.old.log at 5 MB
// (one previous file is kept). Logging must never break the app, so every failure is swallowed.
const fs = require("fs");
const path = require("path");

const LOG_MAX_BYTES = 5 * 1024 * 1024;

function createLogger(dir, { fileName = "api-tester.log", maxBytes = LOG_MAX_BYTES, mirror = null } = {}) {
    const file = path.join(dir, fileName);
    const oldFile = path.join(dir, fileName.replace(/\.log$/, "") + ".old.log");
    let stream = null;
    let bytes = 0; // size of the log file including what this run wrote

    function open(rotate) {
        fs.mkdirSync(dir, { recursive: true });
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
        stream = fs.createWriteStream(file, { fd: fs.openSync(file, flags) });
        stream.on("error", () => { /* logging must never break the app */ });
    }

    function write(level, message) {
        const text = message instanceof Error ? (message.stack || message.message) : String(message);
        try {
            if (!stream) open(false);
            const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${text}\n`;
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

module.exports = { createLogger };
