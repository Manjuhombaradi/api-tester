#!/usr/bin/env bash
# Linux/macOS: run API Tester from source (installs dependencies on first run).
#   ./start-api-tester.sh                         desktop window
#   ./start-api-tester.sh run suite.apisuite      command line version (also: echo-server, --help)
# The current folder is kept: relative suite, data and --out paths are relative to where you are,
# not to the API Tester folder.
APP_DIR="$(cd "$(dirname "$0")" && pwd)" || exit 1
ALTERNATIVES="Or use a ready-made package instead: .deb / AppImage (Linux), .dmg (macOS), or Docker for the command line version."
if ! command -v node >/dev/null 2>&1; then
    echo "Node.js 22.13 or newer is required: https://nodejs.org (Linux: https://github.com/nodesource/distributions)."
    echo "$ALTERNATIVES"
    exit 1
fi
# Electron's installer needs Node.js >= 22.13 (distribution packages are often older)
if ! node -e 'var v=process.versions.node.split(".").map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=13)?0:1)' 2>/dev/null; then
    echo "Node.js 22.13 or newer is required, found $(node -v 2>/dev/null || echo "an unknown version")."
    echo "Install the current LTS from https://nodejs.org (Linux: https://github.com/nodesource/distributions)."
    echo "$ALTERNATIVES"
    exit 1
fi

# command line version: needs no Electron and no display
CLI=""
case "$1" in
    run|echo-server|help|--help|-h|--version|-v|--cli) CLI=1 ;;
esac
if [ -z "$CLI" ] && [ "$(uname)" = "Linux" ] && [ -z "$DISPLAY" ] && [ -z "$WAYLAND_DISPLAY" ]; then
    echo "No graphical display found - showing the command line version."
    CLI=1
fi

if [ -n "$CLI" ]; then
    # the command line version only needs the runtime dependencies (plain JavaScript, no Electron download);
    # a node_modules folder from another system works for it as is. Install messages go to stderr so
    # they do not mix with the run's output.
    if [ ! -d "$APP_DIR/node_modules" ]; then
        echo "First run: installing dependencies (one time, needs internet)..." >&2
        (cd "$APP_DIR" && npm install --no-audit --no-fund --omit=dev) >&2 || exit 1
    fi
    exec node "$APP_DIR/src/cli.js" "$@"
fi

# node_modules must match this OS / CPU (Electron's binary is platform specific): a folder copied from
# or shared with another machine is reinstalled once.
MODULES="$APP_DIR/node_modules"
SYSTEM="$(uname -s)-$(uname -m)"
if [ "$(uname -s)" = "Darwin" ]; then ELECTRON_BINARY="Electron.app/Contents/MacOS/Electron"; else ELECTRON_BINARY="electron"; fi
INSTALL=""
if [ ! -d "$MODULES" ]; then
    INSTALL="First run: installing dependencies (one time, needs internet)..."
elif [ "$(cat "$MODULES/.installed-for" 2>/dev/null)" != "$SYSTEM" ]; then
    if [ -f "$MODULES/.installed-for" ] || { [ -f "$MODULES/electron/path.txt" ] && [ "$(cat "$MODULES/electron/path.txt")" != "$ELECTRON_BINARY" ]; }; then
        INSTALL="node_modules was installed on another system - reinstalling for $SYSTEM (one time, needs internet)..."
        # Electron downloads the binary for this system on the next start
        rm -rf "$MODULES/electron/dist" "$MODULES/electron/path.txt"
    else
        # no marker yet: an earlier install may have been interrupted - npm install completes it (quick when complete)
        INSTALL="Checking dependencies (one time)..."
    fi
fi
if [ -n "$INSTALL" ]; then
    echo "$INSTALL"
    (cd "$APP_DIR" && npm install --no-audit --no-fund) || exit 1
    echo "$SYSTEM" > "$MODULES/.installed-for"
fi
# --prefix runs the app's start script without leaving this folder: scripts/launch.js starts the app
# in the folder npm was called from, so a relative suite path on the command line opens the right file
exec npm --prefix "$APP_DIR" start -- "$@"
