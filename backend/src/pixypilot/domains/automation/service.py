import asyncio
import os
import stat
import time
from pathlib import Path

from pixypilot.config import automation_config
from pixypilot.domains.automation.models import AutomationSettings, AutomationStatus
from pixypilot.domains.pixy_hid.models import TrackingMode
from pixypilot.domains.pixy_hid.service import PixyHidService, _hex_to_bytes, _parse_tracking_response, get_pixy_hid_service


def _scan_holders(rdev: int, exclude: set[str]) -> list[str]:
    holders: set[str] = set()
    for pid_dir in Path("/proc").iterdir():
        if not pid_dir.name.isdigit():
            continue
        try:
            comm = (pid_dir / "comm").read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if comm in exclude:
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
                holders.add(comm)
                break
    return sorted(holders)


class AutomationService:
    # Edge-triggered only: no HID traffic is generated while the camera state
    # is stable, so the watcher never resets firmware timers or interferes
    # with the stream.
    def __init__(self) -> None:
        self.settings = AutomationSettings(**automation_config())
        self._task: asyncio.Task | None = None
        self._camera_in_use = False
        self._holders: list[str] = []
        self._saved_mode: TrackingMode | None = None
        self._last_action: str | None = None

    async def status(self) -> AutomationStatus:
        return AutomationStatus(
            running=self._task is not None and not self._task.done(),
            camera_in_use=self._camera_in_use,
            holders=self._holders,
            saved_mode=self._saved_mode,
            last_action=self._last_action,
            settings=self.settings,
        )

    async def apply_settings(self, settings: AutomationSettings) -> AutomationStatus:
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

    async def _watch_loop(self) -> None:
        idle_since: float | None = None
        while True:
            try:
                rdev = os.stat(self.settings.video_device).st_rdev
                self._holders = _scan_holders(rdev, set(self.settings.exclude_processes))
            except OSError:
                self._holders = []
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

    async def _hid(self) -> PixyHidService | None:
        service = get_pixy_hid_service()
        status = await service.status()
        return service if status.writable else None

    async def _on_open(self) -> None:
        if self.settings.on_open == "none":
            return
        service = await self._hid()
        if service is None:
            self._last_action = "call-start:skipped-hid-unwritable"
            return
        try:
            state = await service.query_raw("tracking_state")
            self._saved_mode = _parse_tracking_response(_hex_to_bytes(state.response_hex))
            if self.settings.on_open == "tracking":
                await service.set_tracking("tracking")
                self._last_action = "call-start:tracking"
        except (FileNotFoundError, PermissionError, OSError):
            self._last_action = "call-start:failed"

    async def _on_close(self) -> None:
        if self.settings.on_close == "none":
            return
        service = await self._hid()
        if service is None:
            self._last_action = "call-end:skipped-hid-unwritable"
            return
        try:
            if self.settings.on_close == "privacy":
                await service.set_tracking("privacy")
                self._last_action = "call-end:privacy"
            elif self.settings.on_close == "previous" and self._saved_mode is not None:
                await service.set_tracking(self._saved_mode)
                self._last_action = f"call-end:restore-{self._saved_mode}"
        except (FileNotFoundError, PermissionError, OSError):
            self._last_action = "call-end:failed"


_SERVICE = AutomationService()


def get_automation_service() -> AutomationService:
    return _SERVICE
