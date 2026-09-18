import asyncio
import os
from pathlib import Path

import pytest

import pixypilot.domains.virtualcam.service as vcam_module
from pixypilot.domains.virtualcam.models import (
    VirtualCamStartRequest,
    VirtualCamTransform,
    normalize_input_format,
)
from pixypilot.domains.virtualcam.service import (
    VirtualCamService,
    _read_sink_format,
    _scan_sink_holders,
    build_ffmpeg_command,
    build_filter_chain,
)


def test_filter_chain_defaults_to_scale_only() -> None:
    assert build_filter_chain(VirtualCamTransform(), 1920, 1080) == "scale=1920:1080"


def test_filter_chain_orders_mirror_rotate_zoom() -> None:
    transform = VirtualCamTransform(mirror=True, rotate=90, zoom=2.0)
    assert build_filter_chain(transform, 1080, 1920) == "hflip,transpose=1,crop=iw/2:ih/2,scale=1080:1920"


def test_filter_chain_180_uses_double_flip() -> None:
    transform = VirtualCamTransform(rotate=180)
    assert build_filter_chain(transform, 1920, 1080) == "hflip,vflip,scale=1920:1080"


def test_ffmpeg_command_uses_mjpeg_in_yuyv_out() -> None:
    request = VirtualCamStartRequest(transform=VirtualCamTransform(mirror=True))
    command = build_ffmpeg_command(request, "/dev/video0", "/dev/video10")
    assert command[command.index("-input_format") + 1] == "mjpeg"
    assert command[command.index("-pix_fmt") + 1] == "yuyv422"
    assert "/dev/video10" in command
    # The MJPEG preview tap is a second output: frames copy to stdout so the
    # in-app preview never occupies the loopback's single reader slot.
    assert command[-4:] == ["-f", "mjpeg", "pipe:1"] or command[-2:] == ["mjpeg", "pipe:1"]
    assert "hflip" in command[command.index("-vf") + 1]


def test_ffmpeg_command_tap_copies_mjpeg_and_encodes_raw() -> None:
    mjpeg_cmd = build_ffmpeg_command(
        VirtualCamStartRequest(input_format="MJPG"), "/dev/video0", "/dev/video10"
    )
    tap_codec = mjpeg_cmd[len(mjpeg_cmd) - 1 - mjpeg_cmd[::-1].index("-c:v") + 1]
    assert tap_codec == "copy"
    raw_cmd = build_ffmpeg_command(
        VirtualCamStartRequest(input_format="YUYV"), "/dev/video0", "/dev/video10"
    )
    assert raw_cmd[len(raw_cmd) - 1 - raw_cmd[::-1].index("-c:v") + 1] == "mjpeg"


def test_input_format_accepts_v4l2_fourcc() -> None:
    request = VirtualCamStartRequest(input_format="YUYV")
    command = build_ffmpeg_command(request, "/dev/video0", "/dev/video10")
    assert command[command.index("-input_format") + 1] == "yuyv422"


def test_normalize_input_format_maps_known_fourccs() -> None:
    assert normalize_input_format("MJPG") == "mjpeg"
    assert normalize_input_format("mjpeg") == "mjpeg"
    assert normalize_input_format("YUYV") == "yuyv422"
    assert normalize_input_format("NV12") == "nv12"
    # Unknown but well-formed names pass through so ffmpeg decides.
    assert normalize_input_format("h264") == "h264"


def test_input_format_rejects_garbage() -> None:
    with pytest.raises(ValueError):
        VirtualCamStartRequest(input_format="rm -rf /")
    with pytest.raises(ValueError):
        VirtualCamStartRequest(input_format="")


class FakeProcess:
    def __init__(self, returncode: int | None = None) -> None:
        self.returncode = returncode
        self.pid = 4242
        self.signals: list[int] = []

    def send_signal(self, sig) -> None:
        self.signals.append(sig)
        self.returncode = 0

    def kill(self) -> None:
        self.returncode = -9

    async def wait(self) -> None:
        return None


async def immediate_to_thread(func, /, *args, **kwargs):
    return func(*args, **kwargs)


async def no_sleep(_seconds) -> None:
    return None


