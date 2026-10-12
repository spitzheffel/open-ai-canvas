// Headless Chrome/Edge REPL for the workbench, driven over CDP with no npm deps (same
// approach as web/scripts/previs-p0-chrome-e2e.mjs). Reads one command per line from
// stdin; the first failing command saves FAIL.png and exits 1. Commands: see SKILL.md.
//   node .claude/skills/run-open-ai-canvas/driver.mjs <<'EOF'
//   login
//   nav /canvas
//   wait-for text=我的画布
//   screenshot canvas-list
//   EOF
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { BASE, COOKIE, ROOT, ensureSession } from "./api.mjs";

const SHOT_DIR = resolve(process.env.SHOT_DIR || join(ROOT, ".local/run/shots"));
const STEP_TIMEOUT = Number(process.env.STEP_TIMEOUT_MS || 30000);
const CHROME_CANDIDATES = [
    process.env.CHROME_BIN,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
    return new Promise((resolvePort, reject) => {
        const server = createServer();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close(() => resolvePort(port));
        });
    });
}

async function launchBrowser() {
    const binary = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
    if (!binary) throw new Error(`No Chrome/Edge found. Set CHROME_BIN. Tried:\n  ${CHROME_CANDIDATES.join("\n  ")}`);
    const port = await freePort();
    const profile = mkdtempSync(join(tmpdir(), "yingce-driver-"));
    const args = [
        "--headless=new",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1440,1000",
        // Keep WebGL (previs / live2d) working headless via software rendering.
        "--enable-unsafe-swiftshader",
        "--use-angle=swiftshader",
    ];
    if (process.platform === "linux") args.push("--no-sandbox", "--disable-dev-shm-usage");
    args.push("about:blank");
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let log = "";
    child.stderr.on("data", (chunk) => (log += chunk));
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`browser exited early (${child.exitCode}):\n${log}`);
        try {
            const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            const page = targets.find((target) => target.type === "page");
            if (page) return { child, profile, binary, wsUrl: page.webSocketDebuggerUrl };
        } catch {
            // CDP not up yet
        }
        await sleep(300);
    }
    throw new Error(`browser CDP not ready within 60s:\n${log}`);
}

async function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolveOpen, reject) => {
        ws.addEventListener("open", resolveOpen, { once: true });
        ws.addEventListener("error", () => reject(new Error("CDP websocket error")), { once: true });
    });
    const pending = new Map();
    const problems = [];
    let nextId = 0;
    ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolveCall, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(`CDP ${JSON.stringify(msg.error)}`));
            else resolveCall(msg.result);
            return;
        }
        const p = msg.params;
        if (msg.method === "Runtime.exceptionThrown") problems.push(`exception: ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text}`);
        else if (msg.method === "Runtime.consoleAPICalled" && p.type === "error") problems.push(`console.error: ${(p.args || []).map((a) => a.value ?? a.description ?? "").join(" ")}`);
        else if (msg.method === "Network.responseReceived" && p.response.status >= 400) problems.push(`HTTP ${p.response.status} ${p.response.url}`);
        else if (msg.method === "Network.loadingFailed" && !p.canceled) problems.push(`network: ${p.errorText} (${p.type})`);
    });
    const send = (method, params = {}) =>
        new Promise((resolveCall, reject) => {
            const id = ++nextId;
            pending.set(id, { resolveCall, reject });
            ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => pending.delete(id) && reject(new Error(`CDP timeout: ${method}`)), 60000);
        });
    for (const domain of ["Runtime", "Page", "Network"]) await send(`${domain}.enable`);
    return { ws, send, problems };
}

// Selector forms: text=<visible text> (default), css=<selector>, placeholder=<input placeholder>.
function parseSelector(raw) {
    const match = raw.match(/^(text|css|placeholder)=(.*)$/s);
    return match ? { kind: match[1], value: match[2] } : { kind: "text", value: raw };
}

