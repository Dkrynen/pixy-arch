import asyncio
import os
import threading
import time
from pathlib import Path

import pytest
from pydantic import ValidationError

import pixypilot.domains.automation.service as automation_module
from pixypilot.domains.audio.models import AudioStatus
from pixypilot.domains.automation.models import AutomationSettings
from pixypilot.domains.automation.service import AutomationService, _load_settings, _scan_holders
from pixypilot.domains.settings.service import SettingsService
from pixypilot.domains.pixy_hid.models import PixyHidRawQueryResult, PixyHidStatus


def test_scan_holders_finds_own_open_char_device(tmp_path) -> None:
    fd = os.open("/dev/null", os.O_RDONLY)
    try:
        rdev = os.fstat(fd).st_rdev
        holders = _scan_holders(rdev, exclude=set())
    finally:
        os.close(fd)
    assert "pytest" in holders or "python" in holders


def test_scan_holders_respects_exclude_list() -> None:
    fd = os.open("/dev/null", os.O_RDONLY)
    try:
        rdev = os.fstat(fd).st_rdev
        import sys

        holders = _scan_holders(rdev, exclude={os.path.basename(sys.argv[0]) or "pytest", "pytest", "python", "python3"})
    finally:
        os.close(fd)
    assert all("pytest" not in h and "python" not in h for h in holders)


def test_scan_holders_skips_own_pid() -> None:
    # A child process holding /dev/null under a unique comm is counted unless
    # its pid is passed as self_pid — the watcher ignores its own process so
    # PixyPilot's own preview/probe fds never look like a call.
    import subprocess

    child = subprocess.Popen(
        ["bash", "-c", "echo pxtesthold > /proc/self/comm; exec 9</dev/null; sleep 30 & wait"]
    )
    try:
        rdev = os.stat("/dev/null").st_rdev
        for _ in range(200):
            if "pxtesthold" in _scan_holders(rdev, exclude=set()):
                break
            time.sleep(0.05)
        assert "pxtesthold" in _scan_holders(rdev, exclude=set())
        assert "pxtesthold" not in _scan_holders(rdev, exclude=set(), self_pid=child.pid)
    finally:
        child.terminate()
        child.wait()


def test_scan_holders_always_ignores_pipewire_and_wireplumber() -> None:
    fd = os.open("/dev/null", os.O_RDONLY)
    try:
        rdev = os.fstat(fd).st_rdev
        # Even with an empty user exclude list the enumerators never count.
        holders = _scan_holders(rdev, exclude=set())
        assert "pipewire" not in holders
        assert "wireplumber" not in holders
    finally:
        os.close(fd)


class _FakeHidService:
    def __init__(self, mode: str = "privacy", writable: bool = True) -> None:
        self.mode = mode
        self.writable = writable
        self.writes: list[str] = []

    async def status(self) -> PixyHidStatus:
        return PixyHidStatus(
            available=True,
            path="/dev/hidraw0",
            readable=True,
            writable=self.writable,
            reason=None,
            known_controls=[],
        )

    async def query_raw(self, name: str) -> PixyHidRawQueryResult:
        raw = {"off": 0, "tracking": 1, "privacy": 2}[self.mode]
        frame = bytes([0x09, 0x01, 0x01, 0x01, 0x00, 0x01, 0x00, 0x01, raw] + [0] * 23)
        return PixyHidRawQueryResult(
            name="tracking_state",
            request_hex="09 01",
            response_hex=" ".join(f"{b:02x}" for b in frame),
            value_index=8,
            raw_value=raw,
            raw_bits=[],
            ascii_value=None,
            ascii_preview=None,
            path="/dev/hidraw0",
        )

    async def set_tracking(self, mode: str) -> None:
        self.mode = mode
        self.writes.append(mode)


class _FakeAudioService:
    def __init__(self, muted: bool | None = True, available: bool = True) -> None:
        self.muted = muted
        self.available = available
        self.mute_calls: list[bool] = []

    async def status(self) -> AudioStatus:
        return AudioStatus(available=self.available, muted=self.muted)

    async def set_mute(self, muted: bool) -> None:
        self.mute_calls.append(muted)
        self.muted = muted


