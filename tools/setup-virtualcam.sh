#!/usr/bin/env bash
# Install the v4l2loopback virtual camera ("Pixy Arch Virtual" at
# /dev/video10) that other apps (OBS, browsers, Zoom) can pick as a webcam.
# Supports Arch (pacman) and Ubuntu/Debian (apt).
#
#   sudo tools/setup-virtualcam.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="Pixy Arch Virtual"
VIDEO_NR=10
SINK="/dev/video${VIDEO_NR}"
KERNEL="$(uname -r)"

die() { printf 'setup-virtualcam: ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '==> %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || die "run with sudo: sudo $0"

install_packages() {
    if command -v pacman >/dev/null 2>&1; then
        # Headers must match the running kernel flavour (linux, linux-lts, linux-zen, ...).
        local kernel_pkg
        kernel_pkg="$(pacman -Qqo "/usr/lib/modules/$KERNEL" 2>/dev/null | head -n1)"
        log "Installing v4l2loopback with pacman"
        # No -Sy: a database refresh without a full upgrade is a partial upgrade.
        pacman -S --needed --noconfirm dkms v4l2loopback-dkms v4l2loopback-utils \
            "${kernel_pkg:-linux}-headers" \
            || die "pacman failed. Run 'sudo pacman -Syu', reboot if the kernel was updated, then rerun."
    elif command -v apt-get >/dev/null 2>&1; then
        log "Installing v4l2loopback with apt"
        apt-get update -q || die "apt-get update failed"
        DEBIAN_FRONTEND=noninteractive apt-get install -y v4l2loopback-dkms v4l2loopback-utils \
            "linux-headers-$KERNEL" \
            || die "apt-get failed. On Secure Boot systems DKMS may also ask you to enroll a signing key (MOK) on the next reboot."
    else
        die "unsupported package manager. Install v4l2loopback (DKMS) and its utils for kernel $KERNEL yourself, then rerun."
    fi
}

sink_label() { cat "/sys/class/video4linux/video${VIDEO_NR}/name" 2>/dev/null || true; }

install_packages

install -m 0644 "$ROOT/deploy/modprobe.d/pixypilot-virtualcam.conf" /etc/modprobe.d/
install -m 0644 "$ROOT/deploy/modules-load.d/pixypilot-virtualcam.conf" /etc/modules-load.d/
log "Installed module options (loaded automatically at boot)"

if lsmod | grep -q '^v4l2loopback '; then
    if [ "$(sink_label)" = "$LABEL" ]; then
        log "Virtual camera already loaded at $SINK ($LABEL)"
        exit 0
    fi
    log "Reloading v4l2loopback with the Pixy Arch options"
    modprobe -r v4l2loopback \
        || die "v4l2loopback is in use. Close apps using a virtual camera (OBS, browsers), then rerun."
fi

log "Loading module"
if ! modprobe v4l2loopback; then
    printf 'setup-virtualcam: ERROR: modprobe failed; the DKMS build probably failed for kernel %s.\n' "$KERNEL" >&2
    dkms status >&2 || true
    printf 'Check /var/lib/dkms/v4l2loopback/*/build/make.log for the compile error.\n' >&2
    exit 1
fi

[ -e "$SINK" ] || die "module loaded but $SINK did not appear; is another video device using number $VIDEO_NR?"
log "Virtual camera ready at $SINK (label: $(sink_label))"