// Runs in the page. Returns the best visible match (exact text first, then innermost) or null.
const FIND = `(sel, scroll, wantText) => {
    const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        const s = getComputedStyle(el);
        return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0;
    };
    const pick = (list) => list.find(visible);
    let el = null;
    if (sel.kind === "css") el = pick([...document.querySelectorAll(sel.value)]);
    else if (sel.kind === "placeholder") el = pick([...document.querySelectorAll("input,textarea,[contenteditable]")].filter((node) => (node.getAttribute("placeholder") || node.getAttribute("data-placeholder") || "").includes(sel.value)));
    else {
        const exact = (node) => (node.textContent || "").trim() === sel.value || node.getAttribute("aria-label") === sel.value || node.getAttribute("title") === sel.value;
        const exactFirst = (list) => list.sort((a, b) => Number(exact(b)) - Number(exact(a)));
        const direct = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.includes(sel.value) && n.parentElement) direct.push(n.parentElement);
        for (const node of document.querySelectorAll("[aria-label],[title]")) if ((node.getAttribute("aria-label") || node.getAttribute("title") || "").includes(sel.value)) direct.push(node);
        el = pick(exactFirst(direct));
        if (!el) {
            // JSX such as <h1>和{brandName}聊聊创作想法</h1> renders adjacent text nodes that no single
            // node contains, so fall back to the innermost element whose textContent matches.
            const norm = (s) => (s || "").replace(/\\s+/g, " ");
            const nested = [...document.body.querySelectorAll("*")].filter((node) => norm(node.textContent).includes(sel.value) && ![...node.children].some((child) => norm(child.textContent).includes(sel.value)));
            el = pick(exactFirst(nested));
        }
    }
    if (!el) return null;
    if (scroll) el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const covered = hit && hit !== el && !el.contains(hit) && !hit.contains(el) ? hit.tagName.toLowerCase() + (hit.className && typeof hit.className === "string" ? "." + hit.className.trim().split(/\\s+/).slice(0, 2).join(".") : "") : "";
    return { x, y, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 60), covered, inner: wantText ? el.innerText || el.value || "" : undefined };
}`;

const KEY_CODES = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32 };
const MODIFIERS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 };

