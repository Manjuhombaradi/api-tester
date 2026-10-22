#!/usr/bin/env node
"use strict";
// Checks the Electron fuses of a built app against package.json "build.electronFuses" (run by CI after
// electron-builder; see SECURITY.md, "Electron fuses"):
//   node scripts/check-fuses.js "dist/mac-arm64/API Tester.app"
//   node scripts/check-fuses.js "dist/win-unpacked/API Tester.exe"
//   node scripts/check-fuses.js dist/linux-unpacked/api-tester.bin     (Linux: the real binary, not the launcher)
// Exit code 0 = every configured fuse is set as configured, 1 = a fuse differs, 2 = usage or file problem.
const fs = require("fs");
const path = require("path");

// package.json key -> name in @electron/fuses (FuseV1Options), as electron-builder maps them
const FUSE_NAMES = {
    runAsNode: "RunAsNode",
    enableCookieEncryption: "EnableCookieEncryption",
    enableNodeOptionsEnvironmentVariable: "EnableNodeOptionsEnvironmentVariable",
    enableNodeCliInspectArguments: "EnableNodeCliInspectArguments",
    enableEmbeddedAsarIntegrityValidation: "EnableEmbeddedAsarIntegrityValidation",
    onlyLoadAppFromAsar: "OnlyLoadAppFromAsar",
    loadBrowserProcessSpecificV8Snapshot: "LoadBrowserProcessSpecificV8Snapshot",
    grantFileProtocolExtraPrivileges: "GrantFileProtocolExtraPrivileges",
};
// states in the fuse wire: the characters "0" / "1" ("r" = removed in this Electron version)
const STATE_NAMES = { 48: "off", 49: "on", 114: "removed" };

/** @electron/fuses as electron-builder uses it (a dependency of app-builder-lib). */
function loadFuses() {
    const builderDir = path.dirname(require.resolve("app-builder-lib/package.json"));
    return require(require.resolve("@electron/fuses", { paths: [builderDir] }));
}

async function main() {
    const target = process.argv[2];
    if (!target || process.argv.length > 3) {
        console.error("Usage: node scripts/check-fuses.js <built .app | .exe | Linux .bin>");
        return 2;
    }
    if (!fs.existsSync(target)) {
        console.error(`check-fuses: ${target} not found`);
        return 2;
    }
    const expected = require("../package.json").build.electronFuses || {};
    const { getCurrentFuseWire, FuseV1Options } = loadFuses();
    let wire;
    try {
        wire = await getCurrentFuseWire(target);
    } catch (err) {
        console.error(`check-fuses: ${target}: ${err.message}`);
        return 2;
    }
    let failed = 0;
    for (const [key, want] of Object.entries(expected)) {
        if (typeof want !== "boolean") continue; // e.g. resetAdHocDarwinSignature is not a fuse
        const name = FUSE_NAMES[key];
        if (!name) {
            console.error(`check-fuses: unknown fuse "${key}" in package.json build.electronFuses`);
            failed++;
            continue;
        }
        const state = wire[FuseV1Options[name]];
        const ok = state === (want ? 49 : 48);
        if (!ok) failed++;
        console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${STATE_NAMES[state] || state} (expected ${want ? "on" : "off"})`);
    }
    if (failed) console.error(`check-fuses: ${failed} fuse(s) of ${target} differ from package.json build.electronFuses`);
    else console.log(`check-fuses: all configured fuses of ${target} are set`);
    return failed ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(`check-fuses: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 2;
});
