#!/usr/bin/env bash
# Run Pixy Arch: the backend serves the API and the built UI on one port.
# Idempotent: installs backend/frontend deps and rebuilds the UI only when
# their inputs changed.
#
#   tools/run-pixypilot.sh               set up if needed, then run
#   tools/run-pixypilot.sh --setup-only  set up if needed, then exit
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/backend/.venv"
STAMP="$VENV/.pixypilot-installed"
DIST_INDEX="$ROOT/frontend/dist/index.html"
CONFIG="$ROOT/config/pixypilot.yaml"
CONFIG_EXAMPLE="$ROOT/config/pixypilot.example.yaml"

SETUP_ONLY=0
case "${1:-}" in
  --setup-only) SETUP_ONLY=1 ;;
  "") ;;
  *) printf 'usage: %s [--setup-only]\n' "$0" >&2; exit 2 ;;
esac

log() { printf 'pixy-arch: %s\n' "$*" >&2; }
die() { printf 'pixy-arch: error: %s\n' "$*" >&2; exit 1; }

pick_python() {
  local candidate
  for candidate in "${PYTHON:-}" python3 python3.13 python3.12; do
    [ -n "$candidate" ] || continue
    command -v "$candidate" >/dev/null 2>&1 || continue
    if "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 12))' 2>/dev/null; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

check_node() {
  command -v node >/dev/null 2>&1 || die "Node.js 20.19+ is required (see README: Prerequisites)."
  command -v npm >/dev/null 2>&1 || die "npm is required (see README: Prerequisites)."
  node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 22 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19) ? 0 : 1);
  ' || die "Node.js $(node --version) is too old; install Node 22 LTS (20.19+ also works)."
}

if [ ! -f "$CONFIG" ] && [ -f "$CONFIG_EXAMPLE" ]; then
  cp "$CONFIG_EXAMPLE" "$CONFIG"
  log "created config/pixypilot.yaml from the example"
fi

# A venv created without python3-venv/ensurepip has bin/python but no pip;
# treat that as missing so the next run repairs it instead of failing at pip.
if [ ! -x "$VENV/bin/pip" ]; then
  PYTHON_BIN="$(pick_python)" || die "Python 3.12+ is required (see README: Prerequisites)."
  rm -rf "$VENV"
  log "creating backend venv with $PYTHON_BIN"
  "$PYTHON_BIN" -m venv "$VENV" || {
    rm -rf "$VENV"
    die "could not create a venv; on Ubuntu/Debian install python3-venv."
  }
fi

if [ ! -f "$STAMP" ] || [ "$ROOT/backend/pyproject.toml" -nt "$STAMP" ]; then
  log "installing backend"
  "$VENV/bin/python" -m pip install -q --upgrade pip
  "$VENV/bin/python" -m pip install -q -e "$ROOT/backend"
  touch "$STAMP"
fi

if [ ! -d "$ROOT/frontend/node_modules" ] || \
   [ "$ROOT/frontend/package-lock.json" -nt "$ROOT/frontend/node_modules" ]; then
  check_node
  log "installing frontend dependencies"
  npm --prefix "$ROOT/frontend" ci --loglevel=error --no-fund --no-audit
  touch "$ROOT/frontend/node_modules"
fi

# Rebuild the UI bundle when it is missing or any source file changed since
# the last build (dist/index.html carries the build's mtime).
if [ ! -f "$DIST_INDEX" ] || \
   [ -n "$(find "$ROOT/frontend/src" "$ROOT/frontend/index.html" "$ROOT/frontend/package.json" -newer "$DIST_INDEX" -print -quit 2>/dev/null)" ]; then
  check_node
  log "building the UI"
  npm --prefix "$ROOT/frontend" run build -- --logLevel=error
fi

if [ "$SETUP_ONLY" -eq 1 ]; then
  log "setup complete"
  exit 0
fi

cd "$ROOT"
exec "$VENV/bin/pixypilot-api"