async function main() {
    const { child, profile, binary, wsUrl } = await launchBrowser();
    const { ws, send, problems } = await connect(wsUrl);
    let shotCount = 0;
    const evaluate = async (expression) => {
        const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
        return r.result.value;
    };
    const find = (raw, scroll, wantText = false) => evaluate(`(${FIND})(${JSON.stringify(parseSelector(raw))}, ${scroll}, ${wantText})`);
    const poll = async (label, check, timeout = STEP_TIMEOUT) => {
        const deadline = Date.now() + timeout;
        for (;;) {
            const value = await check().catch(() => null);
            if (value) return value;
            if (Date.now() > deadline) throw new Error(`timed out after ${timeout}ms waiting for ${label}`);
            await sleep(250);
        }
    };
    const screenshot = async (name) => {
        mkdirSync(SHOT_DIR, { recursive: true });
        const { data } = await send("Page.captureScreenshot", { format: "png" });
        const file = join(SHOT_DIR, `${(name || `shot-${++shotCount}`).replace(/[^\w.-]+/g, "_")}.png`);
        writeFileSync(file, Buffer.from(data, "base64"));
        return file;
    };
    const mouse = async (type, x, y) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    const pressKey = async (combo) => {
        const parts = combo.split("+");
        const key = parts.pop();
        const modifiers = parts.reduce((mask, part) => mask | (MODIFIERS[part] ?? 0), 0);
        const single = key.length === 1;
        const keyCode = KEY_CODES[key] ?? (single ? key.toUpperCase().charCodeAt(0) : 0);
        const code = single ? (/\d/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`) : key;
        const text = key === "Enter" ? "\r" : key === "Space" ? " " : single && !(modifiers & 6) ? key : undefined;
        const base = { key: key === "Space" ? " " : key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
        await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, text });
        await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    };

    const commands = {
        async login() {
            const session = await ensureSession();
            const { success } = await send("Network.setCookie", { name: COOKIE, value: session.cookie, url: BASE, path: "/", httpOnly: true, sameSite: "Lax" });
            if (!success) throw new Error("Network.setCookie rejected the session cookie");
            return `${session.registered ? "registered + " : ""}logged in as ${session.user.username} (${session.user.role})`;
        },
        async nav(target) {
            const url = /^https?:\/\//.test(target) ? target : `${BASE}${target.startsWith("/") ? "" : "/"}${target}`;
            const r = await send("Page.navigate", { url });
            if (r.errorText) throw new Error(`navigate ${url}: ${r.errorText}`);
            await poll("document load", () => evaluate(`document.readyState === "complete"`));
            return url;
        },
        async "wait-for"(arg) {
            if (arg.startsWith("url=")) return poll(arg, () => evaluate(`location.href.includes(${JSON.stringify(arg.slice(4))}) && location.href`));
            const hit = await poll(arg, () => find(arg, false));
            return `${hit.tag} "${hit.text}"`;
        },
        async "wait-gone"(arg) {
            await poll(`${arg} to disappear`, async () => !(await find(arg, false)));
            return "gone";
        },
        async wait(ms) {
            await sleep(Number(ms) || 1000);
            return `${Number(ms) || 1000}ms`;
        },
        async click(arg) {
            const hit = await poll(arg, () => find(arg, true));
            await mouse("mouseMoved", hit.x, hit.y);
            await mouse("mousePressed", hit.x, hit.y);
            await mouse("mouseReleased", hit.x, hit.y);
            return `${hit.tag} "${hit.text}" at ${Math.round(hit.x)},${Math.round(hit.y)}${hit.covered ? ` (WARNING: covered by ${hit.covered})` : ""}`;
        },
        async fill(arg) {
            // Selectors may contain spaces (placeholders such as "3-32 位字符"), so the value follows " => ".
            if (!arg.includes(" => ")) throw new Error("usage: fill <selector> => <value>");
            const [raw, value] = [arg.slice(0, arg.indexOf(" => ")), arg.slice(arg.indexOf(" => ") + 4)];
            const hit = await poll(raw, () => find(raw, true));
            await mouse("mousePressed", hit.x, hit.y);
            await mouse("mouseReleased", hit.x, hit.y);
            await pressKey("Control+a");
            await send("Input.insertText", { text: value });
            return `${hit.tag} <- ${JSON.stringify(value)}`;
        },
        async type(text) {
            await send("Input.insertText", { text });
            return JSON.stringify(text);
        },
        async press(combo) {
            await pressKey(combo);
            return combo;
        },
        async screenshot(name) {
            return screenshot(name);
        },
        async text(arg) {
            const body = arg ? (await poll(arg, () => find(arg, false, true))).inner : await evaluate("document.body.innerText");
            return `\n${String(body ?? "").slice(0, 4000)}`;
        },
        async eval(expression) {
            return JSON.stringify(await evaluate(expression));
        },
        async url() {
            return evaluate("location.href");
        },
        async errors() {
            const lines = problems.splice(0);
            return lines.length ? `${lines.length} problem(s):\n  ${lines.join("\n  ")}` : "none";
        },
        async viewport(arg) {
            const [width, height] = arg.split("x").map(Number);
            await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 768 });
            return `${width}x${height}`;
        },
        async theme(value) {
            if (value !== "dark" && value !== "light") throw new Error("usage: theme dark|light");
            // The app ignores prefers-color-scheme: the workspace and the canvas editor each persist their own theme.
            const href = await evaluate(`(() => {
                if (!location.protocol.startsWith("http")) throw new Error("nav to the app before theme");
                for (const key of ["yingce:theme_store", "yingce:canvas-theme"]) localStorage.setItem(key, JSON.stringify({ state: { theme: ${JSON.stringify(value)} }, version: 0 }));
                return location.href;
            })()`);
            await commands.nav(href);
            return `${value} (reloaded ${href})`;
        },
    };

    await commands.viewport("1440x900");
    console.log(`driver ready: ${binary} -> ${BASE} (screenshots: ${SHOT_DIR})`);
    let exitCode = 0;
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        if (line === "quit") break;
        const space = line.indexOf(" ");
        const name = space < 0 ? line : line.slice(0, space);
        const arg = space < 0 ? "" : line.slice(space + 1).trim();
        const command = commands[name];
        try {
            if (!command) throw new Error(`unknown command "${name}" (known: ${Object.keys(commands).join(", ")}, quit)`);
            console.log(`ok  ${line} -> ${await command(arg)}`);
        } catch (error) {
            console.log(`ERR ${line} -> ${error.message}`);
            console.log(`    failure screenshot: ${await screenshot("FAIL").catch(() => "unavailable")}`);
            exitCode = 1;
            break;
        }
    }
    rl.close();
    await send("Browser.close").catch(() => {});
    ws.close();
    for (let i = 0; i < 20 && child.exitCode === null; i++) await sleep(250);
    if (child.exitCode === null) child.kill();
    for (let i = 0; i < 10; i++) {
        try {
            rmSync(profile, { recursive: true, force: true });
            break;
        } catch {
            await sleep(300); // Windows keeps the profile locked briefly after exit
        }
    }
    process.exit(exitCode);
}

main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
});
