# API Tester

A desktop tool for **testing HTTP APIs**. Send requests, keep values in environments, check responses
with no-code assertions, chain requests by capturing values, run whole suites (also with data files),
and share your suites with anyone as a single file. It runs on Windows, macOS and Linux, works offline,
and has a command line version for CI pipelines.

---

## 1. Download and start

Pick the file for your machine. None of them need Node.js or extra setup; only the `.deb` asks for your password (sudo).

| System | File | How to start |
|---|---|---|
| **Windows 10/11** | `API-Tester-Setup-<version>-x64.exe` | Double-click it. It installs for the current user (no admin), creates desktop and Start-menu shortcuts and opens the app. |
| Windows, no install | `API-Tester-Portable-<version>-x64.exe` | Double-click it and it runs as is, for example from a USB stick. |
| **macOS** (Apple silicon) | `API-Tester-<version>-mac-arm64.dmg` | Open it and drag the app into *Applications*. |
| macOS (Intel) | `API-Tester-<version>-mac-x64.dmg` | Same as above (built by the CI workflow or `npm run dist:mac`). |
| **Ubuntu / Debian** | `API-Tester-<version>-linux-amd64.deb` (`arm64.deb` for ARM) | Run `sudo apt install ./API-Tester-*-linux-amd64.deb` (ARM: `…-linux-arm64.deb`), then start *API Tester* from the app menu or run `api-tester`. |
| Any Linux | `API-Tester-<version>-linux-x86_64.AppImage` | Run `chmod +x API-Tester-*.AppImage`, then double-click it or run `./API-Tester-*.AppImage`. Needs FUSE (`fusermount3`), which desktop distributions have; on minimal systems use the `.deb` / `.tar.gz`. |
| Any Linux (archive) | `API-Tester-<version>-linux-x64.tar.gz` | `tar xzf API-Tester-<version>-linux-x64.tar.gz && cd API-Tester-<version>-linux-x64 && ./api-tester` |
| **CI / no desktop** | Docker image, or any package above | See [Command line and CI](#9-command-line-and-ci). |

### First launch of the unsigned builds

The installers are not code-signed yet, so the operating system asks once:

- **Windows SmartScreen** ("Windows protected your PC"): click **More info**, then **Run anyway**.
- **macOS** ("API Tester" Not Opened): click **Done**, open **System Settings → Privacy & Security** and click
  **Open Anyway** (on older macOS: Control-click the app → **Open**). Or run once:
  `xattr -dr com.apple.quarantine "/Applications/API Tester.app"` — needed before using the command line
  version on a new Mac or CI runner, too.
- **Linux**: nothing to do. The launcher handles the Chromium sandbox, root logins and machines without a display.

---

## 2. First steps

On first start the welcome screen offers three choices:

- **Try the sample suite** (recommended): adds *Sample: Echo API* and starts the built-in echo server on your
  computer, so every request works offline. Open the requests one by one; each one's *Docs* tab explains
  what it shows.
- **Start empty**: a new suite with one request.
- **Import…**: a suite file from a colleague (`.apisuite`), a Postman collection, an OpenAPI / Swagger file
  or a cURL command.

Then:

1. Pick a request in the sidebar (or **New request**, `Ctrl/Cmd + N`).
2. Choose the method, type the URL and press **Send** (`Ctrl/Cmd + Enter`).
3. The response panel shows the status, time and size, plus *Body*, *Headers*, *Cookies*, *Tests*, *Timeline* and *Console*.
4. Press **Save** (`Ctrl/Cmd + S`). Everything is stored on this computer automatically; there is no account.

**Suites** hold folders and requests, plus their environments. Right-click (or `⋯`) an item for *New request / folder*,
*Rename*, *Duplicate*, *Delete*, *Run*, *Export* and *Copy as cURL*. Drag and drop to reorder. Click a suite or folder
to edit its variables, default headers and authorization (inherited by everything inside it).

---

## 3. Requests

| Tab | What you set |
|---|---|
| **Params** | Query parameters, kept in sync with the URL |
| **Headers** | Request headers; headers inherited from the suite / folders are shown read-only |
| **Body** | JSON (with *Format* / *Validate*), text, XML, form (URL-encoded), multipart (text and files), binary file, GraphQL |
| **Auth** | Inherit, none, Basic, Bearer token, API key (header or query), OAuth 2.0 (client credentials or password grant; tokens are fetched and cached for you) |
| **Assertions** | Checks on the response, see [Assertions](#5-assertions) |
| **Capture** | Values to keep for later requests, see [Captures](#6-captures-and-chaining) |
| **Scripts** | Optional JavaScript before / after the request |
| **Settings** | Timeout, follow redirects, verify TLS certificates (each *Inherit / On / Off*) |
| **Docs** | A description for your team |

Paste a cURL command into the URL field (or use **Import**) to turn it into a request. **Code snippets…** in the request's
`⋯` menu shows the request as cURL, JavaScript (fetch), Python (requests) and PowerShell; **Copy as cURL** copies it directly.

---

## 4. Variables and environments

Write `{{name}}` anywhere: URL, params, headers, body, auth fields, assertions. Typing `{{` suggests the variables you have;
hovering the URL shows the resolved value and any unknown names.

Where values come from (the first match wins):

1. **Runtime**: values captured during this session or the current run (*Environments → Runtime* shows and clears them)
2. **Data row**: columns of the data file in the runner
3. **Environment**: the active environment of the suite (picker in the top bar)
4. **Folder** variables (innermost first), then **suite** variables
5. **Globals**: shared by all suites on this computer (*Environments → Globals*)

**Environments** (for example *Local*, *Staging*, *Production*) belong to a suite and travel with it when you export it.
Mark passwords, tokens and keys as **secret**: they are masked on screen and in reports, and left out of exports unless
you choose to include them.

Dynamic values: `{{$guid}}`, `{{$uuid}}`, `{{$timestamp}}`, `{{$timestampMs}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`,
`{{$randomFloat}}`, `{{$randomString}}`, `{{$randomEmail}}`, `{{$randomBoolean}}`.

---

## 5. Assertions

Assertions are checks on the response, built from drop-downs, so no code is needed. Each row is
**source → (property) → operator → expected value**:

| Source | Property | Example |
|---|---|---|
| Status code | | Status code *equals* `200` |
| Status text, Content-Type, Body (text) | | Body *contains* `"active"` |
| Response time (ms), Body size (bytes) | | Response time *less than* `500` |
| Header | header name | `Location` *starts with* `https://` |
| JSON value | JSONPath, e.g. `$.data[0].id` | `$.items` *length greater than* `0` |
| JSON schema | | body *matches JSON schema* (paste the schema) |

Operators: equals, does not equal, contains, does not contain, starts with, ends with, greater / less than (or equal),
exists, does not exist, matches regex, is of type, length equals / greater / less than, is one of, is not one of,
is empty, is not empty, matches JSON schema. The expected value may use `{{variables}}`.

Shortcuts: **Add suggested** creates sensible checks from the last response (status, response time, content type, JSON keys).
In the response body, click a JSON value and choose **Assert equals …** (or *exists*, *type is …*, *Capture as variable*):
the row is added with the JSONPath filled in.

---

## 6. Captures and chaining

The **Capture** tab stores a value from the response in a variable, so the next requests can use it:

| Source | Property |
|---|---|
| JSON value | JSONPath, e.g. `$.token` |
| Header | header name |
| Regex on body | a regular expression with one group, e.g. `id=(\d+)` |
| Status code, Whole body | |
| Cookie | cookie name |

Choose where to keep it: **runtime** (this session or run), **environment** (saved in the active environment) or **global**.

Example: *Log in* captures `$.token` into `token`; the next requests use `Authorization: Bearer {{token}}` (or the Bearer
auth type with `{{token}}`). The sample suite's folder *2. Login and chaining* shows the whole flow.

---

## 7. Scripts (optional)

For special cases you can add JavaScript before the request (*pre*) or after the response (*post*).
Scripts run in a sandbox (no file or network access, 5 seconds at most).

```js
// post-response script
test("has users", () => {
    expect(response.status).toBe(200);
    expect(response.json().users).toHaveLength(3);
});
vars.set("firstUserId", response.json().users[0].id);        // runtime; or "environment" / "global"
console.log("got", response.json().users.length, "users");
```

Available: `vars.get / vars.set`, `env.name`, `request` (changeable in pre scripts), `response` (`status`, `headers`, `body`,
`json()`, `time`), `test()`, `expect()` (`toBe`, `toEqual`, `toContain`, `toBeGreaterThan`, `toBeLessThan`, `toMatch`,
`toBeTruthy`, `toBeFalsy`, `toBeDefined`, `toHaveProperty`, `toHaveLength`, `.not`) and `console.log`.
Test results appear in the *Tests* tab and in reports, log lines in *Console*.

---

## 8. Runner and data files

**Runner** (`Ctrl/Cmd + Shift + R`, or right-click a suite / folder → *Run*) runs many requests in order:

- tick the folders and requests to run, choose the environment,
- **Iterations**: repeat the whole selection,
- **Data file**: a CSV (comma or semicolon, first row = column names) or a JSON list of objects. Each row is one iteration
  and its columns are variables, for example `{{name}}` and `{{email}}`,
- **Delay** between requests and **Stop on first failure**.

Values captured by one request are available to the next ones, across the whole run. The list shows every request with
status, time and passed / failed checks (click for details). **Export report** saves an **HTML** report (to read or send),
**JUnit XML** (for CI tools) or **JSON**.

The runner also shows the same run as a command line, ready to copy into a CI pipeline.

---

## 9. Command line and CI

The command line version runs exported suites without a window and returns an exit code:
**0** = all passed, **1** = failures or errors (or a report file could not be written), **2** = invalid options or files.

Export your suite first (**Export**, saves `<name>.apisuite`) and commit it next to your code.

| Installation | Command |
|---|---|
| Linux `.deb` | `api-tester run my-api.apisuite` |
| Linux AppImage / `.tar.gz` | `./API-Tester-*.AppImage run my-api.apisuite` / `./api-tester run my-api.apisuite` (in containers without FUSE: `./API-Tester-*.AppImage --appimage-extract-and-run run …`) |
| macOS | `"/Applications/API Tester.app/Contents/Resources/bin/api-tester" run my-api.apisuite` |
| Windows (installer) | cmd: `"%LOCALAPPDATA%\Programs\api-tester\bin\api-tester.cmd" run my-api.apisuite`<br>PowerShell: `& "$env:LOCALAPPDATA\Programs\api-tester\bin\api-tester.cmd" run my-api.apisuite` |
| Node.js 22.13+ (source folder) | `node src/cli.js run my-api.apisuite` (after `npm ci --omit=dev`) |
| Docker | `docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" api-tester run my-api.apisuite` (image: `docker build -t api-tester .` in the source folder) |

Tips: on macOS, `sudo mkdir -p /usr/local/bin && sudo ln -sf "/Applications/API Tester.app/Contents/Resources/bin/api-tester" /usr/local/bin/api-tester`
gives you a short `api-tester` command. The app's runner and Help show the exact command for your installation.
The portable Windows `.exe` has no command line version; use the installer, Node.js or Docker.

```
api-tester run <suite> [options]
  -e, --env <name|id>        environment to use (default: the suite's active environment)
  -n, --iterations <n>       run the selection n times
  -d, --data <file>          CSV or JSON data file, one iteration per row
  -f, --folder <name|id>     only this folder or request (repeatable; also "Folder/Sub")
      --delay <ms>           pause between requests
      --bail                 stop at the first failed request
      --timeout <ms>         timeout for requests that do not set their own (default 30000, 0 = none)
  -k, --insecure             do not verify TLS certificates, for every request
      --var <key=value>      set a variable, e.g. a secret from your CI (repeatable)
      --globals <file>       global variables (JSON object, list, or a Postman globals file)
  -r, --reporter <list>      cli, junit, html, json (default cli)
  -o, --out <dir>            folder for report files (default ./api-tester-reports)
      --proxy <url>          HTTP proxy (default: HTTPS_PROXY / HTTP_PROXY)
      --no-color             plain output
      --echo-server          start the local echo server during the run
      --echo-port <n>        port for --echo-server (default 3999; also pass --var baseUrl=http://127.0.0.1:<n>)
api-tester echo-server [--port 3999] [--host 127.0.0.1]
api-tester --help | --version
```

Postman collections, OpenAPI / Swagger files and cURL commands can be run directly too.
Secret values are not in exported files: pass them with `--var name=value` (the run tells you which ones are missing).
The same goes for passwords and tokens typed straight into an *Auth* tab: put a variable there instead (for example `{{token}}`)
and pass it with `--var token=…`.

**GitHub Actions** (Docker image built from this repository's `Dockerfile`, or use Node.js):

```yaml
- name: API tests
  run: |
    docker build -t api-tester https://github.com/<you>/api-tester.git   # your copy of this repository
    docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" api-tester \
      run tests/my-api.apisuite --env CI --var token=${{ secrets.API_TOKEN }} --reporter cli,junit --out reports
```

**GitLab CI / Jenkins**: run the same command and publish `reports/*.junit.xml` as JUnit test results.

---

## 10. Sharing suites

- **Export** (top bar or right-click a suite) saves one `.apisuite` file with all folders, requests, assertions, captures,
  scripts and, if you want, the environments. Secret values are left out unless you tick *Include secret values*.
- Send the file by e-mail or chat, or commit it to your repository.
- The receiver uses **Import** (or drags the file onto the window, or double-clicks it) and gets the same suite, and fills in
  the secret values in *Environments*.
- **Import** also reads Postman collections (v2.0 / v2.1) and environments, OpenAPI 3 / Swagger 2 (JSON or YAML) and cURL
  commands, and shows what it found before adding anything.

---

## 11. The local echo server

The app includes a small API on `http://127.0.0.1:3999` for the sample suite and for trying things out (*Settings → Local echo server*
to change the port or turn it off). Useful endpoints: `/anything` (echoes your request), `/status/404`, `/delay/2000`, `/json`,
`/xml`, `/image.png`, `/headers`, `/cookies/set?name=value`, `/basic-auth/user/pass`, `POST /login` (`demo` / `demo`),
`POST /auth/token` (OAuth 2.0, client `demo` / `secret`), `GET /me`, and `/users` (create, read, update, delete).
On the command line: `api-tester echo-server`.

---

## 12. Data, settings and logs

- Everything (suites, environments, globals, history, settings) is saved automatically in `workspace.json` in the data folder
  (*Settings → Open data folder*):
  - Windows: `%APPDATA%\API Tester`
  - macOS: `~/Library/Application Support/API Tester`
  - Linux: `~/.config/API Tester`
- `workspace.backup.json` there is a copy from the last start, in case you need to go back: **Import** it to get its suites and environments back (globals are not imported).
- Logs: `logs/api-tester.log` in the data folder.
- **Settings**: default timeout, follow redirects, verify TLS, proxy (with no-proxy list), maximum response size, history size,
  echo server, theme (system / light / dark).

### Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Send / Save | `Ctrl/Cmd + Enter` / `Ctrl/Cmd + S` |
| New request / New suite | `Ctrl/Cmd + N` / `Ctrl/Cmd + Shift + N` |
| Close tab / Next tab | `Ctrl/Cmd + W` / `Ctrl + Tab` |
| Search requests / URL field | `Ctrl/Cmd + K` / `Ctrl/Cmd + L` |
| Import / Environments / Runner / Settings | `Ctrl/Cmd + O` / `Ctrl/Cmd + E` / `Ctrl/Cmd + Shift + R` / `Ctrl/Cmd + ,` |
| Help | `F1` |

---

## 13. Troubleshooting

| Problem | Fix |
|---|---|
| *Connection refused* | The server is not running or the port is wrong. For the sample suite, start the echo server (*Settings*). |
| *Unknown variables: {{name}}* | The variable is not defined in the active environment, suite, folder or globals, or the right environment is not selected. |
| Certificate errors (self-signed test servers) | Turn off *Verify TLS* in the request's *Settings* tab or in *Settings*; on the command line use `--insecure`. |
| Requests time out behind a company proxy | Set the proxy in *Settings* (command line: `--proxy` or `HTTPS_PROXY`). |
| *Port 3999 is already in use* | Another program (or a second copy) uses it. Choose another port in *Settings → Local echo server*. |
| The runner sends an old version | It runs the saved suite; save your open requests first. |
| Shared suite fails with 401 | Secret values are not exported: fill them in under *Environments*, or use `--var` on the command line. |
| Blank window in a VM | Start the app with `--disable-gpu`. |
| Linux: missing libraries | The launcher prints the exact `apt` / `dnf` command. The `.deb` installs them automatically. |
| Linux AppImage does not start | Use the `.deb` or `.tar.gz`, or run `./API-Tester-*.AppImage --appimage-extract && ./squashfs-root/AppRun`. |

---

## 14. Run from source and build the installers

Requires **Node.js 22.13 or newer**.

```bash
npm install
npm start                                 # desktop app
npm run cli -- run samples/sample.apisuite --echo-server   # command line version
npm run sample                            # the same, shorter
```

Double-click launchers (they install dependencies on first run): `Start API Tester.command` (macOS),
`Start API Tester.bat` (Windows), `start-api-tester.sh` (Linux; command line version when there is no display).
Both scripts also run the command line version, e.g. `./start-api-tester.sh run my-api.apisuite`; `npm run echo` starts the echo server.

Build installers (output in `dist/`):

```bash
npm run dist:win      # Setup + portable .exe
npm run dist:mac      # .dmg + .zip (arm64 and x64)
npm run dist:linux    # .deb, AppImage, .tar.gz (x64 and arm64)
npm run docker:build  # command line Docker image
```

Each OS is best built on itself. The included GitHub Actions workflow (`.github/workflows/build.yml`) tests the command
line version and builds all three; push a tag such as `v1.0.0` to get a GitHub release with every installer.
`npm run icon` renders `build/icon.svg` to `build/icon.png`; `npm run samples` regenerates `samples/` after a change to
`src/core/sample.js` (CI checks this with `npm run samples:check`).

### Project layout
```
src/core/       engine shared by the app and the command line (no Electron):
                model, variables, prepare/http/auth/cookies, assertions, captures, scripts,
                runner, data files, reports, suite files and importers, echo server, sample suite
src/main/       Electron main process: main.js (window, menus, single instance, files from the OS),
                ipc.js (all app functions for the window), workspace.js (saving), preload.js,
                commandLine.js (the command line version)
src/renderer/   user interface (plain HTML/CSS/JS, no build step)
src/cli.js      command line entry point (Node.js, Docker, installed app)
build/          icon, CLI wrappers (bin/), Linux launcher hook (afterPack.js)
samples/        sample suite and data file
```
