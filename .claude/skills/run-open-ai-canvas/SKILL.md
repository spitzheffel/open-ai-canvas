---
name: run-open-ai-canvas
description: Build, start, stop, smoke-test and drive the 影策 / open-ai-canvas workbench (Go backend + Vite web) on this Windows + Git Bash dev box. Use when asked to run, start, restart or stop the app (跑起来/启动/重启), log in, take a screenshot of a page (截图), click through the UI, verify a frontend or backend change in the real running app (联调/冒烟), call an authenticated API with curl, or run the backend/web tests.
---

The workbench is two processes: the Go backend on `127.0.0.1:8080` (SQLite in `.local/project-workbench-debug`) and the Vite dev server on `127.0.0.1:3000`, which proxies `/api` to the backend. Drive it with two scripts in this directory:

- `app.sh` handles setup, build, start, stop, status and the API smoke test.
- `driver.mjs` is a headless Chrome REPL driven over CDP, with commands piped on stdin and screenshots saved to disk.

Paths are relative to the repo root. Everything here was run on Windows 11 in Git Bash (the Bash tool). Nothing was tried on Linux or macOS: `app.sh` uses `netstat`, `taskkill` and `pwd -W`.

## Prerequisites

These must be on PATH: Go 1.25, Bun, Node ≥ 22 (with npm), curl, and **gcc** (the SQLite driver needs CGO). The driver also needs Chrome or Edge at the standard install path; otherwise set `CHROME_BIN`.

```bash
go version && bun --version && node --version && gcc --version | head -1
```

Verified with go1.25.6, bun 1.3.13, node v24.14.0 and gcc 13.2.0 (MinGW-w64 from Strawberry Perl). Any `bun` on PATH works, including a copy bundled with another tool.

## Setup (once per clone; safe to repeat)

```bash
bash .claude/skills/run-open-ai-canvas/app.sh setup
```

This does four things:
- creates `.local/{project-workbench-debug,cache/go-build,cache/go-mod,bin,run}`
- runs `bun install --frozen-lockfile` in `web/`
- runs `npm ci` in `backend/agent-runtime/pi`, only if its `node_modules` is missing; this is the Agent's Node runtime, which the backend spawns on demand
- builds `.local/bin/yingce-server.exe`

The first run takes about 5 minutes: roughly 770 MB of Go modules come from goproxy.cn into `.local/cache/go-mod`, then SQLite is compiled with CGO. `bun install` takes about 70 s cold. After that, setup takes seconds. Everything it writes is ignored by Git.

## Run (agent path)

### Start, check, stop

```bash
bash .claude/skills/run-open-ai-canvas/app.sh start
bash .claude/skills/run-open-ai-canvas/app.sh status
bash .claude/skills/run-open-ai-canvas/app.sh stop
```

`start` refuses to run if 8080 or 3000 is busy. Otherwise it rebuilds the backend (about 1 s when nothing changed), starts both servers detached with `nohup`, waits for `/api/health/ready` and the web root, and prints `READY web=http://127.0.0.1:3000 ...`. The servers keep running after the Bash call returns. Logs are in `.local/run/backend-8080.log` and `.local/run/web-3000.log`.

Web changes hot-reload. After backend changes, run `app.sh restart`.

### API smoke: auth, then a canvas write/read/delete through the Vite proxy

```bash
bash .claude/skills/run-open-ai-canvas/app.sh smoke
```

Expected output:

```
PASS  GET http://127.0.0.1:3000/api/health/ready - schema 50/50
PASS  logged in - devadmin (admin)
PASS  GET /api/auth/session sees the cookie
PASS  PATCH /api/canvas-projects/:id/operations (create canvas + text node) - revision 1
PASS  GET /api/canvas-projects/:id returns the node
PASS  DELETE /api/canvas-projects/:id (cleanup)
SMOKE OK
```

On an empty database the second line reads `registered first admin`. The first account becomes admin, so the script registers `devadmin` with a random password and writes it to `.local/dev-admin.txt`. Every later run, and the driver's `login`, logs in with that file. Don't paste that password into chat or commits.

### Authenticated curl, for backend changes

```bash
curl -s -b "$(node .claude/skills/run-open-ai-canvas/api.mjs cookie)" http://127.0.0.1:3000/api/canvas-projects
```

`api.mjs cookie` logs in and prints `open_ai_canvas_session=...`. A successful response is `{"code":0,"data":...}`. HTTP 200 alone is not success; check that `code` is 0.

### Drive the UI: headless Chrome via `driver.mjs`

```bash
node .claude/skills/run-open-ai-canvas/driver.mjs <<'EOF'
login
nav /canvas
wait-for text=我的画布
screenshot canvas-list
click text=新建画布
wait-for url=/canvas/
wait-for text=让灵感
click text=新建文本
wait-for text=双击编辑文字
screenshot canvas-text-node
errors
EOF
```

