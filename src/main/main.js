"use strict";
// Electron main process of API Tester: window, menus, IPC, single instance, files opened from the OS,
// and the command line mode of the installed app (`<app> run suite.apisuite`, spec §3.2).
const path = require("path");
const fs = require("fs");
const { fileURLToPath } = require("url");
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, screen, session, safeStorage } = require("electron");

// ------------------------------------------------------------------ no network traffic of its own
// API Tester contacts nothing by itself (no updates, telemetry or crash reports): requests go only where the
// user sends them, from Node.js in this process (not through Chromium). Chromium's background services are
// switched off. Its Hunspell spell checker (Windows, Linux) downloaded a dictionary from Google's CDN as soon as
// the default session started (measured in the 1.0.0 security review): no spell check languages, and a
// download address on this computer that nothing answers, so no request can leave the machine.
for (const name of ["disable-background-networking", "disable-component-update", "disable-domain-reliability", "no-pings"]) {
    app.commandLine.appendSwitch(name);
}
const NO_DOWNLOAD_URL = "http://127.0.0.1:9/";

/** True for the app's own page (loaded from the app folder). */
function isAppPage(contents) {
    try {
        return !!contents && !contents.isDestroyed() && String(contents.getURL()).startsWith("file://");
    } catch (_) {
        return false;
    }
}

