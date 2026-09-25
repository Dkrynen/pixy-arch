#!/usr/bin/env bash
# Run the Pixy Arch backend as a systemd user service that starts at login.
# Idempotent: safe to re-run, and re-run it if you move the checkout.
#
#   tools/install-service.sh              install, enable, and start
#   tools/install-service.sh --uninstall  stop, disable, and remove
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_NAME="pixypilot.service"
UNIT_SRC="$ROOT/deploy/systemd/user/$UNIT_NAME"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

die() { printf 'install-service: %s\n' "$*" >&2; exit 1; }
log() { printf 'install-service: %s\n' "$*" >&2; }

[ "$(id -u)" -ne 0 ] || die "run this as your normal user, not with sudo"
command -v systemctl >/dev/null 2>&1 || die "systemd is required for the service; use tools/run-pixypilot.sh instead"

if [ "${1:-}" = "--uninstall" ]; then
    systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/$UNIT_NAME"
    systemctl --user daemon-reload
    log "removed $UNIT_NAME"
    exit 0
fi

[ -f "$UNIT_SRC" ] || die "missing $UNIT_SRC"
case "$ROOT" in
  *[\"\`\$\\]*) die "the checkout path contains a quote, \$, or backslash; move it to a plainer path" ;;
esac

# The service runs the installed backend directly, so build everything first.
"$ROOT/tools/run-pixypilot.sh" --setup-only

install -d -m 0755 "$UNIT_DIR"
# Literal substitution; % is a systemd specifier and must be doubled.
PIXY_ROOT="${ROOT//%/%%}" awk '{
  out = ""; s = $0
  while ((i = index(s, "@ROOT@")) > 0) {
    out = out substr(s, 1, i - 1) ENVIRON["PIXY_ROOT"]; s = substr(s, i + 6)
  }
  print out s
}' "$UNIT_SRC" > "$UNIT_DIR/$UNIT_NAME"
chmod 0644 "$UNIT_DIR/$UNIT_NAME"
log "installed $UNIT_DIR/$UNIT_NAME"

systemctl --user daemon-reload
systemctl --user enable "$UNIT_NAME" >/dev/null
systemctl --user restart "$UNIT_NAME"
log "service enabled and started. Logs: journalctl --user -u $UNIT_NAME -f"