def _wire(service: AutomationService, monkeypatch, hid: _FakeHidService, audio: _FakeAudioService) -> None:
    monkeypatch.setattr(automation_module, "get_pixy_hid_service", lambda: hid)
    monkeypatch.setattr(automation_module, "get_audio_service", lambda: audio)


async def test_on_open_unmutes_muted_mic_and_close_reverts(monkeypatch) -> None:
    hid = _FakeHidService(mode="privacy")
    audio = _FakeAudioService(muted=True)
    service = AutomationService()
    service.settings = AutomationSettings(on_close="previous")
    _wire(service, monkeypatch, hid, audio)

    await service._on_open()

    assert audio.mute_calls == [False]
    assert service._mic_unmuted is True
    assert hid.writes == ["tracking"]
    assert service._saved_mode == "privacy"
    assert service._last_action == "call-start:tracking+unmute"

    await service._on_close()

    assert audio.mute_calls == [False, True]
    assert service._mic_unmuted is False
    assert hid.writes == ["tracking", "privacy"]
    assert service._last_action == "call-end:restore-privacy+remute"


async def test_on_close_does_not_remute_when_mic_was_already_live(monkeypatch) -> None:
    # Restore only what automation changed: a mic that was already unmuted
    # before the call must not be muted on call end.
    hid = _FakeHidService(mode="off")
    audio = _FakeAudioService(muted=False)
    service = AutomationService()
    _wire(service, monkeypatch, hid, audio)

    await service._on_open()

    assert audio.mute_calls == []
    assert service._mic_unmuted is False
    assert service._last_action == "call-start:tracking"

    await service._on_close()

    assert audio.mute_calls == []
    assert service._last_action == "call-end:privacy"


async def test_unmute_mic_disabled_leaves_audio_alone(monkeypatch) -> None:
    hid = _FakeHidService(mode="privacy")
    audio = _FakeAudioService(muted=True)
    service = AutomationService()
    service.settings = AutomationSettings(unmute_mic=False)
    _wire(service, monkeypatch, hid, audio)

    await service._on_open()
    await service._on_close()

    assert audio.mute_calls == []
    assert service._mic_unmuted is False


async def test_stop_restores_automation_unmute(monkeypatch) -> None:
    hid = _FakeHidService(mode="privacy")
    audio = _FakeAudioService(muted=True)
    service = AutomationService()
    _wire(service, monkeypatch, hid, audio)

    await service._on_open()
    assert service._mic_unmuted is True

    await service.stop()

    assert audio.mute_calls == [False, True]
    assert service._mic_unmuted is False


async def test_on_open_skips_hid_actions_when_unwritable_but_still_unmutes(monkeypatch) -> None:
    hid = _FakeHidService(mode="privacy", writable=False)
    audio = _FakeAudioService(muted=True)
    service = AutomationService()
    _wire(service, monkeypatch, hid, audio)

    await service._on_open()

    assert hid.writes == []
    assert audio.mute_calls == [False]
    assert service._last_action == "call-start:skipped-hid-unwritable+unmute"


async def test_status_exposes_mic_unmuted_and_settings(monkeypatch) -> None:
    hid = _FakeHidService(mode="privacy")
    audio = _FakeAudioService(muted=True)
    service = AutomationService()
    _wire(service, monkeypatch, hid, audio)

    await service._on_open()
    status = await service.status()

    assert status.mic_unmuted is True
    assert status.settings.unmute_mic is True
    assert status.last_action == "call-start:tracking+unmute"


def test_scan_all_holders_merges_sink_consumers(monkeypatch, tmp_path) -> None:
    # Call apps read the loopback sink, not the physical node — a consumer on
    # the sink's rdev must count as a call holder or automation never fires.
    import unittest.mock as mock

    service = AutomationService()
    service.settings = AutomationSettings(video_device="/dev/video0")
    scanned: list[int] = []

    def fake_scan(rdev, exclude, self_pid=None, sink_arg=None):
        scanned.append(rdev)
        return ["obs"] if rdev == 222 else []

    def fake_stat(path, *args, **kwargs):
        result = mock.Mock()
        result.st_rdev = 111 if str(path) == "/dev/video0" else 222
        return result

    monkeypatch.setattr(automation_module, "_scan_holders", fake_scan)
    monkeypatch.setattr(automation_module.os, "stat", fake_stat)

    holders = service._scan_all_holders(Path("/dev/video10"), b"/dev/video10")

    assert holders == ["obs"]
    assert scanned == [111, 222]


