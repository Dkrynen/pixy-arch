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

Hardware-behavior + UX pass (user feedback):

- Standard mode now unparks the gimbal: `set_tracking` to any non-privacy
  mode calls `_unpark_gimbal_if_parked` — queries motor_pos_tilt, and when
  parked below −80° sends a 12° relative up nudge (absolute moves are
  ignored at the mechanical park deadband) then absolute (0°,0°).
  Live-verified: tilt −90° → +0.06°.
- Drag pad slowed for hardware safety: vector limit 30 → 12 with an eased
  curve (fine ~1-4°/s nudges near center, ~12°/s at pad edge vs ~25°/s
  before — measured live via motor telemetry).
- Preview blur fixed: loopback path re-encodes YUYV→MJPEG at -q:v 2 (was
  q5). ~73KB/frame at 1080p. Camera AF/focus hardware verified healthy —
  blur was the transcode step only; OBS gets uncompressed YUYV regardless.
- UI de-sloped to a Zed-like zinc palette: neutral surfaces, single muted
  blue accent (accent-soft selected states instead of bright fills), teal
  hardcodes remapped, gradients removed, tighter topbar/brand density.
- Scroll sprawl fixed: Smart Pixy rail sections are now native
  details/summary disclosures — Tracking & Follow open by default,
  Privacy Timer / Orientation / Focus / Audio DSP / Locks & Imaging /
  Power-On & Remote collapsed. Smoke script expands a section to exercise
  it (and captures innerText before view-switch remounts re-collapse).
- Mode segmented row stacks the label above buttons so
  STANDARD/TRACKING/PRIVACY render untruncated.

Gates: 172 backend + 229 frontend tests, tsc/build clean, smoke green
(0 console errors), all fixes live-verified on the physical camera.

Relay-fed architecture (2026-09-18 night — fixes "camera doesn't load"):

- Root cause: v4l2loopback is effectively single-reader; a pipe-blocked
  ffmpeg preview process survived SIGTERM (never checks signals while
  blocked on a full pipe) and held /dev/video10 forever → every new
  preview got EBUSY → empty 200 → permanent PREVIEW PAUSED.
- New architecture: the feeder ffmpeg gains a second output —
  `-map 0:v -c:v copy -f mjpeg pipe:1` — drained by an in-process
  FrameRelay (latest-frame fanout, closes subscribers on feeder exit).
  Preview streams and recordings subscribe to the relay and NEVER open
  /dev/video10, whose single-reader slot stays free for OBS/call apps.
  Verified live: relay preview + external sink reader + recording all
  concurrent.
- `_stop_process` is cancellation-proof: terminate/kill escalation runs
  under a shield so client disconnects can't orphan ffmpeg.
- Both stream paths commit only after a first frame — busy/broken
  devices return 503 with detail instead of empty 200s.
- Recording hardening: spawn registered before the watch sleep,
  local-captured process refs in stop/reap (no post-await attribute
  races), first-frame guarantee before ffmpeg spawn, feed task
  cancelled+awaited on all exits, wall-clock timestamps on the mjpeg
  stdin input (dark scenes deliver ~10fps; synthetic -framerate made
  playback 3x fast).
- `_jpeg_frames` is now a marker-walk parser — length-delimited segments
  are skipped wholesale so embedded JPEG thumbnails (APP1/EXIF) can't
  truncate a frame; restart markers, stuffed bytes, progressive
  multi-scan handled; 8MB buffer cap.
- VirtualCam lifecycle: `_lifecycle_lock` serializes start/stop; the
  process + relay are registered BEFORE the spawn-watch sleep so
  status()/stop() see them during startup; bounded wait after kill;
  prior error preserved instead of generic exit clobbering; configured
  by-path sink aliases canonicalized via resolve() for holder scans;
  route no longer kills previews before a start actually commits
  (stop_streams moved inside _start_locked).
- Automation watches the sink too: `_scan_all_holders` merges holders
  of /dev/video0 and /dev/video10 (dedup by rdev), excludes pipewire/
  wireplumber enumerators by comm and our own feeder by sink-writer
  cmdline match. Verified live: ffmpeg attach on video10 →
  call-start:tracking+unmute; detach → call-end:privacy+remute.
- Lifespan shutdown now stops recordings and streams as well as
  automation and the vcam.
