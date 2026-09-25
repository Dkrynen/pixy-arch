#!/usr/bin/env bash
# Pixy Arch launcher: make sure the backend is up, then open the control deck
# in its own app window.
#
# The backend is started through the systemd user service when it is
# installed (tools/install-service.sh), otherwise in the background via
# tools/run-pixypilot.sh. The window uses a Chromium-family browser in app
# mode when one is installed (override with PIXY_ARCH_BROWSER=<command>), and
# the default browser otherwise.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_PYTHON="$ROOT/backend/.venv/bin/python"
SERVICE="pixypilot.service"
APP_CLASS="pixy-arch"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/pixy-arch"

port=8000
if [ -x "$VENV_PYTHON" ]; then
    port="$(cd "$ROOT" && "$VENV_PYTHON" -c 'from pixypilot.config import backend_port; print(backend_port())' 2>/dev/null || echo 8000)"
fi
URL="http://127.0.0.1:${port}"
HEALTH="${URL}/health"

notify() {
    if command -v notify-send >/dev/null 2>&1; then
        notify-send "Pixy Arch" "$1"
    fi
    printf 'pixy-arch: %s\n' "$1" >&2
}

is_healthy() { curl -sf --max-time 2 "$HEALTH" >/dev/null 2>&1; }

wait_healthy() {
    # The first run installs dependencies and builds the UI, so allow minutes.
    local seconds="$1"
    for _ in $(seq 1 $((seconds * 2))); do
        is_healthy && return 0
        sleep 0.5
    done
    return 1
}

if ! is_healthy; then
    if systemctl --user cat "$SERVICE" >/dev/null 2>&1; then
        systemctl --user start "$SERVICE" >/dev/null 2>&1 || true
        wait_healthy 30 || {
            notify "Backend failed to start. Check: systemctl --user status ${SERVICE}"
            exit 1
        }
    else
        mkdir -p "$LOG_DIR"
        notify "Starting the backend (the first start builds the app and can take a few minutes)..."
        setsid "$ROOT/tools/run-pixypilot.sh" >>"$LOG_DIR/backend.log" 2>&1 < /dev/null &
        wait_healthy 300 || {
            notify "Backend failed to start. See ${LOG_DIR}/backend.log"
            exit 1
        }
    fi
fi

open_app_window() {
    local browser
    for browser in "${PIXY_ARCH_BROWSER:-}" brave brave-browser chromium chromium-browser \
        google-chrome google-chrome-stable microsoft-edge microsoft-edge-stable vivaldi; do
        [ -n "$browser" ] || continue
        if command -v "$browser" >/dev/null 2>&1; then
            exec "$browser" --class="$APP_CLASS" --start-maximized --app="$URL"
        fi
    done
    exec xdg-open "$URL"
}

open_app_window
