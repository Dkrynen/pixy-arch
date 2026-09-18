# Pixy Arch — Project Context

Linux control deck for the EMEET PIXY AI PTZ camera. FastAPI backend (`backend/src/pixypilot`,
served by systemd user service `pixypilot.service` on 127.0.0.1:8000) + React 18/Vite frontend
(`frontend/`, built to `frontend/dist`, served by the backend). Real hardware attached:
/dev/video0-1 (EMEET PIXY), /dev/video10 (PixyPilot Virtual v4l2loopback), hidraw node for vendor
HID commands.

## Goal (2026-09-18 push)

Every feature works end-to-end on the real device, and the UI looks and feels like a finished
product — not a dev tool. 10 parallel workstreams; disjoint file ownership per ROADMAP.

## Baseline

- Backend: 112 tests green (`backend/.venv/bin/python -m pytest -x -q`)
- Frontend: 103 tests green (`cd frontend && npx vitest run`), `npx tsc -b` clean
- Service: running, healthy at :8000

## Rules

- Agents do NOT git commit/push. Integration + commit happens after merge review.
- Do not kill/restart `pixypilot.service` — curl-verify against it; restore camera state
  (stop streams, recordings, vcam, recenter PTZ) after testing.
- File ownership is exclusive (see ROADMAP). Bug found in another agent's file → report a
  precise patch suggestion, don't edit it.
- `frontend/src/styles.css` belongs ONLY to the design workstream.
- New API endpoints: append-only at end of `api/routes.py` behind a `# <domain>` comment,
  re-read before editing. New frontend API helpers/types go in your own files.
- Evidence before "done": run the tests for your area; verify live behavior where possible.
