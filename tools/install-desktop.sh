#!/usr/bin/env bash
# Install the Pixy Arch desktop entry and icons for the current user.
# Idempotent — safe to re-run; only updates files that changed.
#
#   tools/install-desktop.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_SRC="$ROOT/deploy/pixy-arch.desktop"
ICONS_SRC="$ROOT/deploy/icons"

APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"

die() { printf 'install-desktop: %s\n' "$*" >&2; exit 1; }
log() { printf 'install-desktop: %s\n' "$*" >&2; }

[ -f "$DESKTOP_SRC" ] || die "missing $DESKTOP_SRC"

# The desktop entry launches tools/pixy-arch-launch.sh via an absolute path,
# so it only resolves while the repo stays at $ROOT.
case "$(grep '^Exec=' "$DESKTOP_SRC")" in
  Exec="$ROOT"/*) ;;
  *) die "desktop Exec does not point into this checkout ($ROOT)" ;;
esac

install -d -m 0755 "$APPS_DIR"
install -m 0644 "$DESKTOP_SRC" "$APPS_DIR/pixy-arch.desktop"
log "installed $APPS_DIR/pixy-arch.desktop"

install_icon() {
    local src="$1" size_dir="$2"
    [ -f "$src" ] || die "missing $src"
    install -d -m 0755 "$ICON_ROOT/$size_dir/apps"
    install -m 0644 "$src" "$ICON_ROOT/$size_dir/apps/$(basename "$src")"
    log "installed $ICON_ROOT/$size_dir/apps/$(basename "$src")"
}

install_icon "$ICONS_SRC/pixy-arch-128.png" "128x128"
install_icon "$ICONS_SRC/pixy-arch-256.png" "256x256"
install_icon "$ICONS_SRC/pixy-arch-512.png" "512x512"
install_icon "$ICONS_SRC/pixy-arch.svg" "scalable"

if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -t -f "$ICON_ROOT" >/dev/null 2>&1 || true
fi

log "done — Pixy Arch should appear in the app launcher."
