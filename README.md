# API Tester

A desktop tool for **testing HTTP APIs**. Send requests, keep values in environments, check responses
with no-code assertions, chain requests by capturing values, run whole suites (also with data files),
and share your suites with anyone as a single file. It runs on Windows, macOS and Linux, works offline,
and has a command line version for CI pipelines.

**Download:** [latest release](https://github.com/Manjuhombaradi/api-tester/releases/latest) (Windows, macOS, Linux installers) · [source](https://github.com/Manjuhombaradi/api-tester) · [security](SECURITY.md)

> **macOS says *“Apple could not verify “API Tester.app” is free of malware…”*?** The installers are not signed with a paid
> Apple certificate yet, so macOS shows this for every download. Click **Done**, open **System Settings → Privacy & Security**,
> scroll down and click **Open Anyway** (once). Windows shows *“Windows protected your PC”*: **More info → Run anyway**.
> [Details and how to check the download first](#first-launch-of-the-unsigned-builds).

**Author:** Manjunagouda Hombaradi ([manjuhombaradi@gmail.com](mailto:manjuhombaradi@gmail.com))

Your data stays on your computer: the app sends requests only where you send them and contacts nothing else
(no telemetry, update checks or accounts). See [Security](#14-security) and [SECURITY.md](SECURITY.md).

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

The installers are not code-signed yet, so the operating system asks once. Check the file first: compare it with
`SHA256SUMS.txt` from the release, or run `gh attestation verify <file> --repo Manjuhombaradi/api-tester`
(see [SECURITY.md](SECURITY.md#7-verifying-a-download)).

- **Windows SmartScreen** ("Windows protected your PC"): click **More info**, then **Run anyway**.
- **macOS** (*"Apple could not verify "API Tester.app" is free of malware…"*, or *"API Tester" Not Opened* on older
  versions): click **Done**, open **System Settings → Privacy & Security**, scroll down and click
  **Open Anyway** (on older macOS: Control-click the app → **Open**). Or run once:
  `xattr -dr com.apple.quarantine "/Applications/API Tester.app"` — needed before using the command line
  version on a new Mac or CI runner, too.
- **Linux**: nothing to do. The launcher handles root logins and machines without a display, and keeps the Chromium
  sandbox on wherever the system allows it ([details](SECURITY.md#9-linux-chromium-sandbox)).

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

**Local files** (multipart file fields, binary bodies) are shown with their path and an approval badge. Files you
choose with **Choose file…** are approved. A file named by an imported suite is uploaded only after you allow it:
*"Allow upload of &lt;path&gt; to &lt;host&gt;?"* (**Allow once**, **Always for this suite**, **Cancel**).
Requests with *Verify TLS* turned off show a warning.

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
Mark passwords, tokens and keys as **secret**: they are masked on screen, in history and in reports, encrypted on
disk with your system's keychain, and left out of exports unless you choose to include them.

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
Scripts run only when you send, in a sandbox (no file or network access, 5 seconds at most). They can read and
change variables, so look at the scripts of suites you get from others (the import lists them).

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
      --strict-tls           always verify TLS certificates, also for requests that turn it off (API_TESTER_STRICT_TLS=1)
      --var <key=value>      set a variable (repeatable; visible in the process list, use --var-env for secrets)
      --var-env <key=NAME>   set a variable from the environment variable NAME (repeatable)
      --globals <file>       global variables (JSON object, list, or a Postman globals file)
      --allow-file <path>    allow uploads of this file or of the files in this folder (repeatable)
  -r, --reporter <list>      cli, junit, html, json (default cli)
  -o, --out <dir>            folder for report files (default ./api-tester-reports)
      --proxy <url>          HTTP proxy (default: HTTPS_PROXY / HTTP_PROXY; NO_PROXY hosts are reached directly)
      --no-color             plain output
      --echo-server          start the local echo server during the run
      --echo-port <n>        port for --echo-server (default 3999; also pass --var baseUrl=http://127.0.0.1:<n>)
api-tester echo-server [--port 3999] [--host 127.0.0.1] [--allow-host <name>]
api-tester --help | --version
environment: API_TESTER_VAR_<key>=value sets a variable (masked like --var-env)
```

Postman collections, OpenAPI / Swagger files and cURL commands can be run directly too.
Secret values are not in exported files: pass them from your CI's secret store (the run tells you which ones are missing).
The same goes for passwords and tokens typed straight into an *Auth* tab: put a variable there instead (for example `{{token}}`).

| How to pass a variable | Example | Notes |
|---|---|---|
| Environment variable `API_TESTER_VAR_<name>` | `API_TESTER_VAR_token=… api-tester run suite.apisuite` | Recommended for secrets: not in the process list or shell history |
| `--var-env <name>=<ENV_VAR>` | `api-tester run suite.apisuite --var-env token=API_TOKEN` | Reads the value of an existing environment variable |
| `--var <name>=<value>` | `--var baseUrl=https://staging.example.com` | Visible to other users in the process list: not for secrets |

Values from all three are masked (`•••••`) in the output and the reports (`--var` values that are plain web addresses,
small numbers or true / false stay readable).

**Local files**: a suite uploads local files (multipart file fields, binary bodies) only from its own folder. Allow other
files or folders with `--allow-file <path>` (repeatable); any other file makes the request fail with a message.

**TLS**: `--strict-tls` (or `API_TESTER_STRICT_TLS=1`) verifies certificates even for requests whose *Settings* turn it off;
`--insecure` turns verification off for every request (self-signed test servers only).

**GitHub Actions** (Docker image built from this repository's `Dockerfile`, or use Node.js). The secret goes in as an
environment variable, so it is neither in the command line nor in the reports:

```yaml
- name: API tests
  env:
    API_TESTER_VAR_token: ${{ secrets.API_TOKEN }}
  run: |
    docker build -t api-tester https://github.com/Manjuhombaradi/api-tester.git
    docker run --rm --user "$(id -u):$(id -g)" -e API_TESTER_VAR_token -v "$PWD:/work" api-tester \
      run tests/my-api.apisuite --env CI --strict-tls --reporter cli,junit --out reports
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
  commands, and shows what it found before adding anything: at the top, which requests upload local files, have scripts
  or turn off TLS certificate checks. Importing sends nothing and runs nothing.

---

## 11. The local echo server

The app includes a small API on `http://127.0.0.1:3999` for the sample suite and for trying things out. It runs only when
you start it: adding the sample suite starts it, and *Settings → Local echo server* starts, stops or auto-starts it and
changes the port. It is reachable from this computer only and answers only requests for `localhost` / `127.0.0.1`
(other host names get *421*, which protects it from web pages using DNS rebinding). Useful endpoints: `/anything` (echoes your request), `/status/404`, `/delay/2000`, `/json`,
`/xml`, `/image.png`, `/headers`, `/cookies/set?name=value`, `/basic-auth/user/pass`, `POST /login` (`demo` / `demo`),
`POST /auth/token` (OAuth 2.0, client `demo` / `secret`), `GET /me`, and `/users` (create, read, update, delete).
On the command line: `api-tester echo-server` (`--allow-host <name>` to answer another host name, e.g. a Docker service name;
in Docker publish it as `-p 127.0.0.1:3999:3999`).

---

## 12. Data, settings and logs

- Everything (suites, environments, globals, history, settings) is saved automatically in `workspace.json` in the data folder
  (*Settings → Open data folder*):
  - Windows: `%APPDATA%\API Tester`
  - macOS: `~/Library/Application Support/API Tester`
  - Linux: `~/.config/API Tester`
- `workspace.backup.json` there is a copy from the last start, in case you need to go back: **Import** it to get its suites and environments back (globals are not imported).
- Logs: `logs/api-tester.log` in the data folder (no URLs, headers or secrets).
- The data folder can only be opened by your user account (macOS / Linux: `0700`, files `0600`). Secret values are encrypted
  with the system keychain (macOS Keychain, Windows DPAPI, Linux GNOME Keyring / KWallet); on Linux without a keyring they are
  saved unencrypted and *Settings* tells you so.
- **Settings**: default timeout, follow redirects, verify TLS, **enforce TLS verification** (ignore *Verify TLS: Off* in requests
  and imported suites), proxy (with no-proxy list), maximum response size, history size, echo server, theme (system / light / dark).
- Developer tools are not available in the installed app; start it with `API_TESTER_DEVTOOLS=1` for troubleshooting.

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
| Certificate errors (self-signed test servers) | Turn off *Verify TLS* in the request's *Settings* tab or in *Settings* (a request's own setting is ignored while *Enforce TLS verification* is on); on the command line use `--insecure`. |
| Certificate errors behind a company proxy that inspects TLS | Add your company's root certificate (PEM file from IT): *Settings → Trusted CA certificates*, or on the command line `--ca-file company-root.pem` / `API_TESTER_CA_FILE` / `NODE_EXTRA_CA_CERTS`. Do not turn off TLS verification instead. |
| *This request uploads the local file …* | Allow it in the dialog (app), or add `--allow-file <path>` (command line). |
| Echo server answers *421* | The request used another host name. Use `127.0.0.1` / `localhost`, or start it with `--allow-host <name>`. |
| Linux: *Chromium sandbox disabled (…)* on stderr | Information only: the system cannot run the sandbox (root, container, AppImage on Ubuntu 23.10+). See [SECURITY.md](SECURITY.md#9-linux-chromium-sandbox). |
| Requests time out behind a company proxy | Set the proxy in *Settings* (command line: `--proxy` or `HTTPS_PROXY`). |
| *Port 3999 is already in use* | Another program (or a second copy) uses it. Choose another port in *Settings → Local echo server*. |
| The runner sends an old version | It runs the saved suite; save your open requests first. |
| Shared suite fails with 401 | Secret values are not exported: fill them in under *Environments*, or use `--var` on the command line. |
| Blank window in a VM | Start the app with `--disable-gpu`. |
| Linux: missing libraries | The launcher prints the exact `apt` / `dnf` command. The `.deb` installs them automatically. |
| Linux AppImage does not start | Use the `.deb` or `.tar.gz`, or run `./API-Tester-*.AppImage --appimage-extract && ./squashfs-root/AppRun`. |

---

## 14. Security

- **Network**: requests go only where you send them, from the app itself; nothing is contacted at startup or in the background
  (no telemetry, update checks, crash reports or accounts). Chromium's background services and spell-check downloads are off.
- **Your data** stays in the data folder on this computer, readable only by your account; secrets are encrypted at rest and
  masked in history, logs and reports.
- **Shared suites** cannot upload local files without your approval, scripts run only when you send (sandboxed), and the import
  lists local files, scripts and disabled TLS checks before anything is added.
- **Organisations**: turn on *Settings → Enforce TLS verification*, use `--strict-tls` and `API_TESTER_VAR_<name>` in CI, and keep
  the echo server on `127.0.0.1`. The [hardening guide](SECURITY.md#5-hardening-guide-for-organisations) has the full list.
- **Releases** include `SHA256SUMS.txt`, a build provenance attestation and an SBOM (CycloneDX). The builds are not code-signed yet.
- **Report a vulnerability** privately: the repository's *Security* tab → *Report a vulnerability*.

Details: [SECURITY.md](SECURITY.md).

---

## 15. Run from source and build the installers

Requires **Node.js 22.13 or newer**.

```bash
npm install
npm start                                 # desktop app
npm run cli -- run samples/sample.apisuite --echo-server   # command line version
npm run sample                            # the same, shorter
```

`npm install` and the double-click launchers below download the dependencies from the npm registry (exact versions and
hashes from `package-lock.json`; `npm ci` installs exactly those) and, on the first start, Electron from GitHub (checked against the checksums in the `electron` package). For
computers without internet access use the installers or the Docker image.

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

Each OS is best built on itself. The included GitHub Actions workflow (`.github/workflows/build.yml`) checks the dependencies
(`npm audit`, `npm audit signatures`), tests the command line version and builds all three; push a tag such as `v1.0.1` to get a
GitHub release with every installer, `SHA256SUMS.txt`, an SBOM and a build provenance attestation.
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
build/          icon, CLI wrappers (bin/), afterPack.js (Linux launcher, fuses on the Linux binary, macOS licence notices)
scripts/        npm start launcher, sample and icon generators, check-fuses.js and sbom-runtime.js (used by CI)
samples/        sample suite and data file
```
