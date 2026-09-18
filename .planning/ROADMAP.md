# Pixy Arch — Perfection Push Roadmap

10 parallel workstreams. Each owns its files exclusively — no agent edits another's files.
Cross-file bugs get reported as patch suggestions, not edits.

## P1 — Video pipeline (`agent-video`)

Owns: `backend/src/pixypilot/domains/video/**`, `frontend/src/hooks/useVideoCapture.*`,
`frontend/src/components/panels/VideoMonitor.*`, `frontend/src/domains/video/**`

- Preview start/stop lifecycle bulletproof (no orphaned ffmpeg/V4L2 handles)
- Format-aware streaming; clean error states (camera busy, no device, lens closed)
- Recording start/stop UX + status truthfulness; files land in recordings/
- Click-to-focus on preview → `setPixyFocusMetering` point (decoded 0..127 range), verify `focusPoint` math

## P2 — Virtual cam (`agent-vcam`)

Owns: `backend/src/pixypilot/domains/virtualcam/**`, `frontend/src/hooks/useVirtualCam.*`,
`frontend/src/components/panels/VirtualCamPanel.*`, `deploy/modprobe.d/**`, `deploy/modules-load.d/**`

- Start/stop against real /dev/video10 loopback; quality selector; spawn-failure surfacing
- Status honesty (running device, format, consumers)

## P3 — PTZ (`agent-ptz`)

Owns: `frontend/src/components/controls/PtzControlPanel.*`, `frontend/src/domains/ptz/**`

- Jog pad, direction/relative/absolute moves, recenter, vector pad, preset save/load/clear
- Verify each against live API (curl); camera restores to center after tests
- Report-only for backend gaps (pixy_hid = P5, v4l2 = P4)

## P4 — V4L2 controls + presets (`agent-controls`)

Owns: `backend/src/pixypilot/domains/v4l2/**`, `backend/src/pixypilot/domains/control_presets/**`,
`frontend/src/hooks/useControls.*`, `frontend/src/hooks/useControlPresets.*`,
`frontend/src/components/controls/**` (minus PtzControlPanel), `frontend/src/domains/controls/**`

- Every driver-reported control works (incl. while a stream holds the camera)
- Auto/manual unlock UX for exposure, white balance, focus — obvious, not buried
- Named profiles save/apply/delete all controls at once; solid validation + error surfacing

## P5 — SmartPixy HID (`agent-hid`)

Owns: `backend/src/pixypilot/domains/pixy_hid/**`, `frontend/src/hooks/usePixyHid.*`,
`frontend/src/components/panels/SmartPixyPanel.*`, `frontend/src/components/panels/HidDiagnosticsPanel.*`

- Tracking, target tracking, gesture, mirror/flip, auto-rotate, audio DSP modes, focus metering,
  PTZ presets, power-on default, denoise/WB/EV/focus locks, motor speed, remote pairing
- hidraw permission handling honest (dim + explain when not writable)
- Diagnostics snapshot capture + query explorer work and read clearly

## P6 — Audio + automation + settings (`agent-audio`)

Owns: `backend/src/pixypilot/domains/audio/**`, `backend/src/pixypilot/domains/automation/**`,
`backend/src/pixypilot/domains/settings/**`, `frontend/src/hooks/useAudio.*`,
`frontend/src/hooks/useAutomation.*`, `frontend/src/hooks/usePrivacySafety.*`,
`frontend/src/components/panels/AutomationPanel.*`, `frontend/src/components/settings/**`

- Mic mute/volume/level monitor via real ALSA path
- Call automation (auto open lens / tracking / unmute; restore only what it changed)
- Privacy-first startup behavior + settings persistence

## P7 — Firmware + diagnostics domains (`agent-diag`)

Owns: `backend/src/pixypilot/domains/firmware/**`, `backend/src/pixypilot/domains/uvc_extension/**`,
`backend/src/pixypilot/domains/pcap_import/**`, `frontend/src/hooks/useFirmware.*`,
`frontend/src/components/panels/FirmwarePanel.*`, `frontend/src/components/panels/ExperimentalPanel.*`,
`frontend/src/components/panels/PcapImportPanel.*`, `frontend/src/components/panels/CapabilitySummary.*`

- Firmware info/update-check panel truthful
- UVC extension selector probing UI clear + safe (read-only)
- Pcap import upload UX (drag/drop, metadata, list)

## P8 — Shell + wiring (`agent-shell`)

Owns: `frontend/src/app/App.tsx`, `frontend/src/components/panels/DeviceRail.*`,
`frontend/src/components/panels/CommandLogPanel.*`, `frontend/src/hooks/useDevices.*`,
`frontend/src/hooks/useVideoFormats.*`, `frontend/src/hooks/useHotplugEvents.*`,
`frontend/src/lib/apiClient.ts`, `frontend/src/types/api.ts`,
`backend/src/pixypilot/domains/devices/**`, `backend/src/pixypilot/domains/hotplug/**`,
`backend/src/pixypilot/main.py`, `backend/src/pixypilot/config.py`, `backend/src/pixypilot/run.py`

- Device selection + format picker correct incl. hotplug add/remove (SSE)
- Command log: HID/V4L2/stream/focus/audio/recording/safety events, compact + filterable
- Error/loading/empty states across the shell; API types match backend models exactly

## P9 — Design system (`agent-design`)

Owns: `frontend/src/styles.css`, `frontend/src/main.tsx`, `frontend/index.html`,
`frontend/src/components/layout/AppShell.*`, `frontend/src/components/layout/ControlDeck.*`,
`frontend/src/components/layout/DiagnosticsDeck.*`, `frontend/src/components/ui/**`,
`frontend/src/components/controls/inputs/ControlShell.*`

- Premium cockpit redesign: design tokens, typography, spacing rhythm, panel chrome,
  micro-motion, focus-visible states, responsive down to app-window sizes
- Preserve every handler/behavior in the layout files it owns; panels stay compatible
  (do not rename class names other agents' files rely on unless trivially safe)

## P10 — API + E2E + packaging (`agent-api`)

Owns: `backend/src/pixypilot/api/routes.py`, `deploy/**` (minus modprobe.d/modules-load.d),
`tools/**`, `README.md`, `docs/**`, `frontend/scripts/**`

- Curl-verify EVERY endpoint on live :8000; route-layer fixes; service-layer bugs → report patches
- Run `frontend/scripts/smoke-ui.mjs` E2E; fix what's broken at route level
- Launcher/desktop/icon/systemd/udev packaging coherent; README/docs match reality

## Integration (after all phases)

- Merge review, resolve conflicts, full test suite, `tsc -b`, vite build, smoke UI
- Update `.planning/STATE.md`
