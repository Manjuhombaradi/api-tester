#!/usr/bin/env node
"use strict";
// Adds the runtime that ships inside the installers - Electron, its Chromium and its Node.js - to a CycloneDX
// SBOM made by @cyclonedx/cyclonedx-npm (which lists the npm packages in app.asar only; Electron is a dev
// dependency there). Without these entries, vulnerability scanners miss Chromium / Node.js CVEs.
// Run it with the Electron binary that is shipped, so the versions are the real ones (CI does this):
//   ELECTRON_RUN_AS_NODE=1 dist/linux-unpacked/api-tester.bin scripts/sbom-runtime.js dist/API-Tester-1.0.1-sbom.cdx.json
const fs = require("fs");

function component(name, version, { purl, cpe, license, description, website }) {
    return {
        type: "framework",
        name,
        version,
        "bom-ref": `runtime|${name}@${version}`,
        description,
        licenses: [{ license: { id: license, acknowledgement: "declared" } }],
        purl,
        cpe,
        externalReferences: [{ type: "website", url: website }],
        properties: [{ name: "api-tester:shipped-as", value: "Electron runtime of the desktop installers (not in the Docker image)" }],
    };
}

function main() {
    const file = process.argv[2];
    if (!file) {
        console.error("Usage: ELECTRON_RUN_AS_NODE=1 <shipped Electron binary> scripts/sbom-runtime.js <sbom.cdx.json>");
        return 2;
    }
    const { electron, chrome, node } = process.versions;
    if (!electron || !chrome) {
        console.error("sbom-runtime: run this with the shipped Electron binary and ELECTRON_RUN_AS_NODE=1, not with Node.js");
        return 2;
    }
    const bom = JSON.parse(fs.readFileSync(file, "utf8"));
    if (bom.bomFormat !== "CycloneDX") {
        console.error(`sbom-runtime: ${file} is not a CycloneDX JSON SBOM`);
        return 2;
    }
    const runtime = [
        component("electron", electron, {
            purl: `pkg:npm/electron@${electron}`,
            cpe: `cpe:2.3:a:electronjs:electron:${electron}:*:*:*:*:*:*:*`,
            license: "MIT",
            description: "Electron desktop runtime (LICENSE.electron.txt in the installation)",
            website: "https://www.electronjs.org/",
        }),
        component("chromium", chrome, {
            purl: `pkg:generic/chromium@${chrome}`,
            cpe: `cpe:2.3:a:google:chrome:${chrome}:*:*:*:*:*:*:*`,
            license: "BSD-3-Clause",
            description: "Chromium, embedded in Electron (third-party notices: LICENSES.chromium.html in the installation)",
            website: "https://www.chromium.org/",
        }),
        component("node", node, {
            purl: `pkg:generic/node@${node}`,
            cpe: `cpe:2.3:a:nodejs:node.js:${node}:*:*:*:*:*:*:*`,
            license: "MIT",
            description: "Node.js, embedded in Electron (main process and the command line version of the installed app)",
            website: "https://nodejs.org/",
        }),
    ];
    const refs = new Set(runtime.map((c) => c["bom-ref"]));
    bom.components = (bom.components || []).filter((c) => !refs.has(c["bom-ref"])).concat(runtime);
    const rootRef = bom.metadata && bom.metadata.component && bom.metadata.component["bom-ref"];
    if (rootRef) {
        bom.dependencies = bom.dependencies || [];
        let root = bom.dependencies.find((d) => d.ref === rootRef);
        if (!root) bom.dependencies.push(root = { ref: rootRef, dependsOn: [] });
        root.dependsOn = Array.from(new Set((root.dependsOn || []).concat(Array.from(refs))));
        for (const ref of refs) if (!bom.dependencies.some((d) => d.ref === ref)) bom.dependencies.push({ ref, dependsOn: [] });
    }
    fs.writeFileSync(file, `${JSON.stringify(bom, null, 2)}\n`);
    console.log(`sbom-runtime: added electron ${electron}, chromium ${chrome}, node ${node} to ${file} (${bom.components.length} components)`);
    return 0;
}

process.exitCode = main();