def test_scan_all_holders_empty_when_sink_matches_source(monkeypatch) -> None:
    import unittest.mock as mock

    service = AutomationService()
    service.settings = AutomationSettings(video_device="/dev/video0")
    scanned: list[int] = []

    monkeypatch.setattr(
        automation_module,
        "_scan_holders",
        lambda rdev, exclude, self_pid=None, sink_arg=None: scanned.append(rdev) or [],
    )
    monkeypatch.setattr(
        automation_module.os,
        "stat",
        lambda path, *a, **k: mock.Mock(st_rdev=111),
    )

    holders = service._scan_all_holders(Path("/dev/video0"), b"/dev/video0")

    assert holders == []
    assert scanned == [111]


def test_is_sink_writer_detects_ffmpeg_loopback_feeder(tmp_path) -> None:
    from pixypilot.domains.automation.service import _is_sink_writer

    pid_dir = tmp_path / "1234"
    pid_dir.mkdir()
    sink = b"/dev/video10"

    # ffmpeg producer writing to the sink is our own feeder, not a call
    (pid_dir / "cmdline").write_bytes(b"/usr/bin/ffmpeg\0-f\0v4l2\0-i\0/dev/video0\0/dev/video10\0")
    assert _is_sink_writer(pid_dir, sink) is True

    # same shape via PATH-resolved name
    (pid_dir / "cmdline").write_bytes(b"ffmpeg\0-i\0/dev/video0\0/dev/video10\0")
    assert _is_sink_writer(pid_dir, sink) is True

    # a non-ffmpeg process holding the camera still counts as a call
    (pid_dir / "cmdline").write_bytes(b"obs\0--scene\0/dev/video0\0")
    assert _is_sink_writer(pid_dir, sink) is False

    # ffmpeg reading a different device is a consumer, not our feeder
    (pid_dir / "cmdline").write_bytes(b"ffmpeg\0-i\0/dev/video10\0out.mp4\0")
    assert _is_sink_writer(pid_dir, sink) is False

    # no sink configured → nothing is excluded
    assert _is_sink_writer(pid_dir, None) is False


def test_poll_interval_is_bounded() -> None:
    with pytest.raises(ValidationError):
        AutomationSettings(poll_seconds=0.1)
    with pytest.raises(ValidationError):
        AutomationSettings(poll_seconds=0)
    assert AutomationSettings(poll_seconds=0.5).poll_seconds == 0.5


def test_invalid_config_values_fall_back_to_defaults() -> None:
    # A hand-edited config must not stop the backend from importing.
    settings = _load_settings({"poll_seconds": 0.01, "on_close": "previous", "video_device": "/etc/passwd"})

    assert settings.poll_seconds == 1.0
    assert settings.video_device == "auto"
    assert settings.on_close == "previous"


def test_video_device_accepts_auto_or_video_nodes() -> None:
    assert AutomationSettings().video_device == "auto"
    assert AutomationSettings(video_device="").video_device == "auto"
    assert AutomationSettings(video_device="AUTO").video_device == "auto"
    assert AutomationSettings(video_device="/dev/video2").video_device == "/dev/video2"
    with pytest.raises(ValidationError):
        AutomationSettings(video_device="/dev/hidraw0")


def test_auto_device_watches_pixy_capture_node(monkeypatch) -> None:
    import unittest.mock as mock

    service = AutomationService()
    service.settings = AutomationSettings()
    stat_calls: list[str] = []
    monkeypatch.setattr(automation_module, "_find_source_device", lambda: Path("/dev/video2"))
    monkeypatch.setattr(automation_module, "_still_pixy_node", lambda device: True)
    monkeypatch.setattr(
        automation_module.os,
        "stat",
        lambda path, *a, **k: stat_calls.append(str(path)) or mock.Mock(st_rdev=5),
    )
    monkeypatch.setattr(
        automation_module, "_scan_holders", lambda rdev, exclude, self_pid=None, sink_arg=None: ["zoom"]
    )

    assert service._scan_all_holders(None, None) == ["zoom"]  # noqa: SLF001
    assert stat_calls == ["/dev/video2"]


