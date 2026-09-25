# Changelog

## Unreleased

### Security
- The API now rejects cross-site browser requests and DNS-rebinding Host headers, so other websites can't control the camera or read the stream.
- Settings changed through the API can no longer point at arbitrary files: file locations the app writes to can only be set in the config file, and device paths are validated.
- Virtual camera requests validate device paths and frame sizes, and packet-capture uploads are capped in size.

### Fixed
- The gimbal can no longer keep moving after the tab closes or loses connection mid-drag: the UI sends heartbeats and the backend stops motion by itself.
- Opening or reloading the deck no longer closes the lens and mutes the mic in the middle of a call.
- Double-clicking Record no longer leaves an untracked recorder running.
- Call automation watches the PIXY itself instead of `/dev/video0`, which is the built-in webcam on most laptops.
- Missing system tools give a clear error instead of an internal server error.
- Many smaller fixes: stale responses when switching devices, the mic gain slider, the mic meter running after the tab closes, and accessible names for controls.
- The deck picks the physical PIXY by default (never the virtual camera) and remembers your choice.
- Recording filenames now include milliseconds (`pixy-arch-<device>-YYYYmmdd-HHMMSS-mmm.mkv`), so quick successive recordings never collide.

### Changed
- The virtual camera is now called "Pixy Arch Virtual". Existing installs keep working with the old "PixyPilot Virtual" name. Rerun `sudo tools/setup-virtualcam.sh` to switch, then pick the new camera in OBS or your meeting app.
- `config/pixypilot.yaml` is no longer tracked by git; it is created from `config/pixypilot.example.yaml`. **Upgrading:** if `git pull` complains about local changes to `config/pixypilot.yaml`, run `cp config/pixypilot.yaml /tmp/pixy.yaml && git checkout -- config/pixypilot.yaml && git pull && cp /tmp/pixy.yaml config/pixypilot.yaml`.
- The desktop entry and systemd unit are templates installed by `tools/install-desktop.sh` and the new `tools/install-service.sh`, so they work from any checkout location. The launcher can start the backend without the service and supports any Chromium-family browser.
- `tools/setup-virtualcam.sh` supports Ubuntu/Debian (apt) as well as Arch (pacman), installs matching kernel headers, and no longer runs a partial pacman upgrade.
