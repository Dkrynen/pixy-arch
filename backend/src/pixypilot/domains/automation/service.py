import asyncio
import logging
import os
import stat
import time
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from pixypilot.config import AUTOMATION_AUTO_DEVICE, automation_config
from pixypilot.core.commands import CommandError
from pixypilot.domains.audio.service import get_audio_service
from pixypilot.domains.automation.models import AutomationSettings, AutomationStatus
from pixypilot.domains.pixy_hid.models import TrackingMode
from pixypilot.domains.pixy_hid.service import PixyHidService, _hex_to_bytes, _parse_tracking_response, get_pixy_hid_service
from pixypilot.domains.settings.service import SettingsService, get_settings_service
from pixypilot.domains.virtualcam.service import (
    VIDEO4LINUX_SYSFS,
    _find_loopback_device,
    _find_source_device,
)

_LOG = logging.getLogger("pixypilot.automation")

# Always treated as non-call holders regardless of the configured exclude list:
# PipeWire/WirePlumber keep the camera node open for device enumeration, and
# the PixyPilot backend itself (preview streams, probes) is not a call.
_ENUMERATOR_COMMS = {"pipewire", "wireplumber"}


def _is_sink_writer(pid_dir: Path, sink_arg: bytes | None) -> bool:
    """True when the process is an ffmpeg writing to the loopback sink — our
    own virtual-cam feeder holds the camera exclusively but is not a call."""
    if sink_arg is None:
        return False
    try:
        args = [part for part in (pid_dir / "cmdline").read_bytes().split(b"\0") if part]
    except OSError:
        return False
    if not args or not args[0].endswith(b"ffmpeg") or sink_arg not in args[1:]:
        return False
    # The feeder's cmdline may append outputs after the sink (the preview
    # tap's pipe), so the sink is matched anywhere — but a consumer reads
    # the sink via `-i sink`, which makes it a real holder, not the writer.
    for index, part in enumerate(args):
        if part == b"-i" and index + 1 < len(args) and args[index + 1] == sink_arg:
            return False
    return True


def _scan_holders(
    rdev: int,
    exclude: set[str],
    self_pid: int | None = None,
    sink_arg: bytes | None = None,
) -> list[str]:
    holders: set[str] = set()
    ignored = exclude | _ENUMERATOR_COMMS
    for pid_dir in Path("/proc").iterdir():
        if not pid_dir.name.isdigit():
            continue
        if self_pid is not None and int(pid_dir.name) == self_pid:
            continue
        try:
            comm = (pid_dir / "comm").read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if comm in ignored:
            continue
        try:
            fds = list((pid_dir / "fd").iterdir())
        except OSError:
            continue
        for fd in fds:
            try:
                fd_stat = os.stat(fd)
            except OSError:
                continue
            if fd_stat.st_rdev == rdev and stat.S_ISCHR(fd_stat.st_mode):
                if not _is_sink_writer(pid_dir, sink_arg):
                    holders.add(comm)
                break
    return sorted(holders)


def _load_settings(raw: dict[str, Any]) -> AutomationSettings:
    """Settings from the config file. An invalid key falls back to its default
    instead of stopping the backend from starting."""
    try:
        return AutomationSettings.model_validate(raw)
    except ValidationError as exc:
        invalid = {str(error["loc"][0]) for error in exc.errors() if error["loc"]}
        _LOG.warning("ignoring invalid automation settings: %s", ", ".join(sorted(invalid)))
    try:
        return AutomationSettings.model_validate({k: v for k, v in raw.items() if k not in invalid})
    except ValidationError:
        return AutomationSettings()


def _still_pixy_node(device: Path) -> bool:
    try:
        return "pixy" in (VIDEO4LINUX_SYSFS / device.name / "name").read_text(encoding="utf-8").lower()
    except OSError:
        return False


