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
    build_standby_command,
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
    # Standby frames go to the runtime dir: keep them inside the test's tmp.
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    monkeypatch.setattr(vcam_module.asyncio, "to_thread", immediate_to_thread)
    monkeypatch.setattr(vcam_module.asyncio, "sleep", no_sleep)
    # The demand-watch loop sleeps via the patched asyncio.sleep, which would
    # spin forever — ticks are exercised directly instead.
    monkeypatch.setattr(VirtualCamService, "_ensure_demand_watch", lambda self: None)
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


def test_standby_command_feeds_synthetic_frames_to_sink() -> None:
    command = build_standby_command(1920, 1080, 30.0, "/tmp/dark.yuyv", "/dev/video10")
    assert command[:2] == ["ffmpeg", "-hide_banner"]
    assert command[command.index("-f") + 1] == "rawvideo"
    # A canned frame + -stream_loop avoids a per-frame filter graph: a lavfi
    # generator burns ~30% CPU because a loopback never blocks writers.
    assert "-re" in command
    assert "-stream_loop" in command
    assert command[command.index("-i") + 1] == "/tmp/dark.yuyv"
    assert command[command.index("-s") + 1] == "1920x1080"
    assert command[command.index("-pix_fmt") + 1] == "yuyv422"
    assert command[-1] == "/dev/video10"
    # The standby feed must never open the physical camera.
    assert "/dev/video0" not in command


def _patch_on_demand(monkeypatch, grace: float = 8.0) -> None:
    monkeypatch.setattr(vcam_module, "virtualcam_on_demand", lambda *_a, **_k: True)
    monkeypatch.setattr(vcam_module, "virtualcam_idle_grace_seconds", lambda *_a, **_k: grace)


async def test_arm_enters_standby_without_touching_source(monkeypatch, tmp_path) -> None:
    source, sink = _patch_device_lookup(monkeypatch, tmp_path)
    _patch_on_demand(monkeypatch)
    spawned: list[list[str]] = []

    async def fake_exec(*args, **kwargs):
        spawned.append([str(a) for a in args])
        return FakeProcess()

    monkeypatch.setattr(vcam_module.asyncio, "create_subprocess_exec", fake_exec)
    service = VirtualCamService()

    result = await service.arm(VirtualCamStartRequest())

    assert result.ok is True
    assert result.running is False
    assert len(spawned) == 1
    assert "rawvideo" in spawned[0]
    assert str(sink) == spawned[0][-1]
    assert str(source) not in spawned[0]

    status = await service.status()
    assert status.mode == "standby"
    assert status.armed is True
    assert status.running is False
    # The standby writer is ours — it must not be adopted as a foreign orphan.
    assert service._orphan_pid is None  # noqa: SLF001


async def test_demand_tick_goes_live_on_consumer(monkeypatch, tmp_path) -> None:
    source, sink = _patch_device_lookup(monkeypatch, tmp_path)
    _patch_on_demand(monkeypatch)
    spawned: list[list[str]] = []

    async def fake_exec(*args, **kwargs):
        spawned.append([str(a) for a in args])
        return FakeProcess()

    monkeypatch.setattr(vcam_module.asyncio, "create_subprocess_exec", fake_exec)
    service = VirtualCamService()
    await service.arm(VirtualCamStartRequest())
    assert len(spawned) == 1  # standby feeder only

    # An app (OBS) opens the sink: the writer pid reported is our own standby.
    idle_pid = service._idle_process.pid  # noqa: SLF001
    monkeypatch.setattr(
        vcam_module,
        "_scan_sink_holders",
        lambda *_a, **_k: (1, idle_pid),
    )
    await service._demand_tick()  # noqa: SLF001

    assert len(spawned) == 2
    live_cmd = spawned[1]
    assert str(source) in live_cmd and str(sink) in live_cmd
    assert "rawvideo" not in live_cmd
    status = await service.status()
    assert status.mode == "live"
    assert status.running is True


