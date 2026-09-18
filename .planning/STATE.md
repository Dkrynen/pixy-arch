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

Post-ship additions (virtual webcam in OBS + fullscreen preview):

- `virtualcam.autostart` (default on): the transform pipeline starts with the
  service so /dev/video10 always advertises Video Capture caps — an idle
  v4l2loopback is output-only and does not enumerate in OBS.
- Preview redirect: while the vcam owns /dev/video0, a stream request for it
  transparently serves the loopback (YUYV, negotiated dims) — the live
  monitor shows exactly what OBS receives. Stop route substitutes the same.
- Settings: `virtualcam` section in GET/PATCH /api/settings + "Run at
  startup" toggle in VirtualCamPanel; persists to config/pixypilot.yaml.
- Fullscreen preview: Fullscreen API button + fill (object-fit: cover)
  toggle on the video frame; click-to-focus maps through
  focusPointFromCoverClick so region math stays exact in fill mode.
- Launcher opens maximized (`--start-maximized`).
- modprobe conf gains `keep_format=1` (deploy + /etc copy on next
  setup-virtualcam.sh run or module reload).

Verified live: autostart fired on service restart, /dev/video10 shows
Video Capture caps, video0 stream request returns the loopback's
1920x1080 MJPEG, settings PATCH round-trips to yaml.
Gates: 169 backend + 228 frontend tests, tsc/build clean, smoke green.

Taste-test fixes (post-vcam regressions found on live verification):

- Recording now uses the same `_loopback_substitute` as preview — while the
  vcam feeder owns /dev/video0, record requests target the loopback instead
  of failing with "Device or resource busy".
- `build_record_command` is codec-aware: MJPG input copies frames; raw
  formats (YUYV from the loopback) encode to MJPEG q3 — a rawvideo copy
  would mux ~120 MB/s into the .mkv.
- Automation no longer treats our own ffmpeg loopback writer as a "call":
  `_is_sink_writer` matches ffmpeg whose final argv is the configured sink
  and excludes it from holder scans; the watch loop refreshes the sink path
  when the loopback appears post-startup. Previously the autostart feeder
  kept `camera_in_use` true forever → tracking on + mic unmuted at boot.
- `_apply_start_in_privacy` hardened: 45s retry window (udev hidraw
  permissions can lag past the old 20s), any exception retries instead of
  killing the task silently, and `pixypilot.startup` logging makes the
  outcome visible in journalctl. Confirmed via hid-trace: tracking:privacy
  written at boot+1s, gimbal parked tilt −90° (motor_pos floats), mic
  muted. Note: the device readback settles to tracking_mode "off" once
  privacy engages — the lens-cover state is the real indicator.

Gates after fixes: 171 backend + 228 frontend tests, tsc/build clean,
smoke green, live re-verified end-to-end.

Deferred (optional): structured PTZ-position endpoint; vector-motion server
watchdog; audio-mode readback coverage in panel tests.
