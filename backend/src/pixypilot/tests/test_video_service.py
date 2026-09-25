import asyncio
from pathlib import Path

import pixypilot.domains.video.service as video_service_module
from pixypilot.domains.video.models import VideoStreamSettings
from pixypilot.domains.video.service import VideoService, build_input_args, build_record_command, build_stream_command


class FakeProcess:
    def __init__(self) -> None:
        self.returncode = None
        self.terminated = False
        self.killed = False

    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        self.killed = True

    async def wait(self) -> None:
        self.returncode = 0


class FakeNativeCapture:
    opened = False
    closed = False
    frames: list[bytes | Exception] = [b"\xff\xd8native-frame\xff\xd9"]

    def __init__(self, device_path: str, settings: VideoStreamSettings) -> None:
        self.device_path = device_path
        self.settings = settings
        self.frames = list(FakeNativeCapture.frames)

    def open(self) -> None:
        FakeNativeCapture.opened = True

    def read_frame(self) -> bytes:
        if not self.frames:
            raise RuntimeError("done")
        frame = self.frames.pop(0)
        if isinstance(frame, Exception):
            raise frame
        return frame

    def close(self) -> None:
        FakeNativeCapture.closed = True


async def immediate_to_thread(func, /, *args, **kwargs):
    return func(*args, **kwargs)


def test_video_input_command_maps_v4l2_formats_to_ffmpeg() -> None:
    command = build_input_args(
        "/dev/video0",
        VideoStreamSettings(pixel_format="MJPG", width=1920, height=1080, fps=29.97),
    )

    assert command == [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-f",
        "v4l2",
        "-framerate",
        "29.97",
        "-video_size",
        "1920x1080",
        "-input_format",
        "mjpeg",
        "-i",
        "/dev/video0",
    ]


def test_mjpg_stream_command_copies_jpeg_frames_to_stdout() -> None:
    command = build_stream_command(
        "/dev/video0",
        VideoStreamSettings(pixel_format="MJPG", width=1280, height=720, fps=30),
    )

    assert command[-6:] == ["-an", "-c:v", "copy", "-f", "mjpeg", "pipe:1"]
    assert "mjpeg" in command


def test_uncompressed_stream_command_encodes_mjpeg_to_stdout() -> None:
    command = build_stream_command(
        "/dev/video0",
        VideoStreamSettings(pixel_format="YUYV", width=640, height=480, fps=30),
    )

    assert command[-6:] == ["-an", "-f", "mjpeg", "-q:v", "2", "pipe:1"]
    assert "yuyv422" in command


async def test_mjpg_preview_uses_native_capture(monkeypatch, tmp_path) -> None:
    FakeNativeCapture.opened = False
    FakeNativeCapture.closed = False
    FakeNativeCapture.frames = [b"\xff\xd8native-frame\xff\xd9"]
    monkeypatch.setattr(video_service_module, "NativeMjpegCapture", FakeNativeCapture)
    monkeypatch.setattr(video_service_module.asyncio, "to_thread", immediate_to_thread)
    service = VideoService(tmp_path)

    chunks = [
        chunk
        async for chunk in service.mjpeg_stream(
            "/dev/video0",
            VideoStreamSettings(pixel_format="MJPG", width=1280, height=720, fps=30),
        )
    ]

    assert FakeNativeCapture.opened is True
    assert FakeNativeCapture.closed is True
    assert chunks == [b"--frame\r\nContent-Type: image/jpeg\r\nCache-Control: no-store\r\n\r\n\xff\xd8native-frame\xff\xd9\r\n"]


async def test_mjpg_preview_keeps_native_capture_alive_after_frame_timeout(monkeypatch, tmp_path) -> None:
    FakeNativeCapture.opened = False
    FakeNativeCapture.closed = False
    FakeNativeCapture.frames = [TimeoutError("no frame yet"), b"\xff\xd8native-frame\xff\xd9"]
    monkeypatch.setattr(video_service_module, "NativeMjpegCapture", FakeNativeCapture)
    monkeypatch.setattr(video_service_module.asyncio, "to_thread", immediate_to_thread)
    service = VideoService(tmp_path)

    chunks = [
        chunk
        async for chunk in service.mjpeg_stream(
            "/dev/video0",
            VideoStreamSettings(pixel_format="MJPG", width=1280, height=720, fps=30),
        )
    ]

    assert FakeNativeCapture.opened is True
    assert FakeNativeCapture.closed is True
    assert chunks == [b"--frame\r\nContent-Type: image/jpeg\r\nCache-Control: no-store\r\n\r\n\xff\xd8native-frame\xff\xd9\r\n"]


