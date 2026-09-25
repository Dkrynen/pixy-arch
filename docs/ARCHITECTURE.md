# Architecture

Pixy Arch is one local process: a FastAPI backend (`backend/src/pixypilot`) that talks to the camera and serves the React UI (`frontend/`) on the same port.

```
browser ── HTTP/SSE ──▶ FastAPI (127.0.0.1:8000)
                          ├─ V4L2 ioctls ─────────▶ /dev/videoN   (controls, formats, MJPEG capture)
                          ├─ hidraw reports ──────▶ /dev/hidrawN  (PTZ, AI modes, audio DSP, presets)
                          ├─ ffmpeg ──────────────▶ /dev/video10  (v4l2loopback virtual camera)
                          ├─ amixer / PipeWire ───▶ PIXY microphone
                          └─ pyudev ──────────────▶ hotplug events
```

## Backend layout

Each feature lives in `backend/src/pixypilot/domains/<name>/` as `models.py` (Pydantic request and response types) plus `service.py` (the logic, usually a process-wide singleton). `api/routes.py` is a thin HTTP layer over the services.

| Domain | What it does |
| --- | --- |
| `v4l2` | Device discovery, controls, and formats through native ioctls (`native.py`) |
| `video` | Preview streams and recording (`native_mjpeg.py` is mmap MJPEG capture) |
| `virtualcam` | The v4l2loopback pipeline, standby feed, and on-demand switching |
| `pixy_hid` | Vendor HID commands (`commands.py` builds the reports) and state queries |
| `audio` | Mic mute and gain (ALSA), level meter and monitor (PipeWire) |
| `automation` | Detects apps holding the camera and applies tracking or privacy |
| `control_presets`, `settings` | YAML-backed presets and runtime settings |
| `hotplug` | udev events streamed to the UI over SSE |
| `firmware`, `uvc_extension`, `pcap_import` | Diagnostics and reverse-engineering tools |

`security.py` guards the unauthenticated API against cross-site requests and DNS rebinding (see [SECURITY.md](../SECURITY.md)).

## Video pipeline

v4l2loopback is effectively single-reader: once one process has `/dev/video10` open, other readers get `EBUSY`. So the deck never reads the virtual camera itself.

When the virtual camera is live, one ffmpeg "feeder" process owns the physical camera and has two outputs:

1. the transformed picture (mirror, rotate, zoom) as raw video into `/dev/video10`, for OBS and meeting apps;
2. an MJPEG copy on its stdout, which an in-process **FrameRelay** fans out to every preview stream and recording.

So preview, recording, and an external app can all run at once from one camera open. Recordings from the relay are timestamped at wall-clock arrival, because the camera's real frame rate drops in the dark (long exposures).

When the virtual camera isn't live, preview and recording open the physical camera directly: native V4L2 mmap capture for MJPEG, and ffmpeg for other formats.

## On-demand virtual camera

An idle v4l2loopback device advertises output-only capabilities, so apps don't list it as a camera. To stay listed without keeping the physical camera streaming, the virtual camera has three modes:

- **standby**: ffmpeg loops one dark 1920×1080 frame into the sink at 5 fps. The sink stays listed in apps, the physical camera stays closed, and the cost is about 2% of one CPU core.
- **live**: a process opened the sink (checked every second by scanning `/proc/*/fd`, ignoring PipeWire's enumeration handles). Standby stops and the real feeder starts, usually within 1 to 2 seconds.
- **off**: disarmed. `POST /api/virtualcam/stop` frees the sink, and it doesn't restart on its own.

After the last reader closes the sink, the pipeline returns to standby after `virtualcam.idle_grace_seconds`. It never takes over a sink that another program is writing to, and it doesn't drop to standby while a recording is using the relay.

## Call automation

`automation` scans which processes hold the PIXY capture node or the virtual camera sink. When a real app appears, it saves the current mode, switches to tracking, and optionally unmutes the mic. After `grace_seconds` with no holders, it applies `on_close` (privacy by default) and re-mutes the mic if it unmuted it. The feeder's own ffmpeg process and PipeWire enumerators are excluded, so the deck never mistakes itself for a call.

## Privacy at startup

With `safety.start_in_privacy` enabled, the backend retries for up to 45 seconds after startup, since udev can be slow to grant hidraw access at boot. It sends privacy mode, which parks the gimbal and covers the lens, and mutes the mic. Switching back to standard mode un-parks the gimbal with a small relative move, because the firmware ignores absolute moves while parked.

## PTZ safety

The drag pad sends a velocity vector. While it's held, the UI re-sends the current vector every 500 ms. The backend sends a stop itself if no vector arrives within 1.5 seconds, so a closed tab or a dropped connection can't leave the gimbal moving.
