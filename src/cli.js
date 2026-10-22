#!/usr/bin/env node
"use strict";
// Command line entry point: `node src/cli.js run suite.apisuite ...` (npm run cli, Docker, the installed app's
// api-tester command via ELECTRON_RUN_AS_NODE). The implementation is in src/main/commandLine.js.
// Keep this file parseable by old Node.js versions (ES5 syntax only): the version check below must be able
// to run there and print a clear message instead of a SyntaxError.
var nodeVersion = process.versions.node.split(".").map(Number);
if (nodeVersion[0] < 22 || (nodeVersion[0] === 22 && nodeVersion[1] < 13)) {
    console.error("API Tester needs Node.js 22.13 or newer (found " + process.version + ").");
    console.error("Install the current LTS from https://nodejs.org, or use the installed app's api-tester command or the Docker image.");
    process.exit(2);
}

require("./main/commandLine").main(process.argv.slice(2));
