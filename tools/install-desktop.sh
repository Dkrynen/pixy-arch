#!/usr/bin/env bash
# Install the Pixy Arch app-launcher entry and icons for the current user.
# Idempotent: safe to re-run, and re-run it if you move the checkout.
#
#   tools/install-desktop.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_SRC="$ROOT/deploy/pixy-arch.desktop"
ICONS_SRC="$ROOT/deploy/icons"

APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"

die() { printf 'install-desktop: %s\n' "$*" >&2; exit 1; }
log() { printf 'install-desktop: %s\n' "$*" >&2; }

[ -f "$DESKTOP_SRC" ] || die "missing $DESKTOP_SRC"
case "$ROOT" in
  *[\"\`\$\\]*) die "the checkout path contains a quote, \$, or backslash; move it to a plainer path" ;;
esac

# Literal substitution (no regex or & surprises); % must be doubled in Exec.
render() {
  PIXY_ROOT="${ROOT//%/%%}" awk '{
    out = ""; s = $0
    while ((i = index(s, "@ROOT@")) > 0) {
      out = out substr(s, 1, i - 1) ENVIRON["PIXY_ROOT"]; s = substr(s, i + 6)
    }
    print out s
  }' "$1"
}

install -d -m 0755 "$APPS_DIR"
render "$DESKTOP_SRC" > "$APPS_DIR/pixy-arch.desktop"
chmod 0644 "$APPS_DIR/pixy-arch.desktop"
log "installed $APPS_DIR/pixy-arch.desktop"

install_icon() {
    local src="$1" size_dir="$2"
    [ -f "$src" ] || die "missing $src"
    install -d -m 0755 "$ICON_ROOT/$size_dir/apps"
    install -m 0644 "$src" "$ICON_ROOT/$size_dir/apps/$(basename "$src")"
}

install_icon "$ICONS_SRC/pixy-arch-128.png" "128x128"
install_icon "$ICONS_SRC/pixy-arch-256.png" "256x256"
install_icon "$ICONS_SRC/pixy-arch-512.png" "512x512"
install_icon "$ICONS_SRC/pixy-arch.svg" "scalable"
log "installed icons under $ICON_ROOT"

if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -t -f "$ICON_ROOT" >/dev/null 2>&1 || true
fi

log "done. Pixy Arch should now appear in your app launcher."