class AutomationService:
    # Edge-triggered only: no HID traffic is generated while the camera state
    # is stable, so the watcher never resets firmware timers or interferes
    # with the stream.
    def __init__(self, settings_service: SettingsService | None = None) -> None:
        self.settings = _load_settings(automation_config())
        self._settings_service = settings_service
        # "auto" resolution is cached: finding the capture node opens each
        # candidate for VIDIOC_QUERYCAP, which is not worth doing every poll.
        self._auto_device: Path | None = None
        self._task: asyncio.Task | None = None
        self._camera_in_use = False
        self._holders: list[str] = []
        self._saved_mode: TrackingMode | None = None
        self._mic_unmuted = False
        self._last_action: str | None = None

    async def status(self) -> AutomationStatus:
        return AutomationStatus(
            running=self._task is not None and not self._task.done(),
            camera_in_use=self._camera_in_use,
            holders=self._holders,
            saved_mode=self._saved_mode,
            mic_unmuted=self._mic_unmuted,
            last_action=self._last_action,
            settings=self.settings,
        )

    async def apply_settings(self, settings: AutomationSettings) -> AutomationStatus:
        # Persist before applying: a user who turns automation off expects it
        # to stay off after a restart. A failed write leaves runtime unchanged.
        store = self._settings_service or get_settings_service()
        store.write_patch({"automation": settings.model_dump(mode="json")})
        self.settings = settings
        if settings.enabled:
            await self.start()
        else:
            await self.stop()
        return await self.status()

    async def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._watch_loop())

    async def stop(self) -> None:
        task = self._task
        self._task = None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        if self._mic_unmuted:
            # The watcher is going away — undo the mic change it made rather
            # than leaving the mic open without a call-end to restore it.
            await self._remute_mic()

    async def _watch_loop(self) -> None:
        idle_since: float | None = None
        sink: Path | None = None
        while True:
            if sink is None:
                # The loopback can appear after the watcher starts (module
                # loaded late); retry until it shows so its writer is
                # never mistaken for a call.
                sink = await asyncio.to_thread(_find_loopback_device)
            sink_arg = str(sink).encode() if sink else None
            # The /proc walk stats every fd of every process: keep it off
            # the event loop so API requests are not stalled each poll.
            self._holders = await asyncio.to_thread(self._scan_all_holders, sink, sink_arg)
            in_use = bool(self._holders)
            now = time.monotonic()
            if in_use:
                idle_since = None
                if not self._camera_in_use:
                    self._camera_in_use = True
                    await self._on_open()
            elif self._camera_in_use:
                if idle_since is None:
                    idle_since = now
                elif now - idle_since >= self.settings.grace_seconds:
                    self._camera_in_use = False
                    idle_since = None
                    await self._on_close()
            await asyncio.sleep(self.settings.poll_seconds)

    def _resolve_video_device(self) -> Path | None:
        configured = self.settings.video_device
        if configured != AUTOMATION_AUTO_DEVICE:
            return Path(configured)
        cached = self._auto_device
        if cached is not None and _still_pixy_node(cached):
            return cached
        # No PIXY attached → watch nothing; /dev/video0 may be another camera.
        self._auto_device = _find_source_device()
        return self._auto_device

    def _scan_all_holders(self, sink: Path | None, sink_arg: bytes | None) -> list[str]:
        device = self._resolve_video_device()
        if device is None:
            return []
        try:
            rdev = os.stat(device).st_rdev
            holders = set(
                _scan_holders(
                    rdev,
                    set(self.settings.exclude_processes),
                    self_pid=os.getpid(),
                    sink_arg=sink_arg,
                )
            )
            if sink is not None:
                # Call apps consume the virtual camera, not the physical
                # node the feeder owns — sink readers are call holders too.
                sink_rdev = os.stat(sink).st_rdev
                if sink_rdev != rdev:
                    holders.update(
                        _scan_holders(
                            sink_rdev,
                            set(self.settings.exclude_processes),
                            self_pid=os.getpid(),
                            sink_arg=sink_arg,
                        )
                    )
            return sorted(holders)
        except OSError:
            return []

    async def _hid(self) -> PixyHidService | None:
        service = get_pixy_hid_service()
        status = await service.status()
        return service if status.writable else None

    async def _on_open(self) -> None:
        parts: list[str] = []
        self._mic_unmuted = False
        if self.settings.on_open != "none":
            service = await self._hid()
            if service is None:
                parts.append("skipped-hid-unwritable")
            else:
                try:
                    state = await service.query_raw("tracking_state")
                    self._saved_mode = _parse_tracking_response(_hex_to_bytes(state.response_hex))
                    if self.settings.on_open == "tracking":
                        await service.set_tracking("tracking")
                        parts.append("tracking")
                except (FileNotFoundError, PermissionError, OSError):
                    parts.append("tracking-failed")
        if self.settings.unmute_mic:
            mic_action = await self._unmute_mic()
            if mic_action:
                parts.append(mic_action)
        if not parts:
            return
        self._last_action = f"call-start:{'+'.join(parts)}"

    async def _on_close(self) -> None:
        parts: list[str] = []
        if self.settings.on_close != "none":
            service = await self._hid()
            if service is None:
                parts.append("skipped-hid-unwritable")
            else:
                try:
                    if self.settings.on_close == "privacy":
                        await service.set_tracking("privacy")
                        parts.append("privacy")
                    elif self.settings.on_close == "previous" and self._saved_mode is not None:
                        await service.set_tracking(self._saved_mode)
                        parts.append(f"restore-{self._saved_mode}")
                except (FileNotFoundError, PermissionError, OSError):
                    parts.append("tracking-failed")
        if self._mic_unmuted:
            # Re-mute only what automation unmuted — user mutes stay untouched.
            parts.append(await self._remute_mic())
        if not parts:
            return
        self._last_action = f"call-end:{'+'.join(parts)}"

    async def _unmute_mic(self) -> str | None:
        try:
            audio = get_audio_service()
            status = await audio.status()
            if not status.available or status.muted is not True:
                # Already live or unknowable — nothing for automation to undo.
                return None
            await audio.set_mute(False)
            self._mic_unmuted = True
            return "unmute"
        except (FileNotFoundError, CommandError, OSError):
            return "unmute-failed"

    async def _remute_mic(self) -> str:
        self._mic_unmuted = False
        try:
            await get_audio_service().set_mute(True)
            return "remute"
        except (FileNotFoundError, CommandError, OSError):
            return "remute-failed"


_SERVICE = AutomationService()


def get_automation_service() -> AutomationService:
    return _SERVICE
