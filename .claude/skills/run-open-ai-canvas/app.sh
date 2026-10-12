#!/usr/bin/env bash
# Build, start, stop and smoke-test the workbench (Go backend + Vite web) from Git Bash on Windows.
#   bash .claude/skills/run-open-ai-canvas/app.sh setup|build|start|stop|restart|status|smoke
# Overrides: BACKEND_PORT (8080), WEB_PORT (3000), DATA_DIR (.local/project-workbench-debug),
# CRED_FILE (.local/dev-admin.txt). Logs: .local/run/{backend,web}-<port>.log
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
# Native Windows programs (go, the server, node) need D:/... paths, not Git Bash's /d/...
winpath() { (cd "$1" && pwd -W); }
ROOT_W="$(winpath "$ROOT")"
BACKEND_PORT="${BACKEND_PORT:-8080}"
WEB_PORT="${WEB_PORT:-3000}"
DATA_DIR="${DATA_DIR:-$ROOT/.local/project-workbench-debug}"
RUN_DIR="$ROOT/.local/run"
BIN="$ROOT_W/.local/bin/yingce-server.exe"
export GOCACHE="$ROOT_W/.local/cache/go-build" GOMODCACHE="$ROOT_W/.local/cache/go-mod"
export BASE_URL="http://127.0.0.1:$WEB_PORT"

die() { echo "ERROR: $*" >&2; exit 1; }

# Windows PID of the process listening on TCP port $1 (IPv4 or IPv6); empty when free.
listener_pid() {
    netstat -ano | awk -v p=":$1" '$1 == "TCP" && $4 == "LISTENING" && substr($2, length($2) - length(p) + 1) == p { print $5; exit }'
}

# Lower-cased command line with forward slashes, so it can be matched against ROOT_W.
proc_cmdline() {
    powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=$1').CommandLine" 2>/dev/null | tr -d '\r' | tr '\\' '/' | tr '[:upper:]' '[:lower:]'
}

wait_ready() { # msys-pid url label log timeout-seconds
    local deadline=$((SECONDS + $5))
    until curl -sf -m 3 -o /dev/null "$2"; do
        kill -0 "$1" 2>/dev/null || { tail -n 40 "$4" >&2; die "$3 exited during startup (log: $4)"; }
        [ "$SECONDS" -lt "$deadline" ] || { tail -n 40 "$4" >&2; die "$3 not ready after $5s: $2 (log: $4)"; }
        sleep 1
    done
}

cmd_build() {
    command -v gcc >/dev/null || die "gcc not found: the SQLite driver needs CGO (any MinGW-w64 gcc on PATH)"
    (cd "$ROOT/backend" && go build -o "$BIN" ./cmd/server)
    echo "built $BIN"
}

cmd_setup() {
    for tool in go bun node npm curl; do command -v "$tool" >/dev/null || die "$tool not found on PATH"; done
    mkdir -p "$ROOT/.local/project-workbench-debug" "$ROOT/.local/cache/go-build" "$ROOT/.local/cache/go-mod" "$ROOT/.local/bin" "$RUN_DIR"
    (cd "$ROOT/web" && bun install --frozen-lockfile)
    if [ ! -d "$ROOT/backend/agent-runtime/pi/node_modules" ]; then
        (cd "$ROOT/backend/agent-runtime/pi" && npm ci --no-audit --no-fund)
    fi
    cmd_build
}

cmd_start() {
    [ -d "$DATA_DIR" ] || die "DATA_DIR $DATA_DIR does not exist (run setup, or mkdir it yourself for an isolated instance)"
    local port pid
    for port in "$BACKEND_PORT" "$WEB_PORT"; do
        pid="$(listener_pid "$port")"
        [ -z "$pid" ] || die "port $port is in use by PID $pid ($(proc_cmdline "$pid")). Run stop/restart if it is ours, or set BACKEND_PORT/WEB_PORT."
    done
    cmd_build
    mkdir -p "$RUN_DIR"
    local data_w backend_log web_log
    data_w="$(winpath "$DATA_DIR")"
    backend_log="$RUN_DIR/backend-$BACKEND_PORT.log"
    web_log="$RUN_DIR/web-$WEB_PORT.log"
    # nohup + redirected stdio: the servers keep running after this script (and the calling shell) exits.
    (cd "$ROOT/backend" && CANVAS_BACKEND_ADDR="127.0.0.1:$BACKEND_PORT" CANVAS_BACKEND_DATA_DIR="$data_w" exec nohup "$BIN" >"$backend_log" 2>&1 </dev/null) &
    wait_ready $! "http://127.0.0.1:$BACKEND_PORT/api/health/ready" backend "$backend_log" 120
    (cd "$ROOT/web" && VITE_API_PROXY_TARGET="http://127.0.0.1:$BACKEND_PORT" exec nohup bun run vite --host 127.0.0.1 --port "$WEB_PORT" --strictPort >"$web_log" 2>&1 </dev/null) &
    wait_ready $! "$BASE_URL/" web "$web_log" 120
    echo "READY web=$BASE_URL backend=http://127.0.0.1:$BACKEND_PORT data=$data_w"
    echo "logs: $backend_log $web_log"
}

stop_port() { # port cmdline-fragment label
    local pid cmdline
    pid="$(listener_pid "$1")"
    [ -n "$pid" ] || { echo "$3: nothing listening on $1"; return 0; }
    cmdline="$(proc_cmdline "$pid")"
    case "$cmdline" in
        *"$2"*) taskkill //PID "$pid" //T //F >/dev/null ;;
        *) die "$3: port $1 is held by PID $pid, which is not this checkout's $3: $cmdline" ;;
    esac
    local deadline=$((SECONDS + 15))
    while [ -n "$(listener_pid "$1")" ]; do
        [ "$SECONDS" -lt "$deadline" ] || die "$3: port $1 still busy after killing PID $pid"
        sleep 0.5
    done
    echo "$3: stopped PID $pid (port $1)"
}

cmd_stop() {
    local root_lc
    root_lc="$(echo "$ROOT_W" | tr '[:upper:]' '[:lower:]')"
    stop_port "$WEB_PORT" "$root_lc/web/node_modules/vite" web
    stop_port "$BACKEND_PORT" "$root_lc/.local/bin/yingce-server" backend
}

cmd_status() {
    local spec label port pid
    for spec in "backend:$BACKEND_PORT" "web:$WEB_PORT"; do
        label="${spec%%:*}"
        port="${spec##*:}"
        pid="$(listener_pid "$port")"
        if [ -n "$pid" ]; then echo "$label: port $port PID $pid $(proc_cmdline "$pid")"; else echo "$label: port $port not listening"; fi
    done
    curl -s -m 3 "http://127.0.0.1:$BACKEND_PORT/api/health/ready" || echo "backend health: unreachable"
    echo
}

case "${1:-}" in
    setup) cmd_setup ;;
    build) cmd_build ;;
    start) cmd_start ;;
    stop) cmd_stop ;;
    restart) cmd_stop && cmd_start ;;
    status) cmd_status ;;
    smoke) node "$HERE/api.mjs" smoke ;;
    *) die "usage: $0 setup|build|start|stop|restart|status|smoke" ;;
esac
