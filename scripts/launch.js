#!/usr/bin/env node
"use strict";
// Starts the desktop app from source (npm start). Clears ELECTRON_RUN_AS_NODE, which some environments
// (e.g. editor extension hosts) set and which would make Electron behave like plain Node.js.
// `npm start -- run suite.apisuite ...` (or echo-server) runs the command line version with this Node.js instead.
// Written in ES5 syntax on purpose: an old Node.js must be able to parse this file to print the version
// message below instead of a SyntaxError.
var path = require("path");
var fs = require("fs");
var spawn = require("child_process").spawn;
var spawnSync = require("child_process").spawnSync;

var MIN_NODE = [22, 13];
var nodeVersion = process.versions.node.split(".").map(Number);
if (nodeVersion[0] < MIN_NODE[0] || (nodeVersion[0] === MIN_NODE[0] && nodeVersion[1] < MIN_NODE[1])) {
    console.error("API Tester needs Node.js " + MIN_NODE.join(".") + " or newer to run from source (found " + process.version + ").");
    console.error("Install the current LTS from https://nodejs.org (Linux: https://github.com/nodesource/distributions),");
    console.error("or use a ready-made package instead: Windows installer / portable .exe, macOS .dmg, Linux .deb / AppImage.");
    process.exit(1);
}

var appDir = path.join(__dirname, "..");
var userArgs = process.argv.slice(2);

// npm runs scripts in the package folder; INIT_CWD is the folder `npm start` was called from. The app and the
// command line version start there, so relative suite, data and --out paths mean what the user typed.
function callerDir() {
    var dir = process.env.npm_lifecycle_event && process.env.INIT_CWD;
    try {
        if (dir && fs.statSync(dir).isDirectory()) return dir;
    } catch (_) { /* gone or not accessible: use the current folder */ }
    return process.cwd();
}

function run(command, args, env) {
    var child;
    try {
        child = spawn(command, args, { stdio: "inherit", env: env, cwd: callerDir() });
    } catch (err) {
        spawnFailed(command, err);
        return;
    }
    child.on("error", function (err) { spawnFailed(command, err); });
    child.on("exit", function (code, signal) { process.exit(signal ? 1 : (code == null ? 0 : code)); });
    ["SIGINT", "SIGTERM"].forEach(function (sig) {
        process.on(sig, function () { child.kill(sig); });
    });
}

// command line version: no Electron needed
var firstArg = userArgs.filter(function (a) { return a.charAt(0) !== "-"; })[0];
if (firstArg === "run" || firstArg === "echo-server" || userArgs.indexOf("--cli") >= 0) {
    run(process.execPath, [path.join(appDir, "src", "cli.js")].concat(userArgs), process.env);
    return;
}

// Electron's binary is OS specific: a node_modules folder copied from (or shared with) another system
// would start the wrong binary.
var EXPECTED_BINARY = { darwin: "Electron.app/Contents/MacOS/Electron", win32: "electron.exe" }[process.platform] || "electron";
var REINSTALL_HINT = "node_modules was installed on another system (copied or shared folder). Delete the node_modules folder and start again\n" +
    "(the Start API Tester scripts reinstall automatically), or delete it and run: npm install && npm start";
var installedBinary = null;
try {
    installedBinary = fs.readFileSync(path.join(path.dirname(require.resolve("electron/package.json")), "path.txt"), "utf8").trim();
} catch (_) { /* not downloaded yet (Electron downloads its binary on first use) or not installed */ }
if (installedBinary && installedBinary !== EXPECTED_BINARY) {
    console.error("The installed Electron binary (" + installedBinary + ") is not for " + process.platform + "-" + process.arch + ".");
    console.error(REINSTALL_HINT);
    process.exit(1);
}

var electron;
try {
    electron = require("electron");
} catch (err) {
    console.error("Could not load Electron: " + String(err && err.message ? err.message : err).split("\n")[0]);
    console.error("Run `npm install` (needs internet) and start again. If that does not help, delete the node_modules folder first.");
    process.exit(1);
}

function spawnFailed(command, err) {
    console.error("Could not start " + command + ": " + (err && err.message ? err.message : err));
    // ENOEXEC / EBADARCH (macOS: "Bad CPU type"): binary for another OS or CPU; EACCES: lost its executable bit
    if (err && (err.code === "ENOEXEC" || err.code === "EACCES" || err.code === "EBADARCH" || err.errno === -8 || err.errno === -86)) {
        console.error("The Electron binary cannot run on this system (" + process.platform + "-" + process.arch + "). " + REINSTALL_HINT);
    }
    process.exit(1);
}

// Linux: why the Chromium sandbox cannot work here, or null when it can. Same rules as the packaged launcher
// (build/afterPack.js): it is only turned off as root, without usable user namespaces (containers; Ubuntu
// 23.10+ allows them only for programs with an AppArmor profile, and node_modules/electron has none) and
// without a root-owned SUID chrome-sandbox, or on request. Decided here because Electron checks it before
// any app code runs.
function linuxSandboxProblem(electronPath) {
    if (userArgs.indexOf("--no-sandbox") >= 0) return "requested with --no-sandbox";
    var optOut = process.env.API_TESTER_DISABLE_SANDBOX;
    if (optOut && ["0", "false", "no"].indexOf(optOut) < 0) return "API_TESTER_DISABLE_SANDBOX is set";
    if (process.getuid && process.getuid() === 0) return "running as root";
    var probe = spawnSync("unshare", ["-Ur", "true"], { stdio: "ignore" });
    if (!probe.error && probe.status === 0) return null;
    // setuid helper (mode 4755, owned by root); Chromium cannot start it from a path with a space
    var helper = path.join(path.dirname(electronPath), "chrome-sandbox");
    try {
        var stat = fs.statSync(helper);
        if (stat.uid === 0 && (stat.mode & 2048) && helper.indexOf(" ") < 0) return null;
    } catch (_) { /* no helper */ }
    return "user namespaces are not available or are blocked on this system";
}

var env = {};
Object.keys(process.env).forEach(function (key) { env[key] = process.env[key]; });
delete env.ELECTRON_RUN_AS_NODE;
var args = [appDir].concat(userArgs);
if (process.platform === "linux") {
    var sandboxProblem = linuxSandboxProblem(electron);
    if (sandboxProblem) {
        console.error("API Tester: Chromium sandbox disabled (" + sandboxProblem + "). See SECURITY.md (Linux sandbox).");
        env.ELECTRON_DISABLE_SANDBOX = "1";
        env.API_TESTER_SANDBOX_DISABLED = sandboxProblem;
        if (args.indexOf("--no-sandbox") < 0) args.splice(1, 0, "--no-sandbox");
    }
}

run(electron, args, env);