async def test_demand_tick_does_not_stomp_foreign_writer(monkeypatch, tmp_path) -> None:
    _patch_device_lookup(monkeypatch, tmp_path)
    _patch_on_demand(monkeypatch)
    spawned: list[list[str]] = []

    async def fake_exec(*args, **kwargs):
        spawned.append([str(a) for a in args])
        return FakeProcess()

    monkeypatch.setattr(vcam_module.asyncio, "create_subprocess_exec", fake_exec)
    service = VirtualCamService()
    await service.arm(VirtualCamStartRequest())

    # A foreign ffmpeg is already writing the sink and an app reads it:
    # we must not kill someone else's producer to claim the sink.
    monkeypatch.setattr(vcam_module, "_scan_sink_holders", lambda *_a, **_k: (1, 987654))
    await service._demand_tick()  # noqa: SLF001

    assert len(spawned) == 1  # still just the standby feeder
    assert service._process is None  # noqa: SLF001


async def test_demand_tick_returns_to_standby_after_grace(monkeypatch, tmp_path) -> None:
    source, sink = _patch_device_lookup(monkeypatch, tmp_path)
    _patch_on_demand(monkeypatch, grace=0.0)
    spawned: list[list[str]] = []

    async def fake_exec(*args, **kwargs):
        spawned.append([str(a) for a in args])
        return FakeProcess()

    monkeypatch.setattr(vcam_module.asyncio, "create_subprocess_exec", fake_exec)
    service = VirtualCamService()
    await service.start(VirtualCamStartRequest())
    assert service._own_live()  # noqa: SLF001

    # First idle tick only starts the grace clock.
    await service._demand_tick()  # noqa: SLF001
    assert service._own_live()  # noqa: SLF001

    # Second tick with grace=0 drops to standby and releases the camera.
    await service._demand_tick()  # noqa: SLF001
    assert service._own_live() is False  # noqa: SLF001
    assert service._standby_running()  # noqa: SLF001
    status = await service.status()
    assert status.mode == "standby"


async def test_demand_tick_stays_live_while_recording(monkeypatch, tmp_path) -> None:
    _patch_device_lookup(monkeypatch, tmp_path)
    _patch_on_demand(monkeypatch, grace=0.0)

    class RecordingVideoService:
        async def stop_streams(self, *_a, **_k):
            return None

        async def recording_status(self):
            class Status:
                recording = True

            return Status()

    monkeypatch.setattr(vcam_module, "get_video_service", lambda: RecordingVideoService())

    async def fake_exec(*args, **kwargs):
        return FakeProcess()

    monkeypatch.setattr(vcam_module.asyncio, "create_subprocess_exec", fake_exec)
    service = VirtualCamService()
    await service.start(VirtualCamStartRequest())

    await service._demand_tick()  # noqa: SLF001
    await service._demand_tick()  # noqa: SLF001

    assert service._own_live() is True  # noqa: SLF001


async def test_demand_start_failure_recovers_standby_and_backs_off(
    monkeypatch, tmp_path
) -> None:
    _patch_device_lookup(monkeypatch, tmp_path)
    _patch_on_demand(monkeypatch)
    spawned: list[list[str]] = []

    async def fake_exec(*args, **kwargs):
        spawned.append([str(a) for a in args])
        # The live pipeline spawn dies instantly (camera busy); standby
        # spawns succeed.
        if "rawvideo" in args:
            return FakeProcess()
        return FakeProcess(returncode=1)

    monkeypatch.setattr(vcam_module.asyncio, "create_subprocess_exec", fake_exec)
    service = VirtualCamService()
    await service.arm(VirtualCamStartRequest())

    monkeypatch.setattr(vcam_module, "_scan_sink_holders", lambda *_a, **_k: (1, None))
    await service._demand_tick()  # noqa: SLF001

    # Failed demand start re-arms the standby feed so the sink keeps caps.
    assert service._standby_running()  # noqa: SLF001
    assert service._demand_backoff_until > 0  # noqa: SLF001
    spawns_after_failure = len(spawned)

    # Backoff: another tick with consumers present must not respawn ffmpeg.
    await service._demand_tick()  # noqa: SLF001
    assert len(spawned) == spawns_after_failure


