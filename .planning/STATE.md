# State — 2026-09-18

Phase: complete — all 10 workstreams shipped, integrated, and verified live.

| Phase | Workstream | Status |
|---|---|---|
| P1 | Video pipeline | done — stale-stream reaper, recording hardening, click-focus verified |
| P2 | Virtual cam | done — first-frame gate, runtime status fields, last_error |
| P3 | PTZ | done — motor telemetry readout, tracking-off ordering, unmount stop |
| P4 | V4L2 controls + presets | done — all 19 controls verified, dependent-control refresh |
| P5 | SmartPixy HID | done — 8-section panel, 15-query readback sweep, honest unsupported states |
| P6 | Audio + automation | done — pw-cat meter, default-source restore, privacy-first startup |
| P7 | Firmware + diagnostics | done — pcap magic validation, honest 404 manifest reporting |
| P8 | Shell + wiring | done — API type sync, hotplug SSE, command log |
| P9 | Design system | done — dark cockpit, zero overflow 900–1440px, scoped CSS tokens |
| P10 | API + E2E + packaging | done — 62 endpoints verified, launcher/desktop/icons, smoke suite |

Integration handoffs applied: CapabilitySummary removed; stream preflight 404;
pcap DELETE endpoint; audio restore + meter UI end-to-end; ControlShell
dependency hints; degenerate-range guards; useAudio/apiClient shim cleanup;
scoped CSS migrated to design tokens; useAudio meter tests re-mocked.

Final gates: 165 backend + 224 frontend tests green; tsc clean; Vite build
clean; smoke 12/12 with 0 console errors; pixypilot.service restarted and
re-verified live (audio/vcam/meter/pcap-delete/stream-404 all working).
Camera left in privacy-first state: HID privacy on, gimbal parked −90°, mic
muted, no orphan ffmpeg/fds/recordings.

Deferred (optional): structured PTZ-position endpoint; vector-motion server
watchdog; audio-mode readback coverage in panel tests.
