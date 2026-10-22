"use strict";
// Data files for data-driven runs: CSV (first row = column names) or a JSON array of objects.
// Each row becomes one iteration; its columns are available as {{column}} variables.

/** 1-based { line, column } of a character offset. */
function lineAt(text, offset) {
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text.charCodeAt(i) === 10) {
            line++;
            lineStart = i + 1;
        }
    }
    return { line, column: Math.min(offset, text.length) - lineStart + 1 };
}

// ------------------------------------------------------------------ JSON

const JSON_NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?/y;

/**
 * Offset of the first JSON syntax error in a text that JSON.parse refused (V8 does not always say where:
 * "Unexpected token", "Unexpected end of JSON input"). Iterative, so deep nesting cannot overflow the stack.
 * -> offset (text.length when the text ends too early), or -1 when no error is found.
 */
function jsonErrorOffset(text) {
    const n = text.length;
    const closers = [];
    let i = 0;
    const skipSpace = () => {
        while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
    };
    const readString = () => { // i at the opening quote; -> true, or false with i at the problem
        for (i++; i < n; i++) {
            const c = text.charCodeAt(i);
            if (c === 34) {
                i++;
                return true;
            }
            if (c < 0x20) return false;
            if (c === 92) {
                const e = text[i + 1];
                if (e === "u") {
                    if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) return false;
                    i += 5;
                } else if (e !== undefined && "\"\\/bfnrt".includes(e)) i++;
                else return false;
            }
        }
        return false;
    };
    const readValue = () => { // scalars, or opens a container; -> "value" | "open" | false
        const c = text[i];
        if (c === "{" || c === "[") {
            closers.push(c === "{" ? "}" : "]");
            i++;
            return "open";
        }
        if (c === "\"") return readString() ? "value" : false;
        if (c === "-" || (c >= "0" && c <= "9")) {
            JSON_NUMBER_RE.lastIndex = i;
            const m = JSON_NUMBER_RE.exec(text);
            if (!m) {
                i++; // "-" without digits
                return false;
            }
            i += m[0].length;
            return "value";
        }
        for (const word of ["true", "false", "null"]) {
            if (c !== word[0]) continue;
            for (let k = 0; k < word.length; k++, i++) if (text[i] !== word[k]) return false;
            return "value";
        }
        return false;
    };
    skipSpace();
    let state = "value"; // what may come next: "value" | "first" (value or end, after "[") | "key" | "firstKey" | "after"
    while (true) {
        skipSpace();
        if (state === "after") {
            if (!closers.length) return i < n ? i : -1;
            const close = closers[closers.length - 1];
            if (text[i] === close) {
                closers.pop();
                i++;
            } else if (text[i] === ",") {
                i++;
                state = close === "}" ? "key" : "value";
            } else return i;
            continue;
        }
        if (i >= n) return n;
        if ((state === "first" && text[i] === "]") || (state === "firstKey" && text[i] === "}")) {
            closers.pop();
            i++;
            state = "after";
            continue;
        }
        if (state === "key" || state === "firstKey") {
            if (text[i] !== "\"" || !readString()) return i;
            skipSpace();
            if (text[i] !== ":") return i;
            i++;
            state = "value";
            continue;
        }
        const r = readValue();
        if (r === false) return i;
        state = r === "open" ? (closers[closers.length - 1] === "}" ? "firstKey" : "first") : "after";
    }
}

/**
 * Readable details for a JSON.parse error: { where: {line, column} | null, message } without V8's quoted
 * excerpt of the text (which can contain line breaks). Also used for other JSON files (CLI --globals).
 */
function jsonErrorDetails(text, err) {
    // V8: "... in JSON at position 15 (line 1 column 16)", or no position plus a quoted excerpt of the text:
    // "Unexpected token '}', ...\"b\": tru}]\" is not valid JSON"
    let msg = String(err.message || "invalid JSON");
    const pos = /at position (\d+)/.exec(msg);
    msg = msg.replace(/\s*\(line \d+ column \d+\)/, "").replace(/ in JSON at position \d+/, "")
        .replace(/^(Unexpected token .+?), (?:\.\.\.)?".*" is not valid JSON$/s, "$1");
    let offset = pos ? Number(pos[1]) : -1;
    if (offset < 0) {
        try {
            offset = jsonErrorOffset(text);
        } catch {
            offset = -1;
        }
    }
    const end = text.trimEnd().length;
    if (offset >= end) {
        // only blanks after the error: the data stops half-way; point at its last character
        msg = "The file ends too early (a closing ] or } or \" may be missing)";
        offset = Math.max(0, end - 1);
    }
    const where = offset >= 0 ? lineAt(text, offset) : null;
    return { where, message: msg };
}