async def test_stop_disarms_and_frees_sink(monkeypatch, tmp_path) -> None:
    _patch_device_lookup(monkeypatch, tmp_path)
    _patch_on_demand(monkeypatch)
    spawned_procs: list[FakeProcess] = []

    async def fake_exec(*args, **kwargs):
        proc = FakeProcess()
        spawned_procs.append(proc)
        return proc

    monkeypatch.setattr(vcam_module.asyncio, "create_subprocess_exec", fake_exec)
    service = VirtualCamService()
    await service.arm(VirtualCamStartRequest())
    assert service._standby_running()  # noqa: SLF001

    await service.stop()

    assert service._armed is False  # noqa: SLF001
    assert service._standby_running() is False  # noqa: SLF001
    assert spawned_procs[0].signals  # standby feeder got SIGINT

    # Disarmed: a consumer attach must not restart the pipeline.
    monkeypatch.setattr(vcam_module, "_scan_sink_holders", lambda *_a, **_k: (1, None))
    await service._demand_tick()  # noqa: SLF001
    assert service._process is None  # noqa: SLF001
    assert service._standby_running() is False  # noqa: SLF001


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


@pytest.mark.parametrize(
    "overrides",
    [
        {"sink_device": "/etc/passwd"},
        {"sink_device": "/home/user/.bashrc"},
        {"source_device": "/dev/hidraw0"},
        {"source_device": "/dev/video0\x00"},
        {"output_width": 100000},
        {"output_height": 8},
        {"input_width": 5000},
        {"input_fps": 0.5},
        {"input_fps": 121},
    ],
)
def test_start_request_rejects_unsafe_devices_and_sizes(overrides) -> None:
    with pytest.raises(ValueError):
        VirtualCamStartRequest(**overrides)


def test_start_request_accepts_video_nodes_and_aliases(tmp_path) -> None:
    alias = tmp_path / "by-id-pixy"
    os.symlink("/dev/video2", alias)

    request = VirtualCamStartRequest(source_device=str(alias), sink_device="/dev/video10")

    assert request.source_device == str(alias)
    assert request.sink_device == "/dev/video10"
    assert VirtualCamStartRequest(source_device="", sink_device=None).source_device is None


async def test_start_route_validates_before_arming(monkeypatch) -> None:
    import httpx
    from fastapi import FastAPI

    from pixypilot.api.routes import router
    from pixypilot.domains.virtualcam.service import get_virtualcam_service

    service = VirtualCamService()
    started: list[object] = []

    async def fake_start(request):
        started.append(request)

    monkeypatch.setattr(service, "start", fake_start)
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_virtualcam_service] = lambda: service

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as client:
        response = await client.post("/api/virtualcam/start", json={"sink_device": "/tmp/evil"})

    assert response.status_code == 422
    assert started == []
    assert service._armed_request is None  # noqa: SLF001


def _fake_sysfs(tmp_path: Path, nodes: dict[str, tuple[str, int]]) -> Path:
    sysfs = tmp_path / "video4linux"
    for node, (name, index) in nodes.items():
        (sysfs / node).mkdir(parents=True)
        (sysfs / node / "name").write_text(name + "\n", encoding="utf-8")
        (sysfs / node / "index").write_text(f"{index}\n", encoding="utf-8")
    return sysfs


def _patch_sysfs(monkeypatch, sysfs: Path, caps: dict[str, tuple[str, bool] | None]) -> None:
    monkeypatch.setattr(vcam_module, "VIDEO4LINUX_SYSFS", sysfs)
    monkeypatch.setattr(vcam_module, "virtualcam_device", lambda *_a, **_k: None)
    monkeypatch.setattr(
        vcam_module, "virtualcam_labels", lambda *_a, **_k: ["Pixy Arch Virtual", "PixyPilot Virtual"]
    )
    monkeypatch.setattr(vcam_module, "_query_capabilities", lambda device: caps.get(device.name))


