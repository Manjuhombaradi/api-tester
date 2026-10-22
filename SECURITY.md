# Security

This page is for security teams and administrators who decide whether API Tester may be used in their
organisation, and for anyone who wants to report a vulnerability. It describes version **1.0.1**.

In short:

- **Network**: API Tester sends requests only where you send them. It connects to nothing when it starts, and has
  no telemetry, analytics, update check, crash reporting, licence check or account.
- **Data**: everything stays on your computer, in a folder only your user account can open. Passwords, tokens and
  other secrets are encrypted with the operating system's keychain where one is available.
- **Shared suites** cannot upload your files, turn off certificate checks without telling you, or run code when
  you open them. Reports and history mask secrets.
- **Releases** come with `SHA256SUMS.txt`, a build provenance attestation and a CycloneDX SBOM. The installers are
  not code-signed yet: [check the download](#7-verifying-a-download) before you allow it to run.

Contents: [1. Network](#1-what-the-app-does-on-the-network) ·
[2. Data on disk](#2-data-stored-on-this-computer) ·
[3. Shared suites](#3-shared-suites-and-imported-files) ·
[4. Defaults](#4-default-settings-and-their-risks) ·
[5. Hardening guide](#5-hardening-guide-for-organisations) ·
[6. Third-party components](#6-third-party-components) ·
[7. Verifying a download](#7-verifying-a-download) ·
[8. Electron hardening and fuses](#8-electron-hardening-and-fuses) ·
[9. Linux sandbox](#9-linux-chromium-sandbox) ·
[10. Running from source](#10-running-from-source) ·
[11. Reporting a vulnerability](#11-reporting-a-vulnerability) ·
[12. Changes in 1.0.1](#12-security-changes-in-101)

---

## 1. What the app does on the network

This is the complete list of connections API Tester makes. All of them start from something you do.

| Connection | When | Where to |
|---|---|---|
| Your requests | You press **Send**, run the **Runner**, or run `api-tester run` | The URL of each request. If a proxy is set (*Settings → Proxy*; command line: `--proxy`, or `HTTPS_PROXY` / `HTTP_PROXY`, with `NO_PROXY`), through that proxy. |
| Redirects of your requests | Only when *Follow redirects* is on (default on) | The `Location` the server returns. To **another server** (scheme, host or port differ), `Authorization`, `Proxy-Authorization`, `Cookie`, the API-key header and any header that contains a secret variable are **not** sent, and a 307 / 308 redirect that would re-send the request body is **not** followed. |
| OAuth 2.0 token requests | When you send a request whose *Auth* is OAuth 2.0 and no valid token is cached | The token URL in that *Auth* tab |
| Local echo server (listens) | Only when you start it: *Settings → Local echo server*, adding the sample suite, `--echo-server` or `api-tester echo-server` | Listens on `127.0.0.1:3999` (this computer only). It answers only requests addressed to `localhost`, `127.0.0.1`, `[::1]` or its listen address (other host names get 421, which stops DNS rebinding from web pages), and sends CORS headers without credentials. |
| Links | You click a link | Your web browser opens it (https only) |

What it does **not** do:

- No connection at startup or in the background: no update check, telemetry, analytics, crash reports, licence
  check, account or cloud sync. There is no code for any of these in the app or its dependencies.
- Requests are sent by Node.js in the app's main process, not by the browser engine (Chromium). The window cannot
  contact the network itself: its Content-Security-Policy allows only the app's own files (`connect-src 'self'`).
- Opening or importing a file (`.apisuite`, Postman, OpenAPI, cURL) only reads it. No remote `$ref`, no URL fetch.
- The HTML preview of a response runs in a sandboxed frame without scripts. It cannot load images, styles or
  fonts from the internet.
- Chromium's own background services are switched off: spell-check dictionary downloads, component updates,
  domain reliability reports, background networking and hyperlink-auditing pings. Spell checking is off.
- Web permissions (camera, microphone, location, notifications, reading the clipboard, devices) are always denied.
  Only writing to the clipboard is allowed, for the app's *Copy* buttons.

**Measured.** The 1.0.0 security review captured all non-loopback traffic. The command line version (`--help`, and a
run of the sample suite with `--echo-server`) sent **zero** packets. The desktop app's only unrequested connection
was Chromium's one-time download from Google's CDN (`*.gvt1.com`, the spell-check dictionary) on the first start
with a new profile. Version 1.0.1 prevents it: spell checking is off and the dictionary download address points to
this computer. To check it yourself, start the app with a fresh profile behind a firewall that logs outbound
connections: the app needs no outbound access except to the APIs you test.

## 2. Data stored on this computer

| What | Where |
|---|---|
| Data folder | Windows `%APPDATA%\API Tester` · macOS `~/Library/Application Support/API Tester` · Linux `~/.config/API Tester` (*Settings → Open data folder*) |
| Suites, environments, globals, history, settings, file approvals | `workspace.json` in the data folder; `workspace.backup.json` is the copy from the last start |
| Window size and position | `window-state.json` |
| Log | `logs/api-tester.log`: start / stop, errors and warnings. No URLs, headers, bodies or secrets. |
| Chromium profile (cache, local storage of the app's own page) | Other files in the data folder |

- **Permissions**: on macOS and Linux the data folder and the log folder are `0700` and the app's files `0600`, so
  other users of the computer cannot read them. On Windows the folder is in your user profile, which only you and
  administrators can open.
- **Secrets are encrypted at rest** with Electron `safeStorage`: secret variable values; passwords, tokens, client
  secrets and API-key values in *Auth* tabs; credential headers and query parameters; the proxy password. The key is
  kept by the operating system: macOS Keychain, Windows DPAPI (bound to your user account), Linux Secret Service
  (GNOME Keyring, KWallet). On Linux without a keyring the values are saved unencrypted in the `0600` file and
  *Settings* says so once.
- **Memory only, never written**: the cookie jar, cached OAuth 2.0 tokens and values captured during a session or run.
- **History** keeps the request as you wrote it (with `{{variables}}`, secrets masked), not response bodies.
- **Exports** (`.apisuite`) contain no secret values unless you tick *Include secret values*, never encrypted values,
  and never the list of approved files.
- **Reports** (HTML, JUnit, JSON) and the command line output mask `Authorization`, `Proxy-Authorization`, `Cookie`
  and `Set-Cookie` values, API keys, OAuth 2.0 tokens and client secrets, Basic and Bearer credentials, secret
  variables and values given on the command line (`•••••`, for example `Bearer •••••`). The response view in the
  app shows the real response.
- **Uninstalling** does not delete the data folder. Delete it to remove everything.

## 3. Shared suites and imported files

A suite file from someone else is treated as untrusted:

- **Importing shows what the file does** before anything is added: every request that uploads a local file (with
  its path), every request with scripts, every request or folder that turns off TLS certificate checks, and
  Postman's `strictSSL: false`.
- **Local files are never uploaded without your approval.** Before a request reads a local file (multipart file
  field, binary body, `@file` in an imported cURL command) the app asks *"Allow upload of &lt;path&gt; to &lt;host&gt;?"*
  (*Allow once*, *Always for this suite*, *Cancel*). Files you pick with the app's own file chooser are approved. The
  request editor shows each local file path with its approval state. The command line version uploads only files in
  the suite's folder and paths given with `--allow-file`.
- **Scripts** (pre-request / post-response) run only when you send, never on import or open. They run in a separate
  worker thread with an isolated JavaScript context: no file system, network, `require`, `process` or code
  generation from strings, at most 5 seconds and a memory limit. A script can read and change variables (also secret
  ones) and the request, so review the scripts of suites from outside your team. Imported Postman scripts are
  added commented out.
- **Regular expressions** from suites (assertion *matches regex*, regex captures) are stopped after 500 ms, so a
  catastrophic pattern cannot hang the app.
- **TLS**: a suite can turn off certificate verification for a request or folder. Such requests show a warning,
  and run results note it. *Settings → Enforce TLS verification* ignores those settings (command line: `--strict-tls`
  or `API_TESTER_STRICT_TLS=1`).
- Files opened with the app (double-click, drag and drop, command line) can be imported, but never written,
  deleted or opened with another program. The window can only touch paths that you chose in a file dialog in this
  session, the app's own data and log folders, and files the app saved in this session.

## 4. Default settings and their risks

The defaults suit a developer's computer and test labs. Change these for stricter environments.

| Setting | Default | Risk | Stricter choice |
|---|---|---|---|
| Verify TLS (*Settings*) | On | – | Keep on |
| Enforce TLS verification (*Settings*) | Off | A shared suite, Postman collection or `curl -k` command can turn off certificate checks for its requests (a warning is shown) | On |
| Follow redirects | On | Requests follow redirects; credentials are not sent to another server | Off, if you test redirect handling yourself |
| Local echo server | Off; `127.0.0.1` | None while off. In Docker it listens on all interfaces of the container | Publish it as `-p 127.0.0.1:3999:3999` only |
| Proxy | Off (command line: `HTTPS_PROXY` / `HTTP_PROXY` when set) | Requests go through whatever proxy the environment names | Set the proxy explicitly |
| Secrets at rest | Encrypted where a keychain exists | Linux without a keyring: unencrypted (file readable by you only) | Use a desktop session with GNOME Keyring / KWallet |
| Developer tools | Off in installed builds | – | Keep off; `API_TESTER_DEVTOOLS=1` turns them on for troubleshooting |
| Scripts in suites | Run when you send | They can read and change your variables | Review scripts of shared suites (the import lists them) |

## 5. Hardening guide for organisations

1. **Install**: on Ubuntu / Debian prefer the `.deb`. It installs an AppArmor profile, so the Chromium sandbox stays
   on (see [9](#9-linux-chromium-sandbox)). No installer needs administrator rights except the `.deb`.
2. **Turn on** *Settings → Enforce TLS verification*. Keep *Verify TLS* on.
3. **Company root certificates** (TLS-inspecting proxies, internal CAs): the app trusts the root certificates built
   into Node.js (Mozilla's list) plus the PEM files you give it — desktop: *Settings → Trusted CA certificates*;
   command line: `--ca-file company-root.pem` or `API_TESTER_CA_FILE`. `NODE_EXTRA_CA_CERTS` also works: the
   hardened runtime itself ignores it (Electron fuse, see [8](#8-electron-hardening-and-fuses)), so the app reads
   that file explicitly. Nothing is downloaded and the operating system's certificate store is not changed.
   Do not turn off TLS verification instead.
4. **Shared suites**: read the import warnings. Use *Allow once* for uploads from suites you did not write.
5. **Secrets**: mark passwords, tokens and keys as *secret* (masked, encrypted at rest, not exported). In CI, pass
   them from the CI secret store as environment variables, not on the command line:
   `API_TESTER_VAR_token=… api-tester run suite.apisuite` or `--var-env token=API_TOKEN`.
   Values given with `--var` are visible in the process list and shell history.
6. **CI pipelines** (Docker image or the installed app's command line):
   - `--strict-tls`, and no `--insecure`;
   - `--allow-file <path>` only for the files the suite must upload;
   - mount the suite folder read-only and run as your user:
     `docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/tests:/work/tests:ro" -v "$PWD/reports:/work/reports" api-tester run tests/my-api.apisuite --strict-tls --out reports`;
   - treat reports as internal documents: secrets are masked, but they contain URLs, headers and bodies.
7. **Echo server**: leave it off unless needed. It answers only on this computer; in Docker publish it on
   `127.0.0.1` only. Other host names need `--allow-host <name>`.
8. **Network policy**: the app needs outbound access only to the APIs you test (and your proxy). Block everything
   else if you like; nothing in the app breaks.
9. **Application allow-listing**: until the builds are signed, allow them by file hash from `SHA256SUMS.txt`
   (Windows App Control / AppLocker hash rules, macOS Santa binary rules), after [verifying](#7-verifying-a-download)
   them. Note the RunAsNode fuse ([8](#8-electron-hardening-and-fuses)).
10. **Updates**: watch the repository's releases. Each release lists its security changes here.

## 6. Third-party components

- **Runtime**: Electron 45.0.0 with Chromium 156.0.8078.48 and Node.js 24.22.0. Electron updates bring Chromium and
  Node.js security fixes, so releases follow new Electron patch versions. Known at the time of 1.0.1: Node.js
  24.22.1 (2026-10-20) fixes TLS hostname-check and DNS issues, but no Electron release ships it yet. The review found
  them not reachable through API Tester's code: URLs are parsed by the WHATWG URL parser, connections are not
  reused and `dns.resolve` is not used. API Tester will move to the first Electron 45.0.x with Node.js 24.22.1.
- **npm packages in the app** (41, all with permissive licences: MIT, BSD, ISC, PSF): ajv, ajv-formats, form-data,
  http-proxy-agent, https-proxy-agent, js-yaml, jsonpath-plus and tough-cookie, plus their dependencies. None has an
  install script. `npm audit --omit=dev` reported no known vulnerabilities for 1.0.1.
- **SBOM**: every release has `API-Tester-<version>-sbom.cdx.json` (CycloneDX 1.6, made with
  `@cyclonedx/cyclonedx-npm` from the lockfile) with every npm package in the installers, and Electron, Chromium and
  Node.js as runtime components so scanners also see their CVEs. (`npm sbom` misses packages; do not use it for this.)
- **Licence notices**: `LICENSE.electron.txt` and `LICENSES.chromium.html` are in every installation (macOS: in
  `API Tester.app/Contents/Resources`).
- **How dependencies are kept current**: the lockfile pins every package with a SHA-512 hash; every push and pull
  request runs `npm audit --omit=dev --audit-level=high` and `npm audit signatures` (registry signatures and
  provenance); Dependabot proposes npm, GitHub Actions and Docker base image updates every week.
- **Build pipeline** (`.github/workflows/build.yml`): every action is pinned to a full commit SHA; the token is
  read-only except in the release job; checkouts do not store the token; `npm ci --ignore-scripts` in every job
  (the release build included) and no npm cache, so each build installs exactly what the lockfile pins straight
  from the registry and runs no package install scripts; the release publishes only the installers,
  the SBOM and `SHA256SUMS.txt` (never test reports or other artifacts) and attests their build provenance.
- **Docker image**: `node:22-bookworm-slim` pinned by digest; production dependencies only, installed with
  `npm ci --ignore-scripts`; npm, npx, corepack and yarn removed; runs as the unprivileged `node` user; no Electron.

## 7. Verifying a download

Each release has `SHA256SUMS.txt` and a build provenance attestation, which proves that a file was built by this
repository's GitHub Actions workflow from the tagged source.

```bash
# checksum (in the folder with the downloaded files)
sha256sum -c SHA256SUMS.txt --ignore-missing              # Linux
shasum -a 256 -c SHA256SUMS.txt --ignore-missing          # macOS
Get-FileHash .\API-Tester-Setup-1.0.1-x64.exe             # Windows PowerShell: compare with SHA256SUMS.txt

# build provenance (GitHub CLI)
gh attestation verify API-Tester-Setup-1.0.1-x64.exe --repo Manjuhombaradi/api-tester
```

**The installers are not code-signed yet** (no paid certificate): Windows has no Authenticode signature (SmartScreen
asks *"Windows protected your PC"*), and macOS builds are ad-hoc signed and not notarised (Gatekeeper asks once).
Check the file as above **before** you click *Run anyway* / *Open Anyway*. A file that fails the check is not ours.
On macOS, `codesign -dv "/Applications/API Tester.app"` shows `Signature=adhoc`: that is expected for these builds.
Signed and notarised builds are planned; until then, organisations can allow the verified files by hash.

## 8. Electron hardening and fuses

- The window runs with `contextIsolation`, `sandbox: true` and no Node.js integration; it loads only the app's own
  files, with a strict Content-Security-Policy (`default-src 'self'`, no inline scripts, `object-src 'none'`). It
  cannot navigate away, open windows or embed `<webview>`. The main process accepts messages only from the app's
  own page and checks every file path the page asks for (see [3](#3-shared-suites-and-imported-files)).
- **Developer tools** are not available in installed builds (no menu entry, no shortcut). For troubleshooting,
  start the app with the environment variable `API_TESTER_DEVTOOLS=1`.
- **Electron fuses** (switches compiled into the binary, set by `build.electronFuses` in `package.json`; CI checks
  them in every build with `scripts/check-fuses.js`):

| Fuse | Setting | Effect |
|---|---|---|
| `runAsNode` | **on** | Needed by the command line version: `bin/api-tester`, `api-tester.cmd` and the Linux launcher run `src/cli.js` with the app's built-in Node.js (`ELECTRON_RUN_AS_NODE=1`), so no browser engine starts in CI. Trade-off: anyone who can already run programs as the user can use the binary as a Node.js interpreter (with `--inspect` in that mode). If your application-control policy forbids that, allow the app for desktop use only and run suites with the Docker image or Node.js. |
| `enableNodeOptionsEnvironmentVariable` | off | `NODE_OPTIONS` cannot inject code or settings. (The app reads `NODE_EXTRA_CA_CERTS` itself, as a list of extra trusted root certificates only.) |
| `enableNodeCliInspectArguments` | off | `--inspect` and `SIGUSR1` cannot attach a debugger to the desktop app |
| `enableEmbeddedAsarIntegrityValidation` | on | macOS and Windows: the app refuses to start if `app.asar` was changed (on macOS this is as strong as the code signature, so it becomes meaningful with signed builds; Electron does not support it on Linux) |
| `onlyLoadAppFromAsar` | on | The app's code is loaded only from `app.asar`, not from a folder placed next to it |
| `enableCookieEncryption` | on | Chromium's cookie store is encrypted with the system keychain (the app's requests do not use it) |

On Linux, electron-builder would apply the fuses to the launcher script; `build/afterPack.js` applies them to the
real binary (`api-tester.bin`) instead.

## 9. Linux Chromium sandbox

On Linux the app starts through a small launcher script (`/opt/API Tester/api-tester`, the AppImage's or the
archive's `api-tester`). It keeps Chromium's OS-level sandbox **on** whenever the system can run it, and turns it off
only when it cannot work:

- the app runs as **root** (Chromium refuses to start sandboxed as root), or
- unprivileged **user namespaces** are not available (`unshare -Ur true` fails: containers, kernels with them
  disabled, and Ubuntu 23.10+ for programs without an AppArmor profile, i.e. the AppImage and `.tar.gz` there),
  and neither the `.deb`'s AppArmor profile nor a root-owned setuid `chrome-sandbox` applies, or
- you ask for it: `--no-sandbox` or `API_TESTER_DISABLE_SANDBOX=1` (for unusual container setups).

When it is off, the launcher prints one line to stderr (visible in a terminal or the system journal), for example
`API Tester: Chromium sandbox disabled (running as root).`, and passes the reason to the app in
`API_TESTER_SANDBOX_DISABLED`. Nothing is printed in the normal case. The app's own protections (context isolation,
`sandbox: true` for the page, no Node.js in the page, the CSP) apply either way; what is lost without the OS sandbox
is the containment of a compromised renderer process.

To keep the sandbox on: use the `.deb` on Ubuntu 23.10+ (its AppArmor profile allows user namespaces for this app
only), do not run the desktop app as root, and on other distributions keep unprivileged user namespaces enabled
(the default on Debian, Fedora and Ubuntu up to 23.04). The command line version never starts Chromium, so the
sandbox does not apply to it.

## 10. Running from source

`Start API Tester.command` / `.bat` / `start-api-tester.sh` and `npm install` download the dependencies from
`registry.npmjs.org` (versions and SHA-512 hashes fixed by `package-lock.json`). On the first start, the `electron`
package downloads the Electron binary from GitHub and checks it against the checksums shipped in the package. For a
reproducible install use `npm ci`. Sites without internet access should use the installers or the Docker image.

## 11. Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and click
**Report a vulnerability** (<https://github.com/Manjuhombaradi/api-tester/security/advisories/new>). Do not open a
public issue for a vulnerability.

If you cannot use GitHub, e-mail Manjunagouda Hombaradi at <manjuhombaradi@gmail.com> (please do not include real secrets or customer data).

Include the version (*About API Tester* in the menu, or `api-tester --version`), your operating system and the steps to reproduce,
ideally with a suite file that shows the problem (without real secrets). We aim to reply within a week and will
credit you in the advisory unless you prefer otherwise. Security fixes are made for the latest release.

## 12. Security changes in 1.0.1

From the 1.0.0 security review:

- Local file uploads need your approval; imported suites list local files, scripts and disabled TLS checks.
- Credentials are not sent to another server on redirects, and a request body is not re-sent to another server.
- Regular expressions from suites have a time limit.
- Reports, history and logs mask credentials and secret values, including command line variables.
- Secrets in `workspace.json` are encrypted with the system keychain; data files are `0600`, folders `0700`.
- New: *Settings → Enforce TLS verification*, `--strict-tls`; `API_TESTER_VAR_<name>`, `--var-env`, `--allow-file`.
- The echo server no longer starts automatically, rejects other host names (DNS rebinding) and sends CORS headers
  without credentials.
- No unrequested network traffic: Chromium's spell-check download and background services are off; web permissions
  are denied; developer tools are off in installed builds.
- The window's file access is limited to files you chose; the Content-Security-Policy is stricter.
- Electron fuses; the Linux sandbox stays on where possible; macOS installs include the Electron and Chromium licences.
- Releases: SHA256SUMS, build provenance, SBOM, installers only; pinned GitHub Actions with minimal permissions;
  dependency audit, signature check and Dependabot; Docker base image pinned by digest without npm / yarn.
