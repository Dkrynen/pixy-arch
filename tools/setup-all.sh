#!/usr/bin/env bash
# PixyPilot one-shot system setup: udev rule + v4l2loopback virtual camera.
# Usage:  sudo bash tools/setup-all.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILURES=0

echo "=== [1/3] udev rule for EMEET PIXY HID ==="
cat > /etc/udev/rules.d/70-emeet-pixy.rules <<'EOF'
KERNEL=="hidraw*", ATTRS{idVendor}=="328f", ATTRS{idProduct}=="00c0", MODE="0660", TAG+="uaccess"
EOF
if udevadm control --reload && udevadm trigger; then
    echo "udev rule installed and reloaded."
else
    echo "FAIL: udevadm reload/trigger failed."
    FAILURES=$((FAILURES + 1))
fi

echo
echo "=== [2/3] v4l2loopback virtual camera ==="
if bash "$ROOT/tools/setup-virtualcam.sh"; then
    :
else
    FAILURES=$((FAILURES + 1))
fi

echo
echo "=== [3/3] verification ==="
ls -la /dev/hidraw* 2>/dev/null | head -3
if [ -e /dev/video10 ]; then
    echo "/dev/video10 exists"
else
    echo "NOTE: /dev/video10 missing (v4l2loopback not loaded)"
fi

echo
if [ "$FAILURES" -eq 0 ]; then
    echo "SETUP COMPLETE — now unplug and replug the camera."
else
    echo "SETUP FINISHED WITH $FAILURES FAILURE(S) — scroll up for errors."
fi
exit "$FAILURES"