def _patch_device_lookup(monkeypatch, tmp_path) -> tuple[Path, Path]:
    sink = tmp_path / "video10"
    source = tmp_path / "video0"
    sink.touch()
    source.touch()
    monkeypatch.setattr(vcam_module, "_find_loopback_device", lambda: sink)
    monkeypatch.setattr(vcam_module, "_find_source_device", lambda: source)
    monkeypatch.setattr(vcam_module, "_scan_sink_holders", lambda *_args, **_kwargs: (0, None))
    monkeypatch.setattr(vcam_module.asyncio, "to_thread", immediate_to_thread)
    monkeypatch.setattr(vcam_module.asyncio, "sleep", no_sleep)
    return source, sink


async def test_start_surfaces_missing_ffmpeg(monkeypatch, tmp_path) -> None:
    _patch_device_lookup(monkeypatch, tmp_path)

    async def missing_exec(*args, **kwargs):
        raise FileNotFoundError("ffmpeg")

    monkeypatch.setattr(vcam_module.asyncio, "create_subprocess_exec", missing_exec)
    service = VirtualCamService()

    result = await service.start(VirtualCamStartRequest())

    assert result.ok is False
    assert result.running is False
    assert result.reason == "ffmpeg is not installed or not on PATH"
    # The failure must also be visible afterwards through status.last_error.
    status = await service.status()
    assert status.last_error == result.reason


async def test_start_surfaces_early_ffmpeg_exit(monkeypatch, tmp_path) -> None:
    _patch_device_lookup(monkeypatch, tmp_path)

    async def dead_exec(*args, **kwargs):
        stderr = kwargs.get("stderr")
        if stderr is not None:
            stderr.write(b"Error opening input: Device or resource busy")
            stderr.flush()
        return FakeProcess(returncode=1)

    monkeypatch.setattr(vcam_module.asyncio, "create_subprocess_exec", dead_exec)
    service = VirtualCamService()

    result = await service.start(VirtualCamStartRequest())

    assert result.ok is False
    assert "ffmpeg exited immediately" in (result.reason or "")
    assert "Device or resource busy" in (result.reason or "")
    assert service._last_error == result.reason  # noqa: SLF001


async def test_start_reports_running_after_success(monkeypatch, tmp_path) -> None:
    source, sink = _patch_device_lookup(monkeypatch, tmp_path)

    async def live_exec(*args, **kwargs):
        return FakeProcess()

    monkeypatch.setattr(vcam_module.asyncio, "create_subprocess_exec", live_exec)
    service = VirtualCamService()

    result = await service.start(
        VirtualCamStartRequest(input_width=1280, input_height=720, output_width=1280, output_height=720)
    )

    assert result.ok is True
    assert result.running is True
    assert result.pid == 4242
    assert result.source_device == str(source)

    status = await service.status()
    assert status.running is True
    assert status.source_device == str(source)
    assert status.output_width == 1280
    assert status.output_height == 720
    assert status.fps == 30.0


async def test_second_start_refuses_while_running(monkeypatch, tmp_path) -> None:
    _patch_device_lookup(monkeypatch, tmp_path)

    async def live_exec(*args, **kwargs):
        return FakeProcess()

    monkeypatch.setattr(vcam_module.asyncio, "create_subprocess_exec", live_exec)
    service = VirtualCamService()
    await service.start(VirtualCamStartRequest())

    result = await service.start(VirtualCamStartRequest())

    assert result.ok is False
    assert result.running is True
    assert "already running" in (result.reason or "")


async def test_start_ignores_stale_orphan_pid(monkeypatch, tmp_path) -> None:
    _patch_device_lookup(monkeypatch, tmp_path)
    spawned = FakeProcess()

    async def live_exec(*args, **kwargs):
        return spawned

    monkeypatch.setattr(vcam_module.asyncio, "create_subprocess_exec", live_exec)
    service = VirtualCamService()
    service._orphan_pid = 99999999  # noqa: SLF001 - dead writer from an earlier poll

    result = await service.start(VirtualCamStartRequest())

    assert result.ok is True
    assert service._orphan_pid is None  # noqa: SLF001