- Frontend: bounded stream retries (counter reset only on manual/new
  streams — previously reset on every auto-retry so the failure UI was
  unreachable); reconnects on vcam running-state transitions; focus
  click + aspect math use naturalWidth/Height of actual frames;
  ownership hints reflect relay reality (preview = "camera tap",
  recording = "records the camera tap", idle = "available to other
  apps"); preview stays live during relay-fed recording
  (keepPreviewDuringRecording); useVirtualCam always polls so external
  starts register; saveSettings/fullscreen rejections caught.
- Hardware note: camera advertises 30/60fps at 1080p but real MJPEG
  delivery drops to ~10fps in a dark room (long exposures) — physics,
  not a bug. The ISP outputs synthesized all-zero frames while privacy
  is latched; it releases cleanly on unpark when automation isn't
  re-parking between attach/detach test cycles.

Gates: 185 backend + 233 frontend tests, tsc/build clean, 10/10
browser flows (0 console/page errors, real 1920x1080 frames, valid mkv),
live-verified on hardware. Camera parked in privacy, vcam running,
automation armed, zero orphan processes.

Post-ship ops (2026-09-24) — on-demand virtual camera:

The autostarted vcam feeder held /dev/video0 open 24/7 (~25% CPU on one core,
sensor always streaming) just to keep video10 enumerable. Replaced
with a demand-driven lifecycle in VirtualCamService:

- Standby: ffmpeg loops one canned 1920x1080 YUYV dark frame
  (-re -stream_loop -1 -f rawvideo) into video10 at 5fps — capture
  caps stay advertised (OBS still lists "PixyPilot Virtual", and the
  loopback still reports 1080p@30 regardless of write pace), ~2% of
  one core, and /dev/video0 is never opened. A lavfi generator was
  tried first: loopback never blocks writers so it spun at ~650%
  unthrottled, ~30% with -re; a 30fps canned loop was ~16% (writes
  dominate), so standby writes at 5fps — a probing reader waits ~200ms
  for a frame. Frame+log live at fixed paths
  /tmp/pixypilot-standby-{frame.yuyv,log} so restarts/transitions
  can't leak unique tempfiles.
- Demand: 1s _demand_tick reuses _scan_sink_holders (enumerators like
  wireplumber excluded). Consumer on video10 → standby stops, real
  pipeline starts on video0; zero consumers for idle_grace_seconds
  (default 8) → live stops, standby resumes. Foreign writers are never
  stomped; active recording blocks the drop; failed demand starts
  re-arm standby + 5s backoff.
- start() arms + goes live immediately; stop() disarms and frees the
  sink (a disarmed sink never auto-restarts). New status fields:
  mode: off|standby|live, armed: bool. New settings:
  virtualcam.on_demand (default true), virtualcam.idle_grace_seconds
  (default 8), persisted via /api/settings, toggle in VirtualCamPanel.
- deploy fix: removed keep_format=1 from modprobe.d conf + setup
  script — v4l2loopback >=0.13 moved it to a device ioctl; as a module
  param it makes modprobe fail and /dev/video10 never appears.
- Live-verified: idle (video0 free, caps 1080p30 on video10) →
  ffmpeg consumer attach → live in ~1-2s (video0+video10 held by the
  real pipeline) → detach → standby after grace, video0 free again.
  Verified twice including after the canned-frame change.

Note: the omarchy-emeet-pixy bar widget's call* settings were kept OFF
because the old feeder looked like a permanent call — with on-demand
mode video0 is only held during real use, so they can be re-enabled.
Its preview can now grab video0 while idle too.

Post-ship ops (2026-09-21):
- Re-verified live: 10/10 verify flows green, full call cycle
  (ffmpeg attach → call-start:tracking+unmute → detach →
  call-end:privacy+remute), and a real OBS attach on video10 →
  call-start fired against the running feeder.
- tmp-verify.mjs promoted to frontend/scripts/verify-live.mjs
  (`npm run verify:live`) and committed.
- Installed desktop entry refreshed: StartupWMClass now `pixy-arch`
  to match the launcher's `--class`.
- PIXY mic set as PipeWire default source (was muted-when-idle but
  not default).
- nille/omarchy-emeet-pixy installed into the Omarchy bar. Its
  preview/snapshot cannot grab /dev/video0 while the vcam feeder
  owns it, and /dev/video10 is effectively single-reader (OBS era) —
  panel preview will report "in use"; set `preview false` via
  `omarchy bar set` if the placeholder annoys. Keep its call*
  settings OFF: the feeder looks like a permanent call to it.
  PixyPilot automation already owns that logic correctly.
