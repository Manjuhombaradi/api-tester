#!/usr/bin/env node
"use strict";
// Writes the files in samples/ from the built-in sample (src/core/sample.js):  npm run samples
//   samples/sample.apisuite    the "Sample: Echo API" suite (demo secrets included, so it runs as is)
//   samples/sample-users.csv   data file for the data-driven request
// Try them:  npm run sample   (= api-tester run samples/sample.apisuite --echo-server)
// `npm run samples:check` (CI) only compares: exit code 1 when samples/ is older than src/core/sample.js.
// Ids and the export time differ on every export and are ignored.
const fs = require("fs");
const path = require("path");
const { createSampleSuite, SAMPLE_DATA_CSV, SAMPLE_DATA_FILE_NAME } = require("../src/core/sample");
const { exportSuite } = require("../src/core/suiteFile");

const dir = path.join(__dirname, "..", "samples");
const suiteFile = path.join(dir, "sample.apisuite");
const dataFile = path.join(dir, SAMPLE_DATA_FILE_NAME);
const suiteText = exportSuite(createSampleSuite(), { includeEnvironments: true, includeSecrets: true });
const dataText = SAMPLE_DATA_CSV.endsWith("\n") ? SAMPLE_DATA_CSV : `${SAMPLE_DATA_CSV}\n`;

// fields that change on every export
const VOLATILE = new Set(["id", "activeEnvironmentId", "exportedAt", "exportedWith"]);
function comparable(value) {
    if (Array.isArray(value)) return value.map(comparable);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).filter(([key]) => !VOLATILE.has(key)).map(([key, v]) => [key, comparable(v)]));
    }
    return value;
}

/** -> the first differing line of the two values ("line N: committed … / generated …"), or null when equal. */
function difference(committed, generated) {
    const a = JSON.stringify(comparable(committed), null, 2).split("\n");
    const b = JSON.stringify(comparable(generated), null, 2).split("\n");
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) return `line ${i + 1}:\n  committed: ${(a[i] || "(end)").trim()}\n  generated: ${(b[i] || "(end)").trim()}`;
    }
    return null;
}

function readOrProblem(file, problems) {
    try {
        return fs.readFileSync(file, "utf8");
    } catch (err) {
        problems.push(`${path.relative(process.cwd(), file)}: ${err.code === "ENOENT" ? "missing" : err.message}`);
        return null;
    }
}

function check() {
    const problems = [];
    const suite = readOrProblem(suiteFile, problems);
    if (suite !== null) {
        let diff;
        try {
            diff = difference(JSON.parse(suite), JSON.parse(suiteText));
        } catch (err) {
            diff = `not valid JSON: ${err.message}`;
        }
        if (diff) problems.push(`${path.relative(process.cwd(), suiteFile)} differs from src/core/sample.js (ids ignored), ${diff}`);
    }
    const csv = readOrProblem(dataFile, problems);
    if (csv !== null && csv.replace(/\r\n/g, "\n") !== dataText) problems.push(`${path.relative(process.cwd(), dataFile)} differs from SAMPLE_DATA_CSV in src/core/sample.js`);
    if (problems.length) {
        for (const p of problems) console.error(p);
        console.error("The sample files are out of date: run `npm run samples` and commit samples/.");
        process.exit(1);
    }
    console.log("samples/ is up to date.");
}

if (process.argv.includes("--check")) {
    check();
} else {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(suiteFile, suiteText);
    fs.writeFileSync(dataFile, dataText);
    console.log(`Wrote ${suiteFile}`);
    console.log(`Wrote ${dataFile}`);
}
