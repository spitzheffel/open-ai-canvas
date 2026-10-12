// Session helper + API smoke for the workbench. No npm deps (Node >= 22 fetch).
//   node .claude/skills/run-open-ai-canvas/api.mjs smoke    # auth + canvas write/read/delete, exit 1 on failure
//   node .claude/skills/run-open-ai-canvas/api.mjs cookie   # print "open_ai_canvas_session=..." for curl -b
// Talks to BASE_URL (default the Vite dev server, so /api goes through the same proxy as the browser).
// The local dev admin lives in CRED_FILE (default .local/dev-admin.txt, git-ignored). On an empty
// database the first registered account becomes admin, so ensureSession() registers it once.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
export const COOKIE = "open_ai_canvas_session";
const CRED_FILE = resolve(process.env.CRED_FILE || join(ROOT, ".local/dev-admin.txt"));

export async function api(method, path, { body, cookie } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (cookie) headers.Cookie = `${COOKIE}=${cookie}`;
    const res = await fetch(`${BASE}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        json = undefined;
    }
    const session = res.headers
        .getSetCookie()
        .map((line) => line.match(new RegExp(`^${COOKIE}=([^;]+)`))?.[1])
        .find(Boolean);
    return { status: res.status, json, text, session };
}

// HTTP 200 alone is not success: the envelope must carry code === 0.
const ok = (r) => r.status >= 200 && r.status < 300 && r.json?.code === 0;
const describe = (r) => `HTTP ${r.status} ${r.json ? `code=${r.json.code} reason=${r.json.reason ?? ""} msg=${r.json.msg ?? ""}` : r.text.slice(0, 200)}`;

function readCreds() {
    if (!existsSync(CRED_FILE)) return null;
    const pairs = readFileSync(CRED_FILE, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.includes("=") && !line.startsWith("#"))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]);
    const { username, password } = Object.fromEntries(pairs);
    return username && password ? { username, password } : null;
}

function writeCreds(creds) {
    mkdirSync(dirname(CRED_FILE), { recursive: true });
    writeFileSync(CRED_FILE, `# Local dev-only admin for this workbench database (git-ignored). Not a real credential.\nusername=${creds.username}\npassword=${creds.password}\n`, { mode: 0o600 });
}

/** Logs in as the local dev admin; registers it first when the database has no users. */
export async function ensureSession() {
    const settings = await api("GET", "/auth/settings");
    if (!ok(settings)) throw new Error(`GET /api/auth/settings failed: ${describe(settings)}`);
    let creds = readCreds();
    if (settings.json.data.firstUser) {
        creds ??= { username: "devadmin", password: `Dev-${randomBytes(9).toString("base64url")}` };
        const reg = await api("POST", "/auth/register", { body: { ...creds, acceptedTerms: true } });
        if (!ok(reg) || !reg.session) throw new Error(`register first admin failed: ${describe(reg)}`);
        writeCreds(creds);
        return { cookie: reg.session, user: reg.json.data.user, registered: true };
    }
    if (!creds) throw new Error(`${CRED_FILE} is missing and this database already has users. Set CRED_FILE to that database's admin credentials, or start the backend with an empty DATA_DIR.`);
    const login = await api("POST", "/auth/login", { body: creds });
    if (!ok(login) || !login.session) throw new Error(`login as ${creds.username} failed: ${describe(login)} - do the credentials in ${CRED_FILE} belong to this database?`);
    return { cookie: login.session, user: login.json.data.user, registered: false };
}

async function smoke() {
    let failures = 0;
    const check = (passed, name, detail = "") => {
        console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
        if (!passed) failures += 1;
        return passed;
    };
    const ready = await api("GET", "/health/ready");
    const schema = ready.json?.data?.schema;
    check(ok(ready) && ready.json.data.ready === true, `GET ${BASE}/api/health/ready`, ok(ready) ? `schema ${schema?.current}/${schema?.expected}` : describe(ready));

    const session = await ensureSession();
    check(true, session.registered ? "registered first admin" : "logged in", `${session.user.username} (${session.user.role})`);
    const me = await api("GET", "/auth/session", { cookie: session.cookie });
    check(ok(me) && me.json.data.user?.username === session.user.username, "GET /api/auth/session sees the cookie", ok(me) ? "" : describe(me));

    // The canvas has no create endpoint: the client picks the ID and the first operation must be create_canvas.
    const stamp = Date.now();
    const canvasId = `smoke-${stamp.toString(36)}`;
    const nodeId = `text-${stamp}-smoke`;
    const now = new Date(stamp).toISOString();
    const node = { id: nodeId, type: "text", title: "Smoke", position: { x: 0, y: 0 }, width: 340, height: 240, metadata: { content: "run-skill smoke", fontSize: 14, status: "idle" }, createdAt: now, updatedAt: now };
    const write = await api("PATCH", `/canvas-projects/${canvasId}/operations`, {
        cookie: session.cookie,
        body: { mutationId: randomUUID(), operations: [{ type: "create_canvas", id: canvasId, patch: { title: "run-skill smoke" } }, { type: "create_node", node }] },
    });
    check(ok(write), "PATCH /api/canvas-projects/:id/operations (create canvas + text node)", ok(write) ? `revision ${write.json.data.project?.revision}` : describe(write));
    const read = await api("GET", `/canvas-projects/${canvasId}`, { cookie: session.cookie });
    const saved = read.json?.data?.project?.nodes?.find((item) => item.id === nodeId);
    check(ok(read) && saved?.metadata?.content === "run-skill smoke", "GET /api/canvas-projects/:id returns the node", ok(read) ? "" : describe(read));
    const removed = await api("DELETE", `/canvas-projects/${canvasId}`, { cookie: session.cookie });
    check(ok(removed), "DELETE /api/canvas-projects/:id (cleanup)", ok(removed) ? "" : describe(removed));

    console.log(failures ? `SMOKE FAILED (${failures})` : "SMOKE OK");
    return failures ? 1 : 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (invokedPath === fileURLToPath(import.meta.url).toLowerCase()) {
    try {
        const command = process.argv[2];
        if (command === "smoke") process.exitCode = await smoke();
        else if (command === "cookie") console.log(`${COOKIE}=${(await ensureSession()).cookie}`);
        else {
            console.error("usage: node api.mjs smoke|cookie");
            process.exitCode = 2;
        }
    } catch (error) {
        console.error(`ERROR: ${error.message}`);
        process.exitCode = 1;
    }
}
