#!/usr/bin/env bash
# Installs the v4l2loopback virtual camera used for EMEET Studio-style
# virtual webcam output (portrait/rotate/zoom/mirror processing).
# Run with sudo:  sudo tools/setup-virtualcam.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Installing v4l2loopback packages (refreshing pacman db first)"
# -y refresh avoids 404s from a stale sync db; --needed skips up-to-date deps.
if ! pacman -Sy --needed --noconfirm dkms v4l2loopback-dkms v4l2loopback-utils; then
    echo "ERROR: pacman failed. Try a full 'sudo pacman -Syu' first, then rerun." >&2
    exit 1
fi

install -m 0644 "$ROOT/deploy/modprobe.d/pixypilot-virtualcam.conf" /etc/modprobe.d/
install -m 0644 "$ROOT/deploy/modules-load.d/pixypilot-virtualcam.conf" /etc/modules-load.d/

echo "==> Building/loading module"
dkms autoinstall
if ! modprobe v4l2loopback video_nr=10 card_label="PixyPilot Virtual" exclusive_caps=1 keep_format=1; then
    echo "ERROR: modprobe failed — DKMS build probably did not succeed for kernel $(uname -r)." >&2
    dkms status >&2
    echo "Check /var/lib/dkms/v4l2loopback/*/build/make.log for the compile error." >&2
    exit 1
fi

echo "Virtual camera ready at /dev/video10 (label: PixyPilot Virtual)"
