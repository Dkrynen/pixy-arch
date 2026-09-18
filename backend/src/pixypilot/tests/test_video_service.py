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

    assert command[-6:] == ["-an", "-f", "mjpeg", "-q:v", "5", "pipe:1"]
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
    assert filename.startswith("pixypilot-EMEET-PIXY-EMEET-PIXY-")
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