def test_record_command_writes_matroska_file_without_reencoding() -> None:
    command = build_record_command(
        "/dev/video0",
        VideoStreamSettings(pixel_format="MJPG", width=1280, height=720, fps=60),
        Path("/tmp/pixypilot-test.mkv"),
    )

    assert command[-6:] == ["-an", "-c:v", "copy", "-f", "matroska", "/tmp/pixypilot-test.mkv"]
    assert command[-1] == "/tmp/pixypilot-test.mkv"


def test_record_command_encodes_raw_formats_to_mjpeg() -> None:
    command = build_record_command(
        "/dev/video10",
        VideoStreamSettings(pixel_format="YUYV", width=1920, height=1080, fps=30),
        Path("/tmp/pixypilot-test.mkv"),
    )

    assert command[-8:] == ["-an", "-c:v", "mjpeg", "-q:v", "3", "-f", "matroska", "/tmp/pixypilot-test.mkv"]


async def test_stop_streams_terminates_registered_preview_processes(tmp_path) -> None:
    service = VideoService(tmp_path)
    process = FakeProcess()

    service._stream_processes["/dev/video0"] = [process]  # noqa: SLF001 - verifies stream ownership cleanup.
    await service.stop_streams("/dev/video0")

    assert process.terminated is True
    assert service._stream_processes == {}  # noqa: SLF001 - internal registry should be cleared.


async def test_stop_streams_closes_native_preview_captures(monkeypatch, tmp_path) -> None:
    FakeNativeCapture.closed = False
    monkeypatch.setattr(video_service_module.asyncio, "to_thread", immediate_to_thread)
    service = VideoService(tmp_path)
    capture = FakeNativeCapture("/dev/video0", VideoStreamSettings(pixel_format="MJPG", width=1280, height=720, fps=30))

    service._native_streams["/dev/video0"] = capture  # noqa: SLF001 - verifies native registry cleanup.
    await service.stop_streams("/dev/video0")

    assert FakeNativeCapture.closed is True
    assert service._native_streams == {}  # noqa: SLF001 - internal registry should be cleared.


class DeadOnSpawnProcess(FakeProcess):
    def __init__(self) -> None:
        super().__init__()
        self.returncode = 1