async def test_start_fails_without_sink(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(vcam_module, "_find_loopback_device", lambda: None)
    service = VirtualCamService()

    result = await service.start(VirtualCamStartRequest())

    assert result.ok is False
    assert "v4l2loopback" in (result.reason or "")


async def test_status_reaps_dead_ffmpeg_into_last_error(monkeypatch, tmp_path) -> None:
    # No loopback visible: keeps this test off the real /dev/video10.
    monkeypatch.setattr(vcam_module, "_find_loopback_device", lambda: None)
    service = VirtualCamService()
    log = tmp_path / "stderr.log"
    log.write_text("Device or resource busy", encoding="utf-8")
    service._process = FakeProcess(returncode=1)  # noqa: SLF001
    service._stderr_path = str(log)  # noqa: SLF001

    status = await service.status()

    assert status.running is False
    assert status.last_error is not None
    assert "code 1" in status.last_error
    assert "Device or resource busy" in status.last_error
    assert not log.exists()


async def test_stop_clears_running_process(monkeypatch, tmp_path) -> None:
    _patch_device_lookup(monkeypatch, tmp_path)
    spawned = FakeProcess()

    async def live_exec(*args, **kwargs):
        return spawned

    monkeypatch.setattr(vcam_module.asyncio, "create_subprocess_exec", live_exec)
    service = VirtualCamService()
    await service.start(VirtualCamStartRequest())

    result = await service.stop()

    assert result.ok is True
    assert spawned.signals  # SIGINT sent
    status = await service.status()
    assert status.running is False


class FakePump:
    instances: list["FakePump"] = []
    frames_on_start = 0

    def __init__(self, *args, **kwargs) -> None:
        self.frames_pumped = 0
        self._running = False
        self.stopped = False
        FakePump.instances.append(self)

    @property
    def running(self) -> bool:
        return self._running

    async def start(self) -> None:
        self._running = True
        self.frames_pumped = FakePump.frames_on_start

    async def stop(self) -> None:
        self._running = False
        self.stopped = True


def _patch_whiteboard_pump(monkeypatch, frames_on_start: int) -> None:
    import pixypilot.domains.whiteboard.pump as pump_module

    FakePump.instances = []
    FakePump.frames_on_start = frames_on_start
    monkeypatch.setattr(pump_module, "WhiteboardPump", FakePump)


async def test_whiteboard_start_succeeds_once_frames_flow(monkeypatch, tmp_path) -> None:
    _patch_device_lookup(monkeypatch, tmp_path)
    _patch_whiteboard_pump(monkeypatch, frames_on_start=1)
    service = VirtualCamService()

    result = await service.start(VirtualCamStartRequest(pipeline="whiteboard"))

    assert result.ok is True
    assert result.running is True
    status = await service.status()
    assert status.running is True
    assert status.pipeline == "whiteboard"
    assert status.frames == 1


async def test_whiteboard_start_fails_when_no_frames(monkeypatch, tmp_path) -> None:
    _patch_device_lookup(monkeypatch, tmp_path)
    _patch_whiteboard_pump(monkeypatch, frames_on_start=0)
    service = VirtualCamService()

    result = await service.start(VirtualCamStartRequest(pipeline="whiteboard"))

    assert result.ok is False
    assert "no frames" in (result.reason or "")
    assert FakePump.instances[0].stopped is True
    status = await service.status()
    assert status.running is False
    assert status.last_error == result.reason


def test_scan_sink_holders_counts_consumers_and_writer(tmp_path) -> None:
    sink = tmp_path / "video10"
    sink.touch()
    other = tmp_path / "other"
    other.touch()
    proc = tmp_path / "proc"

    def make_pid(name: int, target: Path, argv: list[str]) -> None:
        fd_dir = proc / str(name) / "fd"
        fd_dir.mkdir(parents=True)
        os.symlink(target, fd_dir / "3")
        (proc / str(name) / "cmdline").write_bytes(b"\0".join(a.encode() for a in argv) + b"\0")

    # ffmpeg reader: sink is an -i input, not the last arg -> consumer
    make_pid(99991, sink, ["ffmpeg", "-i", str(sink), "-f", "null", "-"])
    # ffmpeg writer: sink is the final positional arg -> writer
    make_pid(99992, sink, ["ffmpeg", "-f", "v4l2", "-pix_fmt", "yuyv422", str(sink)])
    # OBS-like consumer
    make_pid(99993, sink, ["obs", "--profile", "main"])
    # unrelated process holding another node -> ignored
    make_pid(99994, other, ["ffprobe", str(other)])

    consumers, writer_pid = _scan_sink_holders(sink, proc_root=proc)

    assert writer_pid == 99992
    assert consumers == 2


def test_scan_sink_holders_ignores_enumerators(tmp_path) -> None:
    sink = tmp_path / "video10"
    sink.touch()
    proc = tmp_path / "proc"

    def make_pid(name: int, comm: str, argv: list[str]) -> None:
        fd_dir = proc / str(name) / "fd"
        fd_dir.mkdir(parents=True)
        os.symlink(sink, fd_dir / "3")
        (proc / str(name) / "comm").write_text(comm)
        (proc / str(name) / "cmdline").write_bytes(b"\0".join(a.encode() for a in argv) + b"\0")

    make_pid(99991, "obs", ["obs"])
    make_pid(99992, "pipewire", ["pipewire"])
    make_pid(99993, "wireplumber", ["wireplumber"])
    make_pid(99994, "ffmpeg", ["ffmpeg", "-f", "v4l2", str(sink)])

    consumers, writer_pid = _scan_sink_holders(sink, proc_root=proc)

    assert consumers == 1
    assert writer_pid == 99994


def test_scan_sink_holders_empty_proc(tmp_path) -> None:
    proc = tmp_path / "proc"
    proc.mkdir()
    consumers, writer_pid = _scan_sink_holders(tmp_path / "video10", proc_root=proc)
    assert consumers == 0
    assert writer_pid is None


def test_read_sink_format_missing_device() -> None:
    assert _read_sink_format(Path("/dev/does-not-exist")) is None


def test_is_ffmpeg_sink_writer_shapes() -> None:
    from pixypilot.domains.virtualcam.service import _is_ffmpeg_sink_writer

    sink = b"/dev/video10"
    # Old single-output shape: sink last.
    assert _is_ffmpeg_sink_writer([b"ffmpeg", b"-i", b"/dev/video0", b"/dev/video10"], sink)
    # New two-output shape: preview tap's pipe:1 trails the sink.
    assert _is_ffmpeg_sink_writer(
        [b"ffmpeg", b"-i", b"/dev/video0", b"-f", b"v4l2", b"/dev/video10",
         b"-map", b"0:v", b"-c:v", b"copy", b"-f", b"mjpeg", b"pipe:1"],
        sink,
    )
    # Readers consuming the sink via -i are not writers.
    assert not _is_ffmpeg_sink_writer([b"ffmpeg", b"-i", b"/dev/video10", b"out.mkv"], sink)
    assert not _is_ffmpeg_sink_writer([b"obs", b"/dev/video10"], sink)
    assert not _is_ffmpeg_sink_writer([b"ffmpeg", b"-i", b"/dev/video0"], sink)


async def test_frame_relay_fans_out_latest_frames() -> None:
    from pixypilot.domains.virtualcam.service import FrameRelay

    relay = FrameRelay()
    seen: list[bytes] = []

    async def collect(n: int) -> None:
        async for frame in relay.frames():
            seen.append(frame)
            if len(seen) >= n:
                return

    task = asyncio.create_task(collect(3))
    await asyncio.sleep(0.05)  # let the subscriber park on the condition
    for payload in (b"\xff\xd8one\xff\xd9", b"\xff\xd8two\xff\xd9", b"\xff\xd8three\xff\xd9"):
        await relay.publish(payload)
        await asyncio.sleep(0.01)  # let the subscriber consume before the next
    await asyncio.wait_for(task, timeout=1)
    assert seen == [b"\xff\xd8one\xff\xd9", b"\xff\xd8two\xff\xd9", b"\xff\xd8three\xff\xd9"]


async def test_frame_relay_late_subscriber_gets_latest_only() -> None:
    from pixypilot.domains.virtualcam.service import FrameRelay

    relay = FrameRelay()
    await relay.publish(b"old")
    await relay.publish(b"newest")
    frames = relay.frames()
    assert await asyncio.wait_for(frames.__anext__(), timeout=1) == b"newest"


async def test_frame_relay_close_unblocks_subscribers() -> None:
    from pixypilot.domains.virtualcam.service import FrameRelay

    relay = FrameRelay()
    frames = relay.frames()
    waiter = asyncio.create_task(frames.__anext__())
    await asyncio.sleep(0)
    await relay.close()
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(waiter, timeout=1)


def test_build_relay_record_command_reads_stdin() -> None:
    from pathlib import Path

    from pixypilot.domains.video.service import build_relay_record_command

    command = build_relay_record_command(Path("/tmp/out.mkv"))
    assert command[command.index("-i") + 1] == "pipe:0"
    assert command[command.index("-c:v") + 1] == "copy"
    assert command[-1] == "/tmp/out.mkv"
    # Wall-clock timestamps keep playback speed honest when the camera's
    # real delivery rate drops below the requested fps in low light.
    assert command[command.index("-use_wallclock_as_timestamps") + 1] == "1"