def test_find_source_device_skips_loopback_and_metadata_nodes(monkeypatch, tmp_path) -> None:
    sysfs = _fake_sysfs(
        tmp_path,
        {
            # Lexically first, and "pixy" is in the sink's label: never pick it.
            "video10": ("PixyPilot Virtual", 0),
            "video11": ("Pixy Arch Virtual", 0),
            "video2": ("EMEET PIXY: EMEET PIXY", 0),
            "video3": ("EMEET PIXY: EMEET PIXY", 1),
            "video0": ("Integrated Camera", 0),
        },
    )
    _patch_sysfs(
        monkeypatch,
        sysfs,
        {
            "video10": ("v4l2 loopback", True),
            "video11": ("v4l2 loopback", True),
            "video2": ("uvcvideo", True),
            "video3": ("uvcvideo", False),
            "video0": ("uvcvideo", True),
        },
    )

    assert vcam_module._find_source_device() == Path("/dev/video2")  # noqa: SLF001


def test_find_source_device_orders_nodes_numerically(monkeypatch, tmp_path) -> None:
    # Lexical order would try video10 before video2.
    sysfs = _fake_sysfs(tmp_path, {"video10": ("EMEET PIXY", 0), "video2": ("EMEET PIXY", 0)})
    _patch_sysfs(monkeypatch, sysfs, {"video10": ("uvcvideo", True), "video2": ("uvcvideo", True)})

    assert vcam_module._find_source_device() == Path("/dev/video2")  # noqa: SLF001


def test_find_source_device_falls_back_to_sysfs_index_when_unopenable(monkeypatch, tmp_path) -> None:
    sysfs = _fake_sysfs(tmp_path, {"video4": ("EMEET PIXY", 1), "video5": ("EMEET PIXY", 0)})
    _patch_sysfs(monkeypatch, sysfs, {})

    assert vcam_module._find_source_device() == Path("/dev/video5")  # noqa: SLF001


def test_find_source_device_returns_none_without_pixy(monkeypatch, tmp_path) -> None:
    sysfs = _fake_sysfs(tmp_path, {"video0": ("Integrated Camera", 0), "video10": ("Pixy Arch Virtual", 0)})
    _patch_sysfs(monkeypatch, sysfs, {"video0": ("uvcvideo", True), "video10": ("v4l2 loopback", True)})

    assert vcam_module._find_source_device() is None  # noqa: SLF001


@pytest.mark.parametrize("label", ["Pixy Arch Virtual", "PixyPilot Virtual"])
def test_find_loopback_device_accepts_current_and_legacy_label(monkeypatch, tmp_path, label) -> None:
    sysfs = _fake_sysfs(tmp_path, {"video2": ("EMEET PIXY", 0), "video10": (label, 0)})
    _patch_sysfs(monkeypatch, sysfs, {})

    assert vcam_module._find_loopback_device() == Path("/dev/video10")  # noqa: SLF001


def test_pipeline_commands_never_read_stdin() -> None:
    command = build_ffmpeg_command(VirtualCamStartRequest(), "/dev/video2", "/dev/video10")
    standby = build_standby_command(1920, 1080, 5.0, "/run/frame.yuyv", "/dev/video10")
    assert "-nostdin" in command
    assert "-nostdin" in standby


async def test_standby_frame_lives_in_private_runtime_dir_and_is_built_off_loop(
    monkeypatch, tmp_path
) -> None:
    _patch_device_lookup(monkeypatch, tmp_path)
    offloaded: list[str] = []

    async def recording_to_thread(func, /, *args, **kwargs):
        offloaded.append(func.__name__)
        return func(*args, **kwargs)

    async def fake_exec(*args, **kwargs):
        return FakeProcess()

    monkeypatch.setattr(vcam_module.asyncio, "to_thread", recording_to_thread)
    monkeypatch.setattr(vcam_module.asyncio, "create_subprocess_exec", fake_exec)
    service = VirtualCamService()

    result = await service.arm(VirtualCamStartRequest(output_width=64, output_height=32))

    assert result.ok is True
    frame = Path(service._idle_frame_path)  # noqa: SLF001
    assert frame.parent == tmp_path / "pixypilot"
    assert (frame.parent.stat().st_mode & 0o777) == 0o700
    assert frame.stat().st_size == 64 * 32 * 2
    assert "_write_standby_frame" in offloaded
    await service.stop()
    assert not frame.exists()
