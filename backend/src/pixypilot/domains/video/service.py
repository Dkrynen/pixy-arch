import asyncio
import math
import re
import subprocess
import tempfile
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path

from pixypilot.config import recordings_dir
from pixypilot.domains.video.native_mjpeg import NativeMjpegCapture
from pixypilot.domains.video.models import VideoRecordingStatus, VideoStreamSettings

PIXEL_FORMAT_INPUTS = {
    "MJPG": "mjpeg",
    "YUYV": "yuyv422",
    "NV12": "nv12",
}
FRAME_BOUNDARY = b"--frame\r\nContent-Type: image/jpeg\r\nCache-Control: no-store\r\n\r\n"
# A stream that has not produced output for this long has an abandoned or
# backpressured consumer: the client is gone, so the camera must be released.
STREAM_STALE_AFTER_S = 8.0
STREAM_REAPER_INTERVAL_S = 2.0


class VideoService:
    def __init__(self, recordings_dir: Path | None = None) -> None:
        self.recordings_dir = recordings_dir or _recordings_dir()
        self._recording_process: asyncio.subprocess.Process | None = None
        self._recording_stderr_path: str | None = None
        self._recording_status = VideoRecordingStatus(recording=False)
        self._stream_processes: dict[str, list[asyncio.subprocess.Process]] = {}
        self._native_streams: dict[str, NativeMjpegCapture] = {}
        self._stream_progress: dict[object, float] = {}
        self._reaper_task: asyncio.Task[None] | None = None
        self._stream_lock = asyncio.Lock()

    async def mjpeg_stream(self, device_path: str, settings: VideoStreamSettings) -> AsyncIterator[bytes]:
        if settings.pixel_format.upper() == "MJPG":
            async for chunk in self._native_mjpeg_stream(device_path, settings):
                yield chunk
            return

        try:
            process = await self._start_ffmpeg_stream(device_path, settings)
        except OSError:
            # ffmpeg missing or the device node vanished: end the response
            # cleanly so the client sees a finished stream instead of an abort.
            return
        if process.stdout is None:
            await self._unregister_stream(device_path, process)
            await _stop_process(process)
            return

        try:
            async for frame in _jpeg_frames(process.stdout):
                self._touch_stream(process)
                yield FRAME_BOUNDARY + frame + b"\r\n"
        finally:
            await self._unregister_stream(device_path, process)
            await _stop_process(process)

    async def stop_streams(self, device_path: str | None = None) -> None:
        async with self._stream_lock:
            if device_path is None:
                processes = [process for group in self._stream_processes.values() for process in group]
                self._stream_processes.clear()
                captures = list(self._native_streams.values())
                self._native_streams.clear()
            else:
                processes = self._stream_processes.pop(device_path, [])
                captures = [self._native_streams.pop(device_path)] if device_path in self._native_streams else []
            for process in processes:
                self._stream_progress.pop(process, None)
            for capture in captures:
                self._stream_progress.pop(capture, None)

        for process in processes:
            await _stop_process(process)
        for capture in captures:
            await asyncio.to_thread(capture.close)

    async def start_recording(
        self,
        device_name: str,
        device_path: str,
        settings: VideoStreamSettings,
    ) -> VideoRecordingStatus:
        await self._reap_finished_recording()
        if self._recording_process is not None:
            raise ValueError("A recording is already running")

        self.recordings_dir.mkdir(parents=True, exist_ok=True)
        started_at = datetime.now(UTC)
        output_path = self.recordings_dir / (
            f"pixypilot-{_slugify_device_name(device_name)}-{started_at.strftime('%Y%m%d-%H%M%S')}.mkv"
        )
        command = build_record_command(device_path, settings, output_path)
        stderr_log = tempfile.NamedTemporaryFile(
            mode="wb", prefix="pixypilot-record-", suffix=".log", delete=False
        )
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=subprocess.DEVNULL,
                stderr=stderr_log,
            )
        except OSError as exc:
            stderr_log.close()
            _remove_quietly(stderr_log.name)
            reason = (
                "ffmpeg is not installed or not on PATH"
                if isinstance(exc, FileNotFoundError)
                else f"ffmpeg could not be started: {exc}"
            )
            self._recording_status = VideoRecordingStatus(
                recording=False,
                device_name=device_name,
                reason=reason,
            )
            raise ValueError(reason) from exc
        stderr_log.close()

        await asyncio.sleep(0.5)
        if process.returncode is not None:
            reason = _read_stderr_tail(stderr_log.name)
            _remove_quietly(stderr_log.name)
            self._recording_status = VideoRecordingStatus(
                recording=False,
                device_name=device_name,
                reason=f"ffmpeg exited immediately: {reason}" if reason else "ffmpeg exited immediately",
            )
            raise ValueError(self._recording_status.reason)

        self._recording_process = process
        self._recording_stderr_path = stderr_log.name
        self._recording_status = VideoRecordingStatus(
            recording=True,
            device_name=device_name,
            path=str(output_path),
            started_at=started_at.isoformat(),
        )
        return self._recording_status

    async def stop_recording(self) -> VideoRecordingStatus:
        if self._recording_process is None:
            self._recording_status = VideoRecordingStatus(recording=False, reason="No recording is running")
            return self._recording_status

        await _stop_process(self._recording_process)
        finished = self._recording_status.model_copy(update={"recording": False})
        self._recording_process = None
        self._recording_status = finished
        self._discard_recording_log()
        return finished

    async def recording_status(self) -> VideoRecordingStatus:
        await self._reap_finished_recording()
        return self._recording_status

    async def _reap_finished_recording(self) -> None:
        if self._recording_process is None:
            return
        if self._recording_process.returncode is None:
            return
        await self._recording_process.wait()
        exit_code = self._recording_process.returncode
        self._recording_process = None
        stderr_tail = _read_stderr_tail(self._recording_stderr_path) if self._recording_stderr_path else ""
        self._discard_recording_log()
        reason = f"Recording process exited (code {exit_code})"
        if stderr_tail:
            reason = f"{reason}: {stderr_tail}"
        self._recording_status = self._recording_status.model_copy(
            update={"recording": False, "reason": reason}
        )

    def _discard_recording_log(self) -> None:
        if self._recording_stderr_path is None:
            return
        _remove_quietly(self._recording_stderr_path)
        self._recording_stderr_path = None

    async def _native_mjpeg_stream(self, device_path: str, settings: VideoStreamSettings) -> AsyncIterator[bytes]:
        try:
            capture = await self._start_native_stream(device_path, settings)
        except OSError:
            # Device node missing or busy: finish the response cleanly so the
            # client can surface a retryable "stream unavailable" state.
            return
        try:
            while True:
                self._touch_stream(capture)
                try:
                    frame = await asyncio.to_thread(capture.read_frame)
                except TimeoutError:
                    continue
                except (OSError, RuntimeError):
                    break
                yield FRAME_BOUNDARY + frame + b"\r\n"
        finally:
            await asyncio.to_thread(capture.close)
            await self._unregister_native_stream(device_path, capture)

    async def _start_native_stream(self, device_path: str, settings: VideoStreamSettings) -> NativeMjpegCapture:
        async with self._stream_lock:
            stale_processes = self._stream_processes.pop(device_path, [])
            stale_capture = self._native_streams.pop(device_path, None)

        for process in stale_processes:
            self._stream_progress.pop(process, None)
            await _stop_process(process)
        if stale_capture is not None:
            self._stream_progress.pop(stale_capture, None)
            await asyncio.to_thread(stale_capture.close)

        capture = NativeMjpegCapture(device_path, settings)
        await asyncio.to_thread(capture.open)
        async with self._stream_lock:
            stale_capture = self._native_streams.pop(device_path, None)
            if stale_capture is not None:
                self._stream_progress.pop(stale_capture, None)
                await asyncio.to_thread(stale_capture.close)
            self._native_streams[device_path] = capture
            self._stream_progress[capture] = time.monotonic()
            self._ensure_reaper()
        return capture

    async def _unregister_native_stream(self, device_path: str, capture: NativeMjpegCapture) -> None:
        async with self._stream_lock:
            if self._native_streams.get(device_path) is capture:
                self._native_streams.pop(device_path, None)
            self._stream_progress.pop(capture, None)

    async def _start_ffmpeg_stream(self, device_path: str, settings: VideoStreamSettings) -> asyncio.subprocess.Process:
        command = build_stream_command(device_path, settings)
        async with self._stream_lock:
            stale_processes = self._stream_processes.pop(device_path, [])
            stale_capture = self._native_streams.pop(device_path, None)

        for process in stale_processes:
            await _stop_process(process)
        if stale_capture is not None:
            await asyncio.to_thread(stale_capture.close)

        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        async with self._stream_lock:
            stale_processes = self._stream_processes.pop(device_path, [])
            for stale_process in stale_processes:
                self._stream_progress.pop(stale_process, None)
                await _stop_process(stale_process)
            self._stream_processes[device_path] = [process]
            self._stream_progress[process] = time.monotonic()
            self._ensure_reaper()
        return process

    async def _unregister_stream(self, device_path: str, process: asyncio.subprocess.Process) -> None:
        async with self._stream_lock:
            self._stream_progress.pop(process, None)
            processes = self._stream_processes.get(device_path)
            if not processes:
                return
            self._stream_processes[device_path] = [item for item in processes if item is not process]
            if not self._stream_processes[device_path]:
                self._stream_processes.pop(device_path, None)

    def _touch_stream(self, owner: object) -> None:
        self._stream_progress[owner] = time.monotonic()

    def _ensure_reaper(self) -> None:
        if self._reaper_task is None or self._reaper_task.done():
            self._reaper_task = asyncio.get_running_loop().create_task(self._stream_reaper())

    async def _stream_reaper(self) -> None:
        try:
            while True:
                await asyncio.sleep(STREAM_REAPER_INTERVAL_S)
                await self._reap_stale_streams()
        except asyncio.CancelledError:
            pass

    async def _reap_stale_streams(self) -> None:
        # Streams whose generator stopped being driven (client disconnected
        # while suspended at yield, or a stalled consumer) never reach their
        # finally block promptly. Reap them so the camera and ffmpeg handles
        # are released instead of leaking until the next explicit stop.
        cutoff = time.monotonic() - STREAM_STALE_AFTER_S
        async with self._stream_lock:
            stale_processes = [
                process
                for processes in self._stream_processes.values()
                for process in processes
                if self._stream_progress.get(process, math.inf) < cutoff
            ]
            stale_captures = [
                capture
                for capture in self._native_streams.values()
                if self._stream_progress.get(capture, math.inf) < cutoff
            ]
            stale_device_paths = {
                device_path
                for device_path, capture in self._native_streams.items()
                if capture in stale_captures
            }
            for process in stale_processes:
                for device_path, processes in list(self._stream_processes.items()):
                    remaining = [item for item in processes if item is not process]
                    if remaining:
                        self._stream_processes[device_path] = remaining
                    else:
                        self._stream_processes.pop(device_path, None)
                self._stream_progress.pop(process, None)
            for device_path in stale_device_paths:
                self._native_streams.pop(device_path, None)
            for capture in stale_captures:
                self._stream_progress.pop(capture, None)
        for process in stale_processes:
            await _stop_process(process)
        for capture in stale_captures:
            await asyncio.to_thread(capture.close)


