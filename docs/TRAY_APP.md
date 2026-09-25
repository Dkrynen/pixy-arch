# Linux Tray App

Pixy Arch includes an optional tiny tray controller at `tools/pixypilot-tray.py`.

The tray app is intentionally separate from the FastAPI backend so desktop GUI dependencies do not become required for headless/server installs.

## Install

Install the tray's dependencies from your distro (plain `pip install` into the system Python is blocked on current Ubuntu and Arch):

```bash
# Ubuntu / Debian
sudo apt install python3-pystray python3-pil python3-yaml gir1.2-ayatanaappindicator3-0.1

# Arch Linux
sudo pacman -S --needed python-pystray python-pillow python-yaml libappindicator-gtk3
```

GNOME needs the AppIndicator extension to show tray icons.

## Run

Start the Pixy Arch backend first, then run:

```bash
tools/pixypilot-tray.py
```

The tray helper reads the backend host and port from `config/pixypilot.yaml`.

## Current Tray Actions

- Privacy on + mic mute
- Privacy off
- Auto Follow on
- Auto Follow off
- Mic mute
- Mic live
- Load PTZ preset slots 1, 2, and 3

## Next Tray Work

- Package as a `.desktop` autostart entry.
- Show current privacy/mic/tracking state in the menu.
- Add named scene support once the backend has scene apply endpoints.
- Add notifications for camera privacy transitions.
