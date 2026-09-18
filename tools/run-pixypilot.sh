#!/usr/bin/env bash
# Run the PixyPilot backend (serves the built frontend on :8000).
# Idempotent: installs backend/frontend deps only when inputs changed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/backend/.venv"
STAMP="$VENV/.pixypilot-installed"
DIST_INDEX="$ROOT/frontend/dist/index.html"
PYTHON_BIN="${PYTHON:-python3}"

log() { printf 'run-pixypilot: %s\n' "$*" >&2; }

if [ ! -x "$VENV/bin/python" ]; then
  log "creating backend venv"
  "$PYTHON_BIN" -m venv "$VENV"
fi

if [ ! -f "$STAMP" ] || [ "$ROOT/backend/pyproject.toml" -nt "$STAMP" ]; then
  log "installing backend (pip install -e backend)"
  "$VENV/bin/python" -m pip install -q --upgrade pip
  "$VENV/bin/python" -m pip install -q -e "$ROOT/backend"
  touch "$STAMP"
fi

if [ ! -d "$ROOT/frontend/node_modules" ] || [ "$ROOT/frontend/package.json" -nt "$ROOT/frontend/node_modules" ]; then
  log "installing frontend deps"
  npm --prefix "$ROOT/frontend" install --loglevel=error --no-fund --no-audit
fi

# Rebuild the frontend bundle when it is missing or any source file changed
# since the last build (dist/index.html carries the build's mtime).
if [ ! -f "$DIST_INDEX" ] || \
   [ -n "$(find "$ROOT/frontend/src" "$ROOT/frontend/index.html" "$ROOT/frontend/package.json" -newer "$DIST_INDEX" -print -quit 2>/dev/null)" ]; then
  log "building frontend (npm run build)"
  npm --prefix "$ROOT/frontend" run build -- --logLevel=error
fi

exec "$VENV/bin/pixypilot-api"
