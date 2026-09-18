#!/usr/bin/env bash
# Pixy Arch launcher — ensure the pixypilot backend is up, then open the
# control deck as a standalone Brave app window.
# Idempotent: a running backend is reused; the app window gets the stable
# class "pixy-arch" so the desktop entry matches on X11 and Wayland.
set -u

URL="http://127.0.0.1:8000"
HEALTH="${URL}/health"
SERVICE="pixypilot.service"
APP_CLASS="pixy-arch"

wait_healthy() {
    # 40 * 0.5s = 20s max (cold start can include a venv/frontend build)
    for _ in $(seq 1 40); do
        if curl -sf "$HEALTH" >/dev/null 2>&1; then
            return 0
        fi
        sleep 0.5
    done
    return 1
}

if ! curl -sf "$HEALTH" >/dev/null 2>&1; then
    systemctl --user start "$SERVICE" >/dev/null 2>&1 || true
    if ! wait_healthy; then
        if command -v notify-send >/dev/null 2>&1; then
            notify-send "Pixy Arch" "Backend failed to start — check: systemctl --user status ${SERVICE}"
        fi
        exit 1
    fi
fi

if command -v brave >/dev/null 2>&1; then
    exec brave --class="$APP_CLASS" --app="$URL"
elif command -v brave-browser >/dev/null 2>&1; then
    exec brave-browser --class="$APP_CLASS" --app="$URL"
else
    exec xdg-open "$URL"
fi
