#!/usr/bin/env bash
# One-shot system setup for Pixy Arch: camera HID permissions (udev) and the
# v4l2loopback virtual camera.
#
#   sudo tools/setup-all.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILURES=0
UDEV_RULE="70-pixypilot-hid.rules"
LEGACY_UDEV_RULE="70-emeet-pixy.rules"

if [ "$(id -u)" -ne 0 ]; then
    printf 'setup-all: run with sudo: sudo %s\n' "$0" >&2
    exit 1
fi

echo "=== [1/3] udev rule for EMEET PIXY HID ==="
if install -m 0644 "$ROOT/deploy/udev/$UDEV_RULE" "/etc/udev/rules.d/$UDEV_RULE"; then
    # Superseded name from an older installer; drop it so only one rule
    # matches the camera.
    rm -f "/etc/udev/rules.d/$LEGACY_UDEV_RULE"
    if udevadm control --reload-rules && udevadm trigger --subsystem-match=hidraw; then
        echo "udev rule installed and reloaded."
    else
        echo "ERROR: udevadm reload/trigger failed." >&2
        FAILURES=$((FAILURES + 1))
    fi
else
    echo "ERROR: failed to install /etc/udev/rules.d/$UDEV_RULE" >&2
    FAILURES=$((FAILURES + 1))
fi

echo
echo "=== [2/3] v4l2loopback virtual camera ==="
if ! bash "$ROOT/tools/setup-virtualcam.sh"; then
    FAILURES=$((FAILURES + 1))
fi

echo
echo "=== [3/3] verification ==="
found_hid=0
for node in /sys/class/hidraw/hidraw*; do
    [ -e "$node" ] || continue
    if grep -qi 'HID_ID=.*0000328F:000000C0' "$node/device/uevent" 2>/dev/null; then
        echo "EMEET PIXY HID: /dev/$(basename "$node")"
        found_hid=1
    fi
done
[ "$found_hid" -eq 1 ] || echo "NOTE: no EMEET PIXY HID device found (is the camera plugged in?)"
if [ -e /dev/video10 ]; then
    echo "Virtual camera: /dev/video10 ($(cat /sys/class/video4linux/video10/name 2>/dev/null))"
else
    echo "NOTE: /dev/video10 is missing (v4l2loopback not loaded)"
fi

echo
if [ "$FAILURES" -eq 0 ]; then
    echo "SETUP COMPLETE. Unplug and replug the camera so the new permissions apply."
else
    echo "SETUP FINISHED WITH $FAILURES FAILURE(S). Scroll up for errors."
fi
exit "$FAILURES"