def build_stream_command(device_path: str, settings: VideoStreamSettings) -> list[str]:
    if settings.pixel_format.upper() == "MJPG":
        return [
            *build_input_args(device_path, settings),
            "-an",
            "-c:v",
            "copy",
            "-f",
            "mjpeg",
            "pipe:1",
        ]

    return [
        *build_input_args(device_path, settings),
        "-an",
        "-f",
        "mjpeg",
        "-q:v",
        "5",
        "pipe:1",
    ]


def build_record_command(device_path: str, settings: VideoStreamSettings, output_path: Path) -> list[str]:
    return [
        *build_input_args(device_path, settings),
        "-an",
        "-c:v",
        "copy",
        "-f",
        "matroska",
        str(output_path),
    ]


def build_input_args(device_path: str, settings: VideoStreamSettings) -> list[str]:
    fps = 10_000_000 / settings.frame_interval_100ns if settings.frame_interval_100ns else settings.fps
    return [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "v4l2",
        "-framerate",
        _format_fps(fps),
        "-video_size",
        f"{settings.width}x{settings.height}",
        "-input_format",
        _ffmpeg_pixel_format(settings.pixel_format),
        "-i",
        device_path,
    ]


def _ffmpeg_pixel_format(pixel_format: str) -> str:
    return PIXEL_FORMAT_INPUTS.get(pixel_format.upper(), pixel_format.lower())