function hardenSession(s) {
    try { s.setSpellCheckerDictionaryDownloadURL(NO_DOWNLOAD_URL); } catch (_) { /* not available */ }
    // macOS uses its own spell checker (no download); there this call does nothing
    if (process.platform !== "darwin") { try { s.setSpellCheckerLanguages([]); } catch (_) { /* not available */ } }
    try { s.setSpellCheckerEnabled(false); } catch (_) { /* not available */ }
    // the page needs no web permissions (camera, microphone, location, notifications, reading the clipboard ...);
    // only writing to the clipboard, for the Copy buttons of the app's own page
    const allowed = (contents, permission) => permission === "clipboard-sanitized-write" && isAppPage(contents);
    s.setPermissionRequestHandler((contents, permission, callback) => callback(allowed(contents, permission)));
    s.setPermissionCheckHandler((contents, permission) => allowed(contents, permission));
    s.setDevicePermissionHandler(() => false);
}
app.on("session-created", hardenSession);
// no <webview>, no pop-up windows, in any web contents
app.on("web-contents-created", (_e, contents) => {
    contents.on("will-attach-webview", (e) => e.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
});

// ------------------------------------------------------------------ early process setup
// Arguments after the executable (dev: electron <app folder> <args>; packaged: <app> <args>).
const cliArgs = process.argv.slice(app.isPackaged ? 1 : 2);
const CLI_COMMANDS = ["run", "echo-server", "help"];
// Linux without a display server (server over SSH, CI container): only the command line version can work.
const NO_DISPLAY = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
// Electron / Chromium switches (added by launchers or the OS) that mean nothing to the CLI.
const IGNORED_SWITCH = /^(--(no-sandbox|disable-gpu|disable-gpu-sandbox|in-process-gpu|enable-logging|cli|ozone-platform(=.*)?|inspect(-brk)?(=.*)?|remote-debugging-port=.*|allow-file-access-from-files|original-process-start-time=.*)|-psn_.*)$/;
// Files the window can import when given on the command line or opened from the file manager.
const OPENABLE_FILE = /\.(apisuite|json|ya?ml)$/i;
// Developer tools: when run from source. Installed builds have none (no menu entry, no shortcut) unless started
// with API_TESTER_DEVTOOLS=1, for support and troubleshooting.
const DEVTOOLS = !app.isPackaged || process.env.API_TESTER_DEVTOOLS === "1";
// Remote debugging (--remote-debugging-port / --remote-debugging-pipe) would let another program run code in the
// app's page, with its access to saved suites and secrets: refused in installed builds, like the developer tools.
if (!DEVTOOLS && ["remote-debugging-port", "remote-debugging-pipe"].some((name) => app.commandLine.hasSwitch(name))) {
    process.stderr.write("API Tester: remote debugging (--remote-debugging-port / --remote-debugging-pipe) is not allowed in installed builds. "
        + "For support and troubleshooting, start it with the environment variable API_TESTER_DEVTOOLS=1.\n");
    app.exit(1);
    process.exit(1); // app.exit() only takes effect once the event loop runs: stop before anything else starts
}

function isCliInvocation(args) {
    if (args.includes("--cli")) return true;
    const first = args.find((a) => typeof a === "string" && a && !a.startsWith("-"));
    if (first) return CLI_COMMANDS.includes(first);
    // `--help` / `--version` alone (no file to open): print instead of opening a window
    return args.some((a) => ["--help", "-h", "--version", "-v"].includes(a));
}

const CLI_MODE = isCliInvocation(cliArgs) || NO_DISPLAY;
if (CLI_MODE) {
    if (process.platform === "linux") {
        if (NO_DISPLAY) app.commandLine.appendSwitch("ozone-platform", "headless");
        app.commandLine.appendSwitch("in-process-gpu");
    }
    app.disableHardwareAcceleration();
}
// Electron has already turned this (set by the Linux launcher) into its --no-sandbox switch; do not pass it on
// to programs the app opens (file manager, browser), which would otherwise run their own sandbox disabled.
// The launcher's reason (API_TESTER_SANDBOX_DISABLED) goes into the app's log once the logger is ready.
const SANDBOX_DISABLED_REASON = String(process.env.API_TESTER_SANDBOX_DISABLED || (app.commandLine.hasSwitch("no-sandbox") ? "started with --no-sandbox" : ""))
    .replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
delete process.env.ELECTRON_DISABLE_SANDBOX;
delete process.env.API_TESTER_SANDBOX_DISABLED;

if (CLI_MODE) runCommandLine();
else startDesktop();

// ------------------------------------------------------------------ command line mode
function runCommandLine() {
    try { if (app.dock) app.dock.hide(); } catch (_) { /* not on this OS */ }
    const args = cliArgs.filter((a) => !IGNORED_SWITCH.test(a));
    if (NO_DISPLAY && !isCliInvocation(cliArgs)) {
        process.stderr.write("No graphical display found (DISPLAY / WAYLAND_DISPLAY not set): showing the command line version.\n");
    }
    process.on("uncaughtException", (err) => process.stderr.write(`Unexpected error: ${(err && err.stack) || err}\n`));
    process.on("unhandledRejection", (err) => process.stderr.write(`Unexpected error: ${(err && err.message) || err}\n`));
    // no windows in this mode: keep running until the command finishes
    app.on("window-all-closed", () => {});
    const exit = (code) => {
        // flush what was written (pipes are asynchronous on macOS) before the hard exit
        process.stdout.write("", () => process.stderr.write("", () => app.exit(code)));
    };
    let runCli;
    try {
        ({ runCli } = require("./commandLine"));
    } catch (err) {
        process.stderr.write(`ERROR: the command line version could not be loaded: ${err.message}\n`);
        exit(1);
        return;
    }
    runCli(args).then((code) => exit(code), (err) => {
        process.stderr.write(`ERROR: ${(err && err.message) || err}\n`);
        exit(1);
    });
}

// ------------------------------------------------------------------ desktop mode
function startDesktop() {
    if (!app.requestSingleInstanceLock()) {
        // a second launch (or a double-clicked suite file) is forwarded to the running window
        app.quit();
        return;
    }

    const { createLogger } = require("./logger");
    const { Workspace, ensurePrivateDir, PRIVATE_FILE_MODE } = require("./workspace");
    const { createApi } = require("./ipc");

    const dataDir = app.getPath("userData");
    const logDir = path.join(dataDir, "logs");
    const windowStateFile = path.join(dataDir, "window-state.json");
    // suites, history and logs can hold credentials: only this user may open the folders
    ensurePrivateDir(dataDir);
    ensurePrivateDir(logDir);
    const log = createLogger(logDir);
    process.on("uncaughtException", (err) => log.error(`Unexpected error: ${(err && err.stack) || err}`));
    process.on("unhandledRejection", (err) => log.error(`Unhandled promise rejection: ${(err && err.stack) || err}`));
    log.info(`API Tester ${app.getVersion()} starting (${process.platform}-${process.arch}, Electron ${process.versions.electron}${app.isPackaged ? "" : ", from source"})`);
    if (DEVTOOLS && app.isPackaged) log.info("Developer tools are enabled (API_TESTER_DEVTOOLS=1)");
    if (SANDBOX_DISABLED_REASON) log.warn(`Chromium sandbox disabled (${SANDBOX_DISABLED_REASON}). See SECURITY.md (Linux sandbox).`);

    if (process.platform === "win32") app.setAppUserModelId("com.apitester.app");

    // read once the app is ready (decrypting saved secrets needs the system keychain), before the window opens
    const workspace = new Workspace(dataDir, { log, secretStore: createSecretStore(log) });

    let mainWindow = null;
    const pendingFiles = []; // files to import once the page listens for "open-file"
    const listening = new Set(); // webContents ids whose page listens for "open-file"
    let startupError = null;

    const api = createApi({
        workspace,
        log,
        dataDir,
        logDir,
        cliCommand,
        getWindow: (sender) => (sender ? BrowserWindow.fromWebContents(sender) : mainWindow)
    });

    // only our own pages (file:// from the app folder) may use the API
    function isTrusted(event) {
        const frame = event.senderFrame;
        const url = frame && typeof frame.url === "string" ? frame.url : "";
        return url.startsWith("file://") && !!BrowserWindow.fromWebContents(event.sender);
    }
    ipcMain.handle("api", (event, method, args) => {
        if (!isTrusted(event)) return { ok: false, error: "Not allowed" };
        return api.dispatch(event.sender, method, args);
    });
    ipcMain.on("api-listening", (event, channel) => {
        if (channel !== "open-file" || !isTrusted(event)) return;
        listening.add(event.sender.id);
        deliverFiles();
    });

    // ------------------------------------------------------------------ files from the OS
    // A suite file on a command line: plain or relative path (resolved against `cwd`) or a file:// URI
    // (Linux file managers pass those through the .desktop entry's %U).
    function fileArg(args, cwd) {
        for (const a of args) {
            if (typeof a !== "string" || !a || a.startsWith("-")) continue;
            let file = a;
            if (/^file:\/\//i.test(file)) {
                try { file = fileURLToPath(file); } catch (_) { continue; }
            }
            if (!OPENABLE_FILE.test(file)) continue;
            // the portable Windows .exe runs from a temporary folder: relative paths mean the folder of the .exe
            file = path.resolve(cwd || process.env.PORTABLE_EXECUTABLE_DIR || process.cwd(), file);
            try {
                if (fs.statSync(file).isFile()) return { file };
            } catch (_) { /* reported below */ }
            return { error: `File not found: ${file}` };
        }
        return null;
    }

    function deliverFiles() {
        if (!mainWindow || mainWindow.isDestroyed() || !listening.has(mainWindow.webContents.id)) return;
        while (pendingFiles.length) mainWindow.webContents.send("open-file", pendingFiles.shift());
    }

    function openFile(file) {
        log.info(`Opening ${file}`);
        api.allowImport(file); // chosen by the user in the file manager or on the command line
        pendingFiles.push(file);
        deliverFiles();
        showWindow();
    }

    function showWindow() {
        if (!app.isReady()) return; // the window is created once the app is ready
        if (!mainWindow || mainWindow.isDestroyed()) {
            createWindow();
            return;
        }
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }

    const first = fileArg(cliArgs);
    if (first && first.file) {
        api.allowImport(first.file);
        pendingFiles.push(first.file);
    }
    if (first && first.error) startupError = first.error;

    app.on("second-instance", (_e, argv, workingDirectory) => {
        // relative paths are relative to the folder the second copy was started in
        const arg = fileArg(argv.slice(1), workingDirectory);
        if (arg && arg.file) {
            openFile(arg.file);
        } else {
            showWindow();
            if (arg && arg.error) showWarning(arg.error);
        }
    });
    // macOS: suite double-clicked in Finder or dropped on the Dock icon (can arrive before the app is ready)
    app.on("open-file", (e, file) => {
        e.preventDefault();
        openFile(path.resolve(file));
    });

    function showWarning(message) {
        log.warn(message);
        const options = { type: "warning", title: "API Tester", message, buttons: ["OK"] };
        const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
        (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)).catch(() => {});
    }

    // ------------------------------------------------------------------ window
    function readWindowState() {
        try {
            const s = JSON.parse(fs.readFileSync(windowStateFile, "utf8"));
            return s && typeof s === "object" ? s : {};
        } catch (_) {
            return {};
        }
    }

    function writeWindowState(state) {
        try {
            ensurePrivateDir(dataDir);
            fs.writeFileSync(windowStateFile, JSON.stringify(state), { mode: PRIVATE_FILE_MODE });
        } catch (err) {
            log.warn(`Window position not saved: ${err.message}`);
        }
    }

    // -> { bounds, area, maximized }: saved bounds clamped to the work area of their display (or a default
    // size), the work area the window opens on, and whether it was maximised.
    function windowBounds() {
        const state = readWindowState();
        const b = state.bounds;
        const valid = b && ["x", "y", "width", "height"].every((k) => Number.isFinite(b[k])) && b.width > 0 && b.height > 0;
        // only restore bounds that are still visible on a connected display
        if (valid && screen.getAllDisplays().some((d) => {
            const a = d.workArea;
            return b.x < a.x + a.width - 100 && b.x + b.width > a.x + 100 && b.y >= a.y - 20 && b.y < a.y + a.height - 100;
        })) {
            const r = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
            const area = screen.getDisplayMatching(r).workArea;
            const width = Math.min(r.width, area.width);
            const height = Math.min(r.height, area.height);
            const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
            return {
                area,
                maximized: !!state.maximized,
                bounds: { x: clamp(r.x, area.x, area.x + area.width - width), y: clamp(r.y, area.y, area.y + area.height - height), width, height }
            };
        }
        const area = screen.getPrimaryDisplay().workArea;
        return { area, maximized: !!state.maximized, bounds: { width: Math.min(1400, area.width), height: Math.min(900, area.height) } };
    }

    function createWindow() {
        const { bounds, area, maximized } = windowBounds();
        // small VM consoles (1024x768, RDP at a low resolution): never larger than the screen
        const smallScreen = area.width < 1000 || area.height < 640;
        const win = new BrowserWindow({
            ...bounds,
            minWidth: Math.min(900, area.width),
            minHeight: Math.min(560, area.height),
            title: "API Tester",
            show: false,
            backgroundColor: nativeTheme.shouldUseDarkColors ? "#11151b" : "#f5f7fa",
            webPreferences: {
                preload: path.join(__dirname, "preload.js"),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                spellcheck: false,
                webviewTag: false,
                devTools: DEVTOOLS
            }
        });
        mainWindow = win;
        const contentsId = win.webContents.id;
        if (maximized || smallScreen) win.maximize();
        let shown = false;
        const show = () => {
            if (shown || win.isDestroyed()) return;
            shown = true;
            win.show();
            if (startupError) {
                showWarning(startupError);
                startupError = null;
            }
        };
        win.once("ready-to-show", show);
        setTimeout(show, 6000); // never stay invisible when the page has a problem
        win.loadFile(path.join(__dirname, "..", "renderer", "index.html")).catch((err) => {
            // ERR_ABORTED: replaced by another navigation (reload while loading), not a problem
            if (!/ERR_ABORTED/.test(err.message)) log.error(`The window could not load: ${err.message}`);
        });

        const wc = win.webContents;
        // the page opens no windows (links to the web are not part of the app): every window.open is refused
        wc.setWindowOpenHandler(() => ({ action: "deny" }));
        // dropped files and links must not replace the app page (the page handles drops itself). Reloading the
        // app page is fine: location.reload() (the "Try again" button of the startup error screen) arrives here too.
        const withoutHash = (u) => String(u || "").replace(/[?#].*$/, "");
        wc.on("will-navigate", (e, legacyUrl) => {
            const target = withoutHash(e && typeof e.url === "string" ? e.url : legacyUrl);
            if (target.startsWith("file://") && target === withoutHash(wc.getURL())) return;
            e.preventDefault();
        });
        // a reload or crash: the new page has to subscribe again before files are delivered
        wc.on("did-start-navigation", (e, url, isInPlace, isMainFrame) => {
            const mainFrame = typeof e.isMainFrame === "boolean" ? e.isMainFrame : isMainFrame;
            const sameDocument = typeof e.isSameDocument === "boolean" ? e.isSameDocument : isInPlace;
            if (mainFrame && !sameDocument) listening.delete(contentsId);
        });
        wc.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
            if (isMainFrame) log.error(`Page failed to load (${code} ${description}): ${url}`);
        });
        wc.on("render-process-gone", (_e, details) => {
            listening.delete(contentsId);
            log.error(`The window stopped working (${details.reason}, exit code ${details.exitCode})`);
            if (details.reason === "clean-exit" || win.isDestroyed()) return;
            dialog.showMessageBox(win, {
                type: "error",
                title: "API Tester",
                message: "The window stopped working.",
                detail: "Your saved suites are safe. Reload the window to continue.",
                buttons: ["Reload", "Close"],
                defaultId: 0
            }).then(({ response }) => {
                if (win.isDestroyed()) return;
                if (response === 0) win.reload();
                else win.close();
            }).catch(() => {});
        });
        // the page blocks closing (beforeunload) while tabs have unsaved changes: ask the user
        wc.on("will-prevent-unload", (e) => {
            const choice = dialog.showMessageBoxSync(win, {
                type: "question",
                title: "API Tester",
                message: "You have unsaved changes.",
                detail: "Close API Tester anyway? Unsaved changes are lost.",
                buttons: ["Close Anyway", "Cancel"],
                defaultId: 1,
                cancelId: 1
            });
            if (choice === 0) e.preventDefault(); // ignore the page's objection and close
        });
        // text fields get the usual Cut / Copy / Paste menu (pages that show their own menu prevent this one)
        wc.on("context-menu", (_e, params) => {
            const items = [];
            if (params.isEditable) {
                items.push({ role: "undo", enabled: params.editFlags.canUndo }, { role: "redo", enabled: params.editFlags.canRedo }, { type: "separator" },
                    { role: "cut", enabled: params.editFlags.canCut }, { role: "copy", enabled: params.editFlags.canCopy },
                    { role: "paste", enabled: params.editFlags.canPaste }, { type: "separator" }, { role: "selectAll" });
            } else if (params.selectionText && params.selectionText.trim()) {
                items.push({ role: "copy" }, { type: "separator" }, { role: "selectAll" });
            }
            if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
        });

        const saveState = () => {
            if (win.isDestroyed()) return;
            const isMax = win.isMaximized();
            const previous = readWindowState();
            writeWindowState(isMax || win.isFullScreen() ? { ...previous, maximized: isMax } : { maximized: false, bounds: win.getBounds() });
        };
        win.on("close", saveState);
        win.on("closed", () => {
            listening.delete(contentsId);
            if (mainWindow === win) mainWindow = null;
        });
        return win;
    }

    // ------------------------------------------------------------------ menu
    function send(channel, payload) {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
    }

    function buildMenu() {
        const isMac = process.platform === "darwin";
        const cmd = (command) => () => {
            showWindow();
            send("menu", command);
        };
        // Shortcuts the page handles itself (save, send): shown in the menu, but the key press goes to the page.
        // macOS cannot show an accelerator without registering it, so there the menu entry has none.
        const pageShortcut = (accelerator) => (isMac ? {} : { accelerator, registerAccelerator: false });
        const sep = { type: "separator" };
        const openFolder = (dir) => () => {
            fs.mkdirSync(dir, { recursive: true });
            shell.openPath(dir).catch(() => {});
        };
        const template = [
            ...(isMac ? [{
                label: app.name,
                submenu: [
                    { label: "About API Tester", click: cmd("about") },
                    sep,
                    { label: "Settings…", accelerator: "Cmd+,", click: cmd("settings") },
                    sep,
                    { role: "services" },
                    sep,
                    { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
                    sep,
                    { role: "quit" }
                ]
            }] : []),
            {
                label: "File",
                submenu: [
                    { label: "New Request", accelerator: "CmdOrCtrl+N", click: cmd("newRequest") },
                    { label: "New Suite", accelerator: "CmdOrCtrl+Shift+N", click: cmd("newSuite") },
                    sep,
                    { label: "Import…", accelerator: "CmdOrCtrl+O", click: cmd("import") },
                    { label: "Export Suite…", accelerator: "CmdOrCtrl+Shift+E", click: cmd("exportSuite") },
                    sep,
                    { label: "Save", ...pageShortcut("CmdOrCtrl+S"), click: cmd("save") },
                    ...(isMac ? [] : [sep, { label: "Settings…", accelerator: "Ctrl+,", click: cmd("settings") }, sep, { role: "quit" }])
                ]
            },
            { role: "editMenu" },
            {
                label: "Request",
                submenu: [
                    { label: "Send", ...pageShortcut("CmdOrCtrl+Enter"), click: cmd("send") },
                    sep,
                    { label: "Run Suite…", accelerator: "CmdOrCtrl+Shift+R", click: cmd("runner") },
                    { label: "Environments…", accelerator: "CmdOrCtrl+E", click: cmd("environments") }
                ]
            },
            {
                label: "View",
                submenu: [
                    { label: "Toggle Light / Dark Theme", accelerator: "CmdOrCtrl+Shift+L", click: cmd("toggleTheme") },
                    sep,
                    { role: "reload", accelerator: "CmdOrCtrl+Alt+R" },
                    // installed builds: only for support, with API_TESTER_DEVTOOLS=1
                    ...(DEVTOOLS ? [{ role: "toggleDevTools" }] : []),
                    sep,
                    { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
                    sep,
                    { role: "togglefullscreen" }
                ]
            },
            // no "Close" entry: Ctrl/Cmd+W closes the current tab in the page, not the window
            ...(isMac ? [{ label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, sep, { role: "front" }] }] : []),
            {
                role: "help",
                submenu: [
                    { label: "API Tester Help", accelerator: "F1", click: cmd("help") },
                    sep,
                    { label: "Open Data Folder", click: openFolder(dataDir) },
                    { label: "Open Log Folder", click: openFolder(logDir) },
                    ...(isMac ? [] : [sep, { label: "About API Tester", click: cmd("about") }])
                ]
            }
        ];
        Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    }

    // ------------------------------------------------------------------ lifecycle
    app.whenReady().then(async () => {
        hardenSession(session.defaultSession); // also done on "session-created"; repeated here on purpose
        await workspace.loadAsync(); // small file; the window's first call gets it from memory
        nativeTheme.themeSource = workspace.settings.theme;
        buildMenu();
        if (!mainWindow) createWindow(); // an open-file / second-instance event may have created it already
        app.on("activate", () => {
            if (!mainWindow || mainWindow.isDestroyed()) createWindow();
        });
        api.autoStartEcho();
    }).catch((err) => {
        log.error(`Start failed: ${err.stack || err.message}`);
        dialog.showErrorBox("API Tester", `API Tester could not start: ${err.message}`);
        app.exit(1);
    });

    app.on("window-all-closed", () => {
        if (process.platform !== "darwin") app.quit();
    });

    // Runs `step` and resolves when its promise settles or after `ms`, whichever comes first (errors are ignored).
    const settleWithin = (step, ms) => {
        let timer;
        return Promise.race([
            new Promise((resolve) => resolve(step())).catch(() => {}),
            new Promise((resolve) => { timer = setTimeout(resolve, ms); })
        ]).finally(() => clearTimeout(timer));
    };
    // All windows are closed (the page may have cancelled closing before this point): stop the echo server and
    // running requests, write unsaved workspace changes, then quit for real.
    let cleaningUp = false;
    let cleanedUp = false;
    app.on("will-quit", (e) => {
        if (cleanedUp) return;
        e.preventDefault();
        if (cleaningUp) return;
        cleaningUp = true;
        // never hang on quit (that would keep the echo port and the single-instance lock): hard exit as a last resort
        setTimeout(() => app.exit(0), 8000).unref();
        (async () => {
            await settleWithin(() => api.shutdown(), 3000);
            await settleWithin(() => workspace.flush(2500), 3000);
            log.info("API Tester stopped");
            log.close();
            cleanedUp = true;
            app.quit();
        })();
    });

    // ------------------------------------------------------------------ helpers
    /**
     * Encryption of the secrets in workspace.json with Electron's safeStorage: macOS Keychain, Windows DPAPI
     * (bound to this user and computer), Linux Secret Service / KWallet. Linux without a keyring ("basic_text")
     * counts as not available: the values are then saved unencrypted, in a file only this user can read. The
     * keychain is only asked once there is something to encrypt or decrypt.
     */
    function createSecretStore(logger) {
        let available = null;
        const plainTextOnly = () => {
            if (process.platform !== "linux") return false;
            try { return ["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend()); } catch (_) { return true; }
        };
        const note = () => {
            if (!available) logger.warn("No system keychain available: secrets are saved unencrypted in workspace.json (readable only by this user account)");
        };
        return {
            async available() {
                if (available === null) {
                    try { available = !!(await safeStorage.isAsyncEncryptionAvailable()) && !plainTextOnly(); } catch (_) { available = false; }
                    note();
                }
                return available;
            },
            availableSync() {
                if (available === null && app.isReady()) {
                    try { available = !!safeStorage.isEncryptionAvailable() && !plainTextOnly(); } catch (_) { available = false; }
                    note();
                }
                return !!available;
            },
            encrypt: async (text) => (await safeStorage.encryptStringAsync(text)).toString("base64"),
            decrypt: async (base64) => (await safeStorage.decryptStringAsync(Buffer.from(base64, "base64"))).result,
            // only for the last write while quitting (the asynchronous one did not finish in time)
            encryptSync: (text) => safeStorage.encryptString(text).toString("base64"),
            decryptSync: (base64) => safeStorage.decryptString(Buffer.from(base64, "base64"))
        };
    }

    // Shell-ready command that runs the CLI of this installation (shown in the runner and in Help).
    function cliCommand() {
        const quote = (s) => (/[\s"'&()]/.test(s) ? `"${s}"` : s);
        if (!app.isPackaged) return `node ${quote(path.join(__dirname, "..", "cli.js"))}`;
        // the portable .exe runs from a temporary folder that is deleted on exit: it has no command line version
        if (process.platform === "win32" && process.env.PORTABLE_EXECUTABLE_FILE) return null;
        if (process.platform === "win32") return quote(path.join(path.dirname(process.execPath), "bin", "api-tester.cmd"));
        if (process.platform === "darwin") return quote(path.join(process.resourcesPath, "bin", "api-tester"));
        if (process.env.APPIMAGE) return quote(process.env.APPIMAGE);
        let exe = process.execPath;
        // the Linux launcher script (build/afterPack.js) runs the real binary as api-tester.bin
        if (exe.endsWith(".bin") && fs.existsSync(exe.slice(0, -4))) exe = exe.slice(0, -4);
        try {
            // the .deb links /usr/bin/api-tester to the launcher (an extracted tar.gz does not)
            if (fs.realpathSync("/usr/bin/api-tester") === fs.realpathSync(exe)) return "api-tester";
        } catch (_) { /* no link: show the full path */ }
        return quote(exe);
    }
}