def test_auto_device_without_pixy_watches_nothing(monkeypatch) -> None:
    service = AutomationService()
    service.settings = AutomationSettings()
    monkeypatch.setattr(automation_module, "_find_source_device", lambda: None)

    def fail_stat(*_args, **_kwargs):
        raise AssertionError("no device should be inspected, not even /dev/video0")

    monkeypatch.setattr(automation_module.os, "stat", fail_stat)

    assert service._scan_all_holders(Path("/dev/video10"), b"/dev/video10") == []  # noqa: SLF001


def test_auto_device_resolution_is_cached_while_node_is_still_pixy(monkeypatch) -> None:
    service = AutomationService()
    service.settings = AutomationSettings()
    lookups: list[int] = []
    monkeypatch.setattr(
        automation_module, "_find_source_device", lambda: lookups.append(1) or Path("/dev/video2")
    )
    monkeypatch.setattr(automation_module, "_still_pixy_node", lambda device: True)

    assert service._resolve_video_device() == Path("/dev/video2")  # noqa: SLF001
    assert service._resolve_video_device() == Path("/dev/video2")  # noqa: SLF001
    assert len(lookups) == 1

    monkeypatch.setattr(automation_module, "_still_pixy_node", lambda device: False)
    service._resolve_video_device()  # noqa: SLF001
    assert len(lookups) == 2


async def test_watch_loop_scans_proc_off_the_event_loop(monkeypatch) -> None:
    service = AutomationService()
    service.settings = AutomationSettings(poll_seconds=0.5)
    scanned_on: list[threading.Thread] = []
    scanned = asyncio.Event()
    loop = asyncio.get_running_loop()

    def fake_scan(sink, sink_arg):
        scanned_on.append(threading.current_thread())
        loop.call_soon_threadsafe(scanned.set)
        return []

    monkeypatch.setattr(automation_module, "_find_loopback_device", lambda: None)
    monkeypatch.setattr(service, "_scan_all_holders", fake_scan)
    task = asyncio.create_task(service._watch_loop())  # noqa: SLF001
    try:
        await asyncio.wait_for(scanned.wait(), timeout=2)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert scanned_on and scanned_on[0] is not threading.main_thread()


async def test_apply_settings_persists_to_config_file(tmp_path, monkeypatch) -> None:
    settings_path = tmp_path / "config" / "pixypilot.yaml"
    settings_path.parent.mkdir()
    settings_path.write_text("safety:\n  start_in_privacy: true\n", encoding="utf-8")
    service = AutomationService(settings_service=SettingsService(settings_path))

    status = await service.apply_settings(AutomationSettings(enabled=False, poll_seconds=2.0))

    import yaml

    saved = yaml.safe_load(settings_path.read_text(encoding="utf-8"))
    assert saved["safety"] == {"start_in_privacy": True}
    assert saved["automation"]["enabled"] is False
    assert saved["automation"]["poll_seconds"] == 2.0
    assert saved["automation"]["video_device"] == "auto"
    assert status.running is False
    assert status.settings.enabled is False


async def test_apply_settings_leaves_runtime_alone_when_save_fails(tmp_path) -> None:
    settings_path = tmp_path / "pixypilot.yaml"
    settings_path.write_text("automation: [broken\n", encoding="utf-8")
    service = AutomationService(settings_service=SettingsService(settings_path))
    before = service.settings

    with pytest.raises(ValueError):
        await service.apply_settings(AutomationSettings(enabled=False))

    assert service.settings is before


async def test_automation_route_reports_unsaved_settings(tmp_path) -> None:
    import httpx
    from fastapi import FastAPI

    from pixypilot.api.routes import router
    from pixypilot.domains.automation.service import get_automation_service

    settings_path = tmp_path / "pixypilot.yaml"
    settings_path.write_text("- not a mapping\n", encoding="utf-8")
    service = AutomationService(settings_service=SettingsService(settings_path))
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_automation_service] = lambda: service

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as client:
        rejected = await client.patch("/api/automation/settings", json={"poll_seconds": 0.1})
        failed = await client.patch("/api/automation/settings", json={"enabled": False})

    assert rejected.status_code == 422
    assert failed.status_code == 500
    assert "could not be saved" in failed.json()["detail"]