Each command prints `ok  <cmd> -> <result>`. The first failure prints `ERR`, saves `.local/run/shots/FAIL.png`, and exits 1. Screenshots go to `.local/run/shots/<name>.png`; open them with Read and actually look at them. The run above ends on the canvas editor with a "Note" text node and its toolbar (文本生成 / 放大编辑 / 生图 / 文本调整).

| command | what it does |
|---|---|
| `login` | API login as the dev admin (registers it on an empty DB), then injects the session cookie |
| `nav <path or url>` | navigate (paths are relative to `BASE_URL`) and wait for `document.readyState === "complete"` |
| `wait-for <selector>` / `wait-for url=<substr>` | poll until present (30 s; `STEP_TIMEOUT_MS`) |
| `wait-gone <selector>` | poll until absent |
| `wait <ms>` | fixed pause, e.g. to let images load before a screenshot |
| `click <selector>` | real mouse press/release at the element's center; warns if another element covers that point |
| `fill <selector> => <value>` | click, Ctrl+A, insert text (works on React-controlled inputs) |
| `type <text>` / `press <Key>` | insert text at the focus / key press: `Enter`, `Escape`, `Tab`, arrows, `Control+z`, … |
| `screenshot [name]` | PNG of the viewport → `.local/run/shots/` |
| `text [selector]` | print `innerText` of the page or of the element |
| `eval <js>` | evaluate in the page and print JSON |
| `url` / `errors` | current URL / console errors, exceptions and HTTP ≥ 400 since the last `errors` |
| `viewport <w>x<h>` | resize (width < 768 also sets the mobile flag) |
| `theme dark` / `theme light` | sets the app's own theme keys and reloads (see Gotchas) |

Selectors:
- `text=<visible text>` is the default form. Exact matches win, then the innermost element; `aria-label` and `title` are matched too.
- `css=<selector>` matches with a CSS selector.
- `placeholder=<input placeholder>` matches inputs by placeholder.

Environment variables:
- `BASE_URL` (default `http://127.0.0.1:3000`)
- `CRED_FILE`
- `SHOT_DIR`
- `CHROME_BIN`
- `STEP_TIMEOUT_MS`

### Isolated instance: fresh database, other ports (run as ONE Bash call, since exports don't persist)

Use this for first-run or registration flows, or anything destructive. It leaves the dev database alone.

```bash
mkdir -p .local/run-skill-verify/data
export BACKEND_PORT=18080 WEB_PORT=13000 DATA_DIR=.local/run-skill-verify/data CRED_FILE=.local/run-skill-verify/dev-admin.txt
bash .claude/skills/run-open-ai-canvas/app.sh start
bash .claude/skills/run-open-ai-canvas/app.sh smoke
BASE_URL=http://127.0.0.1:13000 node .claude/skills/run-open-ai-canvas/driver.mjs <<'EOF'
login
nav /
theme dark
viewport 390x844
wait-for text=和影策聊聊创作想法
wait 1500
screenshot home-dark-mobile
EOF
bash .claude/skills/run-open-ai-canvas/app.sh stop
rm -rf .local/run-skill-verify .local/run/backend-18080.log .local/run/web-13000.log
```

## Run (human path)

After `app.sh start`, open http://127.0.0.1:3000 and log in with the account in `.local/dev-admin.txt`. `scripts/start-local.ps1` is the repo's two-window PowerShell launcher; it wasn't used here.

## Test

```bash
(cd backend && GOCACHE="$(cd .. && pwd -W)/.local/cache/go-build" GOMODCACHE="$(cd .. && pwd -W)/.local/cache/go-mod" go test ./...)
(cd web && bun test)
```

**Neither suite is fully green on this Windows checkout, even before any change (`develop` at ef6cd59c).** Compare your run against this baseline:

- **`go test ./...`** takes about 4.5 min cold, and passing packages are cached after that. 28 packages pass. 5 tests fail, and all of them are Windows-only test assumptions:
  - `internal/app`: `TestSettingsEncryptionKeyPublication`, `TestSettingsEncryptionKeyLinkFallback` and `TestSettingsEncryptionKeyConcurrentFirstUse` assert POSIX `0600` permissions.
  - `internal/hostupdate`: `TestSetEnvValuePreservesOtherSettings` fails with `mode=666, want 640`.
  - `internal/repository`: `TestGmailMailboxRegistrationConcurrent` can't delete its temp dir because the SQLite file is still open.
  - **Flaky under full-suite load:** a `TestCloudAgentMedia*` test occasionally fails with "数据已被更新，请刷新后重试". Re-run it alone: `go test ./internal/app/ -run '^<name>$' -count=10` passed 10/10.
  - **On `main`/upstream there are 39 failures.** Without ef6cd59c, the extra ones fail with `sync C:\…: Access is denied.` (see Gotchas).
