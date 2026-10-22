#!/usr/bin/env node
"use strict";
// Renders build/icon.svg to build/icon.png (1024 x 1024, transparent corners) with Electron's offscreen
// rendering, so no image tools are needed:  npm run icon
// Started with Node.js, it restarts itself inside Electron (ELECTRON_RUN_AS_NODE cleared).
const path = require("path");
const fs = require("fs");

const SVG = path.join(__dirname, "..", "build", "icon.svg");
const PNG = path.join(__dirname, "..", "build", "icon.png");
const SIZE = 1024;

if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) {
    const { spawn } = require("child_process");
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [__filename], { stdio: "inherit", env });
    child.on("exit", (code) => process.exit(code == null ? 1 : code));
    child.on("error", (err) => {
        console.error(`Could not start Electron: ${err.message}`);
        process.exit(1);
    });
} else {
    const { app, BrowserWindow } = require("electron");
    app.disableHardwareAcceleration();
    if (app.dock) app.dock.hide();
    app.whenReady().then(async () => {
        const win = new BrowserWindow({
            show: false,
            width: SIZE,
            height: SIZE,
            useContentSize: true,
            transparent: true,
            frame: false,
            webPreferences: { offscreen: true }
        });
        win.webContents.setFrameRate(1);
        const svg = fs.readFileSync(SVG, "utf8");
        const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block;width:${SIZE}px;height:${SIZE}px}</style></head><body>${svg}</body></html>`;
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        await new Promise((r) => setTimeout(r, 500)); // fonts and first paint
        let image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
        const size = image.getSize();
        if (size.width !== SIZE || size.height !== SIZE) image = image.resize({ width: SIZE, height: SIZE, quality: "best" });
        fs.writeFileSync(PNG, image.toPNG());
        console.log(`Wrote ${PNG} (${image.getSize().width}x${image.getSize().height})`);
        app.exit(0);
    }).catch((err) => {
        console.error(`Rendering the icon failed: ${err.message}`);
        app.exit(1);
    });
}