async def test_start_recording_reports_early_ffmpeg_exit(monkeypatch, tmp_path) -> None:
    spawned = DeadOnSpawnProcess()

    async def fake_exec(*args, **kwargs):
        return spawned

    async def no_sleep(_seconds):
        return None

    monkeypatch.setattr(video_service_module.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(video_service_module.asyncio, "sleep", no_sleep)
    service = VideoService(tmp_path)

    try:
        await service.start_recording(
            "video0",
            "/dev/video0",
            VideoStreamSettings(pixel_format="MJPG", width=1280, height=720, fps=30),
        )
    except ValueError as exc:
        assert "ffmpeg exited immediately" in str(exc)
    else:
        raise AssertionError("start_recording should fail when ffmpeg exits on spawn")

    assert service._recording_status.recording is False
    assert service._recording_status.reason is not None
    assert service._recording_process is None


def test_jpeg_frame_end_skips_embedded_thumbnail() -> None:
    # APP1 carries a nested JPEG thumbnail (FFD8..FFD9) — the naive byte scan
    # truncated the outer frame at the thumbnail's EOI.
    from pixypilot.domains.video.service import _jpeg_frame_end

    thumb = b"\xff\xd8THUMB\xff\xd9"
    app1_data = b"Exif\x00\x00" + thumb
    app1 = b"\xff\xe1" + (len(app1_data) + 2).to_bytes(2, "big") + app1_data
    sos_header = b"\xff\xda" + (8).to_bytes(2, "big") + b"SCANH!"
    frame = b"\xff\xd8" + app1 + sos_header + b"entropy\xff\xd9"

    assert _jpeg_frame_end(frame, 0) == len(frame)


def test_jpeg_frame_end_incomplete_returns_minus_one() -> None:
    from pixypilot.domains.video.service import _jpeg_frame_end

    assert _jpeg_frame_end(b"\xff\xd8\xff\xe1\x00\x10partial", 0) == -1
    assert _jpeg_frame_end(b"\xff\xd8", 0) == -1


def test_jpeg_frame_end_handles_progressive_multi_scan() -> None:
    # Progressive JPEGs repeat SOS+entropy; RSTn markers inside entropy are
    # legal and must not terminate the frame early.
    from pixypilot.domains.video.service import _jpeg_frame_end

    sos = b"\xff\xda" + (8).to_bytes(2, "big") + b"SCANH!"
    entropy = b"data\xff\x00stuffed\xff\xd0restart"
    frame = b"\xff\xd8" + sos + entropy + sos + entropy + b"\xff\xd9"

    assert _jpeg_frame_end(frame, 0) == len(frame)


async def test_start_recording_fails_fast_when_relay_is_empty(monkeypatch, tmp_path) -> None:
    async def empty_source():
        await asyncio.sleep(60)
        yield b""  # pragma: no cover — never reached

    monkeypatch.setattr(video_service_module, "RELAY_FIRST_FRAME_TIMEOUT_S", 0.01)
    service = VideoService(tmp_path)

    try:
        await service.start_recording(
            "video0",
            "/dev/video0",
            VideoStreamSettings(pixel_format="MJPG", width=1280, height=720, fps=30),
            frame_source=empty_source(),
        )
    except ValueError as exc:
        assert "not producing frames" in str(exc)
    else:
        raise AssertionError("recording should fail when the relay yields nothing")

    assert service._recording_process is None


async def test_start_recording_keeps_live_process(monkeypatch, tmp_path) -> None:
    spawned = FakeProcess()

    async def fake_exec(*args, **kwargs):
        return spawned

    async def no_sleep(_seconds):
        return None

    monkeypatch.setattr(video_service_module.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(video_service_module.asyncio, "sleep", no_sleep)
    service = VideoService(tmp_path)

    status = await service.start_recording(
        "video0",
        "/dev/video0",
        VideoStreamSettings(pixel_format="MJPG", width=1280, height=720, fps=30),
    )

    assert status.recording is True
    assert service._recording_process is spawned


async def test_start_recording_surfaces_missing_ffmpeg(monkeypatch, tmp_path) -> None:
    async def missing_exec(*args, **kwargs):
        raise FileNotFoundError("ffmpeg")

    monkeypatch.setattr(video_service_module.asyncio, "create_subprocess_exec", missing_exec)
    service = VideoService(tmp_path)

    try:
        await service.start_recording(
            "video0",
            "/dev/video0",
            VideoStreamSettings(pixel_format="MJPG", width=1280, height=720, fps=30),
        )
    except ValueError as exc:
        assert "ffmpeg is not installed" in str(exc)
    else:
        raise AssertionError("start_recording should fail cleanly when ffmpeg is missing")

    assert service._recording_status.recording is False
    assert service._recording_status.reason is not None
    assert service._recording_process is None
    # The temp stderr log must not be left behind.
    assert service._recording_stderr_path is None


async def test_start_recording_slugifies_device_name_in_filename(monkeypatch, tmp_path) -> None:
    spawned = FakeProcess()

    async def fake_exec(*args, **kwargs):
        return spawned

    async def no_sleep(_seconds):
        return None

    monkeypatch.setattr(video_service_module.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(video_service_module.asyncio, "sleep", no_sleep)
    service = VideoService(tmp_path)

    status = await service.start_recording(
        "EMEET PIXY: EMEET PIXY",
        "/dev/video0",
        VideoStreamSettings(pixel_format="MJPG", width=1280, height=720, fps=30),
    )

    assert status.path is not None
    filename = status.path.rsplit("/", 1)[-1]
    assert filename.startswith("pixy-arch-EMEET-PIXY-EMEET-PIXY-")
    assert ":" not in filename and " " not in filename


class ExitedProcess(FakeProcess):
    def __init__(self, returncode: int) -> None:
        super().__init__()
        self.returncode = returncode

    async def wait(self) -> None:
        return None


async def test_reap_finished_recording_reports_exit_code_and_stderr(monkeypatch, tmp_path) -> None:
    service = VideoService(tmp_path)
    process = ExitedProcess(1)
    log = tmp_path / "ffmpeg-stderr.log"
    log.write_text("Device or resource busy", encoding="utf-8")
    service._recording_process = process  # noqa: SLF001
    service._recording_stderr_path = str(log)  # noqa: SLF001
    service._recording_status = service._recording_status.model_copy(  # noqa: SLF001
        update={"recording": True, "device_name": "video0"}
    )

    status = await service.recording_status()

    assert status.recording is False
    assert status.reason is not None
    assert "code 1" in status.reason
    assert "Device or resource busy" in status.reason
    assert not log.exists()


async def test_ffmpeg_stream_spawn_failure_ends_response_cleanly(monkeypatch, tmp_path) -> None:
    async def missing_exec(*args, **kwargs):
        raise FileNotFoundError("ffmpeg")

    monkeypatch.setattr(video_service_module.asyncio, "create_subprocess_exec", missing_exec)
    service = VideoService(tmp_path)

    chunks = [
        chunk
        async for chunk in service.mjpeg_stream(
            "/dev/video0",
            VideoStreamSettings(pixel_format="YUYV", width=640, height=480, fps=30),
        )
    ]

    assert chunks == []
    assert service._stream_processes == {}  # noqa: SLF001


async def test_native_stream_busy_device_ends_response_cleanly(monkeypatch, tmp_path) -> None:
    class BusyCapture(FakeNativeCapture):
        def open(self) -> None:
            raise OSError(16, "Device or resource busy")

    monkeypatch.setattr(video_service_module, "NativeMjpegCapture", BusyCapture)
    service = VideoService(tmp_path)

    chunks = [
        chunk
        async for chunk in service.mjpeg_stream(
            "/dev/video0",
            VideoStreamSettings(pixel_format="MJPG", width=1280, height=720, fps=30),
        )
    ]

    assert chunks == []
    assert service._native_streams == {}  # noqa: SLF001


async def test_reaper_closes_abandoned_native_stream(monkeypatch, tmp_path) -> None:
    FakeNativeCapture.closed = False
    monkeypatch.setattr(video_service_module.asyncio, "to_thread", immediate_to_thread)
    service = VideoService(tmp_path)
    capture = FakeNativeCapture("/dev/video0", VideoStreamSettings(pixel_format="MJPG", width=1280, height=720, fps=30))

    service._native_streams["/dev/video0"] = capture  # noqa: SLF001
    # Simulate a generator abandoned past the staleness cutoff.
    service._stream_progress[capture] = (  # noqa: SLF001
        video_service_module.time.monotonic() - video_service_module.STREAM_STALE_AFTER_S - 1
    )
    await service._reap_stale_streams()  # noqa: SLF001

    assert FakeNativeCapture.closed is True
    assert service._native_streams == {}  # noqa: SLF001
    assert capture not in service._stream_progress  # noqa: SLF001


async def test_reaper_keeps_recently_active_native_stream(monkeypatch, tmp_path) -> None:
    FakeNativeCapture.closed = False
    monkeypatch.setattr(video_service_module.asyncio, "to_thread", immediate_to_thread)
    service = VideoService(tmp_path)
    capture = FakeNativeCapture("/dev/video0", VideoStreamSettings(pixel_format="MJPG", width=1280, height=720, fps=30))

    service._native_streams["/dev/video0"] = capture  # noqa: SLF001
    service._stream_progress[capture] = video_service_module.time.monotonic()  # noqa: SLF001
    await service._reap_stale_streams()  # noqa: SLF001

    assert FakeNativeCapture.closed is False
    assert service._native_streams["/dev/video0"] is capture  # noqa: SLF001


async def test_reaper_terminates_abandoned_ffmpeg_stream(monkeypatch, tmp_path) -> None:
    service = VideoService(tmp_path)
    process = FakeProcess()

    service._stream_processes["/dev/video0"] = [process]  # noqa: SLF001
    service._stream_progress[process] = (  # noqa: SLF001
        video_service_module.time.monotonic() - video_service_module.STREAM_STALE_AFTER_S - 1
    )
    await service._reap_stale_streams()  # noqa: SLF001

    assert process.terminated is True
    assert service._stream_processes == {}  # noqa: SLF001
    assert process not in service._stream_progress  # noqa: SLF001


async def test_loopback_substitute_redirects_when_virtualcam_owns_source(tmp_path) -> None:
    from pixypilot.api.routes import _loopback_substitute
    from pixypilot.domains.virtualcam.models import VirtualCamStatus

    sink = tmp_path / "video10"
    sink.touch()

    class FakeVcam:
        async def status(self):
            return VirtualCamStatus(
                available=True,
                sink_path=str(sink),
                running=True,
                source_device="/dev/video0",
                output_width=1920,
                output_height=1080,
                output_pixel_format="YUYV",
                fps=30.0,
            )

    device, settings = await _loopback_substitute("/dev/video0", FakeVcam())
    assert device == str(sink)
    assert settings is not None
    assert settings.pixel_format == "YUYV"
    assert (settings.width, settings.height) == (1920, 1080)


async def test_loopback_substitute_passes_through_when_virtualcam_idle(tmp_path) -> None:
    from pixypilot.api.routes import _loopback_substitute
    from pixypilot.domains.virtualcam.models import VirtualCamStatus

    class FakeVcam:
        async def status(self):
            return VirtualCamStatus(available=True, sink_path="/dev/video10", running=False)

    device, settings = await _loopback_substitute("/dev/video0", FakeVcam())
    assert device == "/dev/video0"
    assert settings is None


def _mjpg_settings() -> VideoStreamSettings:
    return VideoStreamSettings(pixel_format="MJPG", width=1280, height=720, fps=30)


async def test_concurrent_recording_starts_spawn_one_ffmpeg(monkeypatch, tmp_path) -> None:
    spawned: list[FakeProcess] = []
    release = asyncio.Event()

    async def slow_exec(*args, **kwargs):
        # Yield mid-start so a second start could slip past the running check.
        await release.wait()
        process = FakeProcess()
        spawned.append(process)
        return process

    async def fast_sleep(_seconds):
        return None

    monkeypatch.setattr(video_service_module.asyncio, "create_subprocess_exec", slow_exec)
    service = VideoService(tmp_path)
    first = asyncio.create_task(service.start_recording("video0", "/dev/video0", _mjpg_settings()))
    second = asyncio.create_task(service.start_recording("video0", "/dev/video0", _mjpg_settings()))
    await asyncio.sleep(0.01)
    monkeypatch.setattr(video_service_module.asyncio, "sleep", fast_sleep)
    release.set()
    results = await asyncio.gather(first, second, return_exceptions=True)

    assert len(spawned) == 1
    assert sum(isinstance(result, ValueError) for result in results) == 1
    assert "already running" in str(next(r for r in results if isinstance(r, ValueError)))
    assert service._recording_process is spawned[0]  # noqa: SLF001


async def test_recording_filename_has_millisecond_precision(monkeypatch, tmp_path) -> None:
    import re

    async def fake_exec(*args, **kwargs):
        return FakeProcess()

    async def no_sleep(_seconds):
        return None

    monkeypatch.setattr(video_service_module.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(video_service_module.asyncio, "sleep", no_sleep)
    service = VideoService(tmp_path)

    status = await service.start_recording("video0", "/dev/video0", _mjpg_settings())

    assert re.fullmatch(r"pixy-arch-video0-\d{8}-\d{6}-\d{3}\.mkv", Path(status.path).name)


async def test_device_fed_ffmpeg_spawns_never_inherit_stdin(monkeypatch, tmp_path) -> None:
    calls: list[tuple[tuple, dict]] = []

    async def fake_exec(*args, **kwargs):
        calls.append((args, kwargs))
        return FakeProcess()

    async def no_sleep(_seconds):
        return None

    monkeypatch.setattr(video_service_module.asyncio, "create_subprocess_exec", fake_exec)
    service = VideoService(tmp_path)

    await service._start_ffmpeg_stream(  # noqa: SLF001
        "/dev/video0", VideoStreamSettings(pixel_format="YUYV", width=640, height=480, fps=30)
    )
    # The stream reaper loops on asyncio.sleep: stop it before sleep is stubbed.
    service._reaper_task.cancel()  # noqa: SLF001
    monkeypatch.setattr(video_service_module.asyncio, "sleep", no_sleep)
    await service.start_recording("video1", "/dev/video1", _mjpg_settings())

    assert len(calls) == 2
    for args, kwargs in calls:
        assert "-nostdin" in args
        assert kwargs["stdin"] == asyncio.subprocess.DEVNULL


async def test_unwritable_recordings_dir_is_a_clean_error(monkeypatch, tmp_path) -> None:
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("x", encoding="utf-8")
    spawned: list[object] = []

    async def fake_exec(*args, **kwargs):
        spawned.append(args)
        return FakeProcess()

    monkeypatch.setattr(video_service_module.asyncio, "create_subprocess_exec", fake_exec)
    service = VideoService(blocker / "recordings")

    try:
        await service.start_recording("video0", "/dev/video0", _mjpg_settings())
    except ValueError as exc:
        assert "not writable" in str(exc)
    else:
        raise AssertionError("start_recording should fail when the directory cannot be created")

    assert spawned == []
    assert service._recording_status.recording is False  # noqa: SLF001
    assert "not writable" in (service._recording_status.reason or "")  # noqa: SLF001


def test_recordings_dir_follows_config_changes(monkeypatch, tmp_path) -> None:
    current = {"path": tmp_path / "first"}
    monkeypatch.setattr(video_service_module, "recordings_dir", lambda: current["path"])
    service = VideoService()

    assert service.recordings_dir == tmp_path / "first"
    current["path"] = tmp_path / "second"
    assert service.recordings_dir == tmp_path / "second"


async def test_native_capture_opened_after_first_frame_timeout_is_closed(monkeypatch, tmp_path) -> None:
    import threading

    open_started = threading.Event()
    finish_open = threading.Event()
    closed = threading.Event()

    class SlowOpenCapture(FakeNativeCapture):
        def open(self) -> None:
            open_started.set()
            finish_open.wait(5)

        def close(self) -> None:
            closed.set()

    monkeypatch.setattr(video_service_module, "NativeMjpegCapture", SlowOpenCapture)
    service = VideoService(tmp_path)
    stream = service.mjpeg_stream("/dev/video0", _mjpg_settings())

    try:
        await asyncio.wait_for(stream.__anext__(), timeout=0.05)
    except TimeoutError:
        pass
    else:
        raise AssertionError("the first frame should time out while open() is stuck")
    assert open_started.is_set()
    assert not closed.is_set()

    finish_open.set()
    for _ in range(100):
        if closed.is_set():
            break
        await asyncio.sleep(0.01)
    assert closed.is_set()
    assert service._native_streams == {}  # noqa: SLF001


async def test_native_capture_setup_errors_end_stream_cleanly(monkeypatch, tmp_path) -> None:
    import struct

    for error in (RuntimeError("only 1 buffer"), struct.error("argument out of range")):

        class BrokenCapture(FakeNativeCapture):
            def open(self, error=error) -> None:
                raise error

        monkeypatch.setattr(video_service_module, "NativeMjpegCapture", BrokenCapture)
        service = VideoService(tmp_path)

        chunks = [chunk async for chunk in service.mjpeg_stream("/dev/video0", _mjpg_settings())]

        assert chunks == []


def _stream_app(video_service, vcam_status):
    from fastapi import FastAPI

    from pixypilot.api.routes import router
    from pixypilot.domains.video.service import get_video_service
    from pixypilot.domains.virtualcam.service import get_virtualcam_service

    class FakeVcam:
        async def status(self):
            return vcam_status

    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_video_service] = lambda: video_service
    app.dependency_overrides[get_virtualcam_service] = lambda: FakeVcam()
    return app


async def test_stream_route_bounds_query_and_maps_setup_errors(monkeypatch, tmp_path) -> None:
    import httpx

    import pixypilot.api.routes as routes_module
    from pixypilot.domains.virtualcam.models import VirtualCamStatus

    class ExplodingVideoService:
        async def mjpeg_stream(self, device_path, settings):
            raise RuntimeError("V4L2 device only provided 1 streaming buffer(s)")
            yield b""  # pragma: no cover

    monkeypatch.setattr(routes_module.os.path, "exists", lambda _path: True)
    app = _stream_app(ExplodingVideoService(), VirtualCamStatus(available=False))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as client:
        too_wide = await client.get("/api/devices/video0/stream", params={"width": 7681})
        too_fast = await client.get("/api/devices/video0/stream", params={"fps": 240})
        bad_interval = await client.get("/api/devices/video0/stream", params={"frame_interval_100ns": 1})
        broken = await client.get("/api/devices/video0/stream")

    assert too_wide.status_code == 422
    assert too_fast.status_code == 422
    assert bad_interval.status_code == 422
    assert broken.status_code == 503
    assert "streaming buffer" in broken.json()["detail"]