- **`bun test`** takes 25–40 s: 2,211 tests in 305 files, 2,189 pass and 22 fail. The causes:
  - **CRLF checkout.** This clone has `core.autocrlf=true`, and tests such as `test/canvas-keyboard.test.ts` expect `\n`.
  - **Windows path separators** in source-scanning tests. `test/http-ownership.test.ts` compares `relative()` output, which uses backslashes here, against `services/api/request.ts`.
  - **One genuine failure on main.** In `test/admin-ui-regressions.test.ts`, "channel model fetch requires explicit selection before import" expects `allFetchModelsSelected`, which commit #743 removed.
- To check a change, run just the files you touched, e.g. `bun test test/<file>.test.ts` inside `web/`, then compare the failure list with the one above.

## Gotchas

- **Don't start these servers with the desktop app's `preview_start`.** It reported "Port 8080/3000 is in use by another process" while `netstat` showed no listener and `node` could bind both ports on every address. Use `app.sh start`.
- **The built-in browser pane refuses `http://localhost:3000`** ("navigation denied or failed"). `http://127.0.0.1:3000` works. `app.sh` binds Vite to 127.0.0.1, whereas the repo's `bun run dev` uses `0.0.0.0`; this avoids a Windows Firewall prompt and keeps the app off the LAN.
- **`$!` doesn't point at the server.** It's a `bash.exe` stub. `stop` finds the PID by port with `netstat`, checks that the command line belongs to *this checkout* (`.local/bin/yingce-server` or `web/node_modules/vite`), then runs `taskkill //T //F`. It refuses to kill another project's server on the same port.
- **The app ignores `prefers-color-scheme`.** The workspace theme is localStorage `yingce:theme_store` (default light). The canvas editor has its own key, `yingce:canvas-theme`, and was dark in every run. So an editor screenshot can be dark while the rest of the app is light. Use the driver's `theme` command, not CSS media emulation.
- **Some text is split across text nodes.** `<h1>和{brandName}聊聊创作想法</h1>` renders three text nodes. `text=` falls back to matching an element's whole `textContent`, so this works, but prefer distinctive strings.
- **`nav` and `theme` return when the document has loaded, not when the app has rendered.** A `screenshot` straight after `theme dark` (which reloads) was blank apart from the top bar. Always `wait-for` the element you need before `screenshot`.
- **`wait-for` returns as soon as the text exists, not when images load.** The home carousel showed empty dark cards. Put `wait 1500` before screenshots that depend on media.
- **Expected console noise.**
  - `errors` shows antd deprecation warnings on most pages: Drawer `width` and Modal `destroyOnClose`, plus InputNumber `addonAfter`/`addonBefore` in the 预演台.
  - When media is written back, each asset upload starts with a `GET /api/assets/<id>` 404 probe, followed by a PUT that returns 200.
  - Treat anything else as new.
- **Driver flows write to whatever database is running.** `click text=新建画布` creates a real canvas in the dev DB. Only the API smoke cleans up after itself. Use the isolated instance for throwaway flows.
- **A fresh database has no model channels**, so image, video, text and Agent generation can't run until an admin configures channels and API keys. The UI renders without them; generation wasn't exercised here.
- **On `main`/upstream, a Windows-hosted backend fails the first request per data dir that needs `.settings-key`.** That means the first resource-file fetch or the first secret save returns 500 "系统处理失败，请稍后重试"; a retry succeeds. The cause is that `publishSettingsKey` fsyncs the data directory, which Windows refuses. Commit ef6cd59c on `develop` skips that fsync on Windows; it was verified on a fresh data dir. Keep that commit when merging upstream.
- **预演台 (3D previs) flows.** Picking a template (`click text=单人对白`) only creates the canvas node. Open the workbench with `click text=打开 3D 预演台`, the title of the card thumbnail. "生成白膜" records the 3D view in real time and then transcodes it, so raise `STEP_TIMEOUT_MS` (300000 worked). After `click text=生成白膜`, use `wait-for text=正在录制白膜视频…` then `wait-gone text=正在录制白膜视频…`, and read `text css=.pv-output-status`; it shows `✓ 白膜视频已生成` on success.
- **The canvas has no "create" endpoint.** The client picks the ID and sends `PATCH /api/canvas-projects/:id/operations` with a first operation of `{type:"create_canvas"}`. See `api.mjs` for a working payload.

## Troubleshooting

- **`ERR wait-for text=… timed out`**: open `.local/run/shots/FAIL.png` first. In one run the search had actually worked and the page showed "没有匹配的画布"; that database simply had no canvases.
- **`ERROR: port 8080 is in use by PID …`**: run `app.sh restart` if it's this checkout's server (the message prints the command line). Otherwise set `BACKEND_PORT`/`WEB_PORT`.
- **`Error: EPIPE: broken pipe` from `api.mjs`**: the output was piped into `head`, which closed early. Don't truncate the smoke output.