function parseJsonRows(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch (err) {
        const { where, message } = jsonErrorDetails(text, err);
        throw new Error(`The JSON data file is not valid JSON${where ? ` (line ${where.line}, column ${where.column})` : ""}: ${message}`);
    }
    if (data && typeof data === "object" && !Array.isArray(data)) data = [data]; // a single object = one row
    if (!Array.isArray(data)) throw new Error("JSON data must be a list of objects, e.g. [{ \"name\": \"Ann\" }, { \"name\": \"Bob\" }]");
    return data.map((row, i) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) {
            throw new Error(`JSON data: item ${i + 1} is not an object (each item must look like { "column": "value" })`);
        }
        return row;
    });
}

// ------------------------------------------------------------------ CSV

/** Picks the separator used most in the header line (outside quotes): comma, semicolon or tab. */
function detectDelimiter(text) {
    const counts = { ",": 0, ";": 0, "\t": 0 };
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === "\"") inQuotes = !inQuotes;
        else if (!inQuotes && (c === "\n" || c === "\r")) break;
        else if (!inQuotes && c in counts) counts[c]++;
    }
    let best = ",";
    for (const d of [";", "\t"]) if (counts[d] > counts[best]) best = d;
    return best;
}

/** RFC 4180 style parser -> [{ fields: string[], line }] (quoted fields may contain separators, quotes as "", newlines). */
function parseCsvRecords(text, delimiter) {
    const records = [];
    let fields = [];
    let field = "";
    let quoted = false; // current field started with a quote
    let inQuotes = false;
    let afterQuote = false; // closing quote seen, only a separator / line end may follow
    let line = 1;
    let recordLine = 1;
    let quoteLine = 1;
    const endField = () => {
        fields.push(quoted ? field : field.trim());
        field = "";
        quoted = false;
        afterQuote = false;
    };
    const endRecord = () => {
        endField();
        records.push({ fields, line: recordLine });
        fields = [];
    };
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === "\"") {
                if (text[i + 1] === "\"") {
                    field += "\"";
                    i++;
                } else {
                    inQuotes = false;
                    afterQuote = true;
                }
            } else {
                if (c === "\n") line++;
                field += c;
            }
            continue;
        }
        if (c === delimiter) {
            endField();
        } else if (c === "\n" || c === "\r") {
            if (c === "\r" && text[i + 1] === "\n") i++;
            endRecord();
            line++;
            recordLine = line;
        } else if (afterQuote) {
            if (c === " " || c === "\t") continue; // spaces after the closing quote are harmless
            throw new Error(`Line ${line}: unexpected text after a closing quote (write a quote inside a quoted value as "")`);
        } else if (c === "\"" && field.trim() === "") {
            field = "";
            quoted = true;
            inQuotes = true;
            quoteLine = line;
        } else {
            field += c;
        }
    }
    if (inQuotes) throw new Error(`Line ${quoteLine}: a quoted value is not closed (missing ")`);
    if (field !== "" || quoted || fields.length) endRecord();
    return records;
}

function parseCsvRows(text) {
    const delimiter = detectDelimiter(text);
    const records = parseCsvRecords(text, delimiter).filter((r) => r.fields.some((f) => f !== ""));
    if (!records.length) throw new Error("The data file is empty");
    const header = records[0];
    const names = header.fields;
    const seen = new Map();
    names.forEach((name, i) => {
        if (!name) return; // columns without a name are ignored (e.g. a trailing separator)
        if (seen.has(name)) throw new Error(`Line ${header.line}: column "${name}" appears twice in the header row`);
        seen.set(name, i);
    });
    if (!seen.size) throw new Error(`Line ${header.line}: the header row has no column names`);
    const rows = [];
    for (const record of records.slice(1)) {
        if (record.fields.length > names.length && record.fields.slice(names.length).some((f) => f !== "")) {
            throw new Error(`Line ${record.line}: ${record.fields.length} values but the header row has ${names.length} columns`);
        }
        const row = {};
        for (const [name, i] of seen) row[name] = record.fields[i] ?? "";
        rows.push(row);
    }
    if (!rows.length) throw new Error("The data file has a header row but no data rows");
    return rows;
}

// ------------------------------------------------------------------ public API

/**
 * Parses a CSV or JSON data file -> rows [{ column: value }]. CSV values are text; JSON values keep their types.
 * Throws a readable Error (with the line number when possible).
 */
function parseDataFile(text, fileName = "") {
    let s = String(text ?? "");
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // BOM written by Excel / Notepad
    const trimmed = s.trim();
    if (!trimmed) throw new Error("The data file is empty");
    const name = String(fileName || "").toLowerCase();
    const isJson = name.endsWith(".json") || (!name.endsWith(".csv") && !name.endsWith(".tsv") && /^[[{]/.test(trimmed));
    const rows = isJson ? parseJsonRows(s) : parseCsvRows(s);
    if (!rows.length) throw new Error("The data file has no rows");
    return rows;
}

/** Column names over all rows, in first-seen order. */
function dataColumns(rows) {
    const out = [];
    const seen = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
        for (const key of Object.keys(row || {})) {
            if (!seen.has(key)) {
                seen.add(key);
                out.push(key);
            }
        }
    }
    return out;
}

module.exports = { parseDataFile, dataColumns, jsonErrorDetails };
