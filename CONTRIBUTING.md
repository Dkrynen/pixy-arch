# Contributing to Pixy Arch

Thanks for helping. Bug reports, hardware findings, and pull requests are all welcome.

## Reporting a bug

Open an issue with the bug template and include:

- your distro and kernel (`uname -r`), and how you run Pixy Arch (script, service, or launcher);
- the camera's firmware version (Diagnostics view) if the bug involves camera behavior;
- the output of `http://127.0.0.1:8000/api/pixy-hid/status` and `/api/virtualcam/status` if relevant;
- backend logs (`journalctl --user -u pixypilot.service`, or the terminal running `tools/run-pixypilot.sh`).

Report security issues privately instead; see [SECURITY.md](SECURITY.md).

## Development setup

You need the [requirements](README.md#requirements) from the README. Then:

```bash
# Backend with dev dependencies
cd backend
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/pixypilot-api          # API on http://127.0.0.1:8000

# UI with hot reload, in a second terminal
cd frontend
npm ci
npm run dev                      # http://127.0.0.1:5173, proxies /api to :8000
```

`tools/run-pixypilot.sh` installs the backend without dev dependencies; run the `pip install -e ".[dev]"` line above once to add them to the same venv.

## Checks

Run these before opening a pull request. CI runs the same ones.

```bash
cd backend
.venv/bin/python -m pytest -q
.venv/bin/ruff check src

cd ../frontend
npx tsc -b
npx vitest run
npm run build
```

`npm run test:smoke` drives the built UI in a headless browser against a running backend. `npm run verify:live` exercises the real camera end to end, so run it only with a PIXY attached. It restores the camera mode it found when it finishes, and `--cleanup-recording` deletes its test recording. Set `PIXY_ARCH_URL` or pass a URL to target another port.

## Guidelines

- Keep changes focused, and add or update tests for any behavior change. The backend tests use fakes for devices and processes, so they run without a camera.
- Never send an HID command you haven't confirmed on real hardware or in a packet capture. Mark anything experimental in the UI.
- Follow the existing layout: feature code lives in `backend/src/pixypilot/domains/<name>/` and `frontend/src/{components,hooks,domains}`. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- Don't commit packet captures, recordings, diagnostics, or your `config/pixypilot.yaml`. They can contain device serials and personal data, and `.gitignore` already excludes them.
