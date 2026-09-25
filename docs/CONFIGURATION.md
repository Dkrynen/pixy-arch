# Configuration

Pixy Arch reads `config/pixypilot.yaml`. `tools/run-pixypilot.sh` creates it from [`config/pixypilot.example.yaml`](../config/pixypilot.example.yaml) on first run. The file is yours: git does not track it, and the app's Settings view saves changes into it.

Any key you leave out uses the default shown below; an invalid automation value falls back to its default with a warning in the log. Relative paths are resolved from the repository root. Restart the backend after changing `server`, `storage`, `hid`, or `frontend` values:

```bash
systemctl --user restart pixypilot.service   # if installed as a service
# otherwise stop tools/run-pixypilot.sh (Ctrl+C) and start it again
```

## Reference

```yaml
safety:
  start_in_privacy: true      # cover the lens and mute the mic at startup

server:
  host: 127.0.0.1             # see "Network access" before changing this
  port: 8000
  reload: false               # auto-reload on code changes (development)
  allowed_hosts: []           # extra hostnames browsers may use, e.g. [pixy.lan]

frontend:
  dist: frontend/dist         # built UI served by the backend (config file only)
  dev_server:                 # Vite dev server, used for CORS in development
    host: 127.0.0.1
    port: 5173

cors:
  origins: []                 # extra browser origins allowed to call the API

storage:
  presets: config/presets.yaml   # image-control presets (config file only)
  recordings: recordings         # where recordings are saved

hid:
  path: null                  # null = auto-detect; or a fixed /dev/hidrawN
  report_gap_ms: 25           # pause between HID reports

virtualcam:
  device: null                # null = auto-detect the v4l2loopback sink
  label: Pixy Arch Virtual    # sink name to look for (also accepts "PixyPilot Virtual")
  autostart: true             # manage the virtual camera from startup
  on_demand: true             # stream the real camera only while an app reads the sink
  idle_grace_seconds: 8       # wait this long after the last reader before going idle (0-600)

automation:
  enabled: true
  video_device: auto          # auto = the EMEET PIXY capture node; or e.g. /dev/video2
  on_open: tracking           # tracking | none
  on_close: privacy           # privacy | previous | none
  unmute_mic: true            # unmute while an app uses the camera
  grace_seconds: 8            # wait after the last app closes the camera
  poll_seconds: 1             # how often to check which apps hold the camera (0.5-60)
  exclude_processes: [pipewire, wireplumber]   # holders that don't count as a call

firmware:
  manifest_url: https://www.emeet.ai/device_software/EMEET_STUDIO/pixy/device_upgrade_pixy.json
```

`frontend.dist` and `storage.presets` can only be changed in the file, not through the app, because the app writes files to those locations.

## Common changes

Save recordings in your Videos folder:

```yaml
storage:
  recordings: /home/YOUR_USER/Videos/Pixy Arch
```

Turn off call automation:

```yaml
automation:
  enabled: false
```

Keep the lens open at startup:

```yaml
safety:
  start_in_privacy: false
```

Pin the HID node for diagnostics (normally auto-detected):

```yaml
hid:
  path: /dev/hidrawN
```

## Network access

By default the deck listens on `127.0.0.1`, so only this computer can reach it. To reach it from another device on your network, for example to upload packet captures from a Windows machine:

```yaml
server:
  host: 0.0.0.0
  port: 8000
```

Then open `http://<this-computer's-IP>:8000` on the other device.

> **Warning:** the API has no authentication. While it listens on `0.0.0.0`, anyone on your network can view the live camera, record, move the camera, unmute the microphone, and change settings. Only do this on a network you trust, block the port in your firewall for untrusted networks, and switch back to `127.0.0.1` when you're done.

Browsers must reach the deck through an IP address, `localhost`, or this computer's hostname (including `<hostname>.local`). Any other name, such as a reverse-proxy domain, has to be listed in `server.allowed_hosts`. This protects against DNS rebinding attacks. `["*"]` turns the check off; only use it behind a reverse proxy that enforces its own access control.

## Developer mode

Developer mode is only for working on Pixy Arch itself: the backend runs on `127.0.0.1:8000` and Vite serves the UI with hot reload on `127.0.0.1:5173`. See [CONTRIBUTING.md](../CONTRIBUTING.md).