def _format_fps(fps: float) -> str:
    rounded = round(fps)
    if abs(fps - rounded) < 0.001:
        return str(rounded)
    return f"{fps:.3f}".rstrip("0").rstrip(".")


async def _jpeg_frames(stdout: asyncio.StreamReader) -> AsyncIterator[bytes]:
    buffer = b""
    while True:
        chunk = await stdout.read(65536)
        if not chunk:
            break
        buffer += chunk
        while True:
            start = buffer.find(b"\xff\xd8")
            end = buffer.find(b"\xff\xd9", start + 2 if start >= 0 else 0)
            if start < 0:
                buffer = buffer[-1:]
                break
            if end < 0:
                buffer = buffer[start:]
                break
            frame = buffer[start : end + 2]
            buffer = buffer[end + 2 :]
            yield frame


async def _stop_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        await process.wait()
        return
    process.terminate()
    try:
        await asyncio.wait_for(process.wait(), timeout=3)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()


def _read_stderr_tail(path: str | None, max_bytes: int = 4000) -> str:
    if not path:
        return ""
    try:
        data = Path(path).read_bytes()
    except OSError:
        return ""
    text = data.decode("utf-8", errors="replace").strip()
    return text[-max_bytes:]


def _remove_quietly(path: str | None) -> None:
    if not path:
        return
    try:
        Path(path).unlink()
    except OSError:
        pass


def _slugify_device_name(device_name: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", device_name).strip("-._")
    return slug or "camera"


def _recordings_dir() -> Path:
    return recordings_dir()


_video_service = VideoService()


def get_video_service() -> VideoService:
    return _video_service
