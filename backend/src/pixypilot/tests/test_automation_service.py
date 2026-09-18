import os
import stat
import time
from pathlib import Path

import pixypilot.domains.automation.service as automation_module
from pixypilot.domains.audio.models import AudioStatus
from pixypilot.domains.automation.models import AutomationSettings
from pixypilot.domains.automation.service import AutomationService, _scan_holders
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
        import sys

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
