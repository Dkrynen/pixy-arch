import asyncio
import math
import re
import struct
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
# How long a relay-fed recording waits for the tap's first frame before
# failing instead of writing a header-only .mkv forever.
RELAY_FIRST_FRAME_TIMEOUT_S = 5.0


async def _prepend_frame(first: bytes, rest: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    yield first
    async for frame in rest:
        yield frame


class VideoService:
    def __init__(self, recordings_dir: Path | None = None) -> None:
        self._recordings_dir_override = recordings_dir
        self._recording_process: asyncio.subprocess.Process | None = None
        self._recording_stderr_path: str | None = None
        self._recording_status = VideoRecordingStatus(recording=False)
        self._stream_processes: dict[str, list[asyncio.subprocess.Process]] = {}
        self._native_streams: dict[str, NativeMjpegCapture] = {}
        self._stream_progress: dict[object, float] = {}
        self._reaper_task: asyncio.Task[None] | None = None
        self._stream_lock = asyncio.Lock()
        self._recording_feed_task: asyncio.Task[None] | None = None
        # Held across the whole start: two concurrent starts would otherwise
        # both pass the "already running" check and one ffmpeg would leak.
        self._recording_lock = asyncio.Lock()

    @property
    def recordings_dir(self) -> Path:
        # Resolved per use so a storage.recordings change applies without a
        # restart (the settings service clears the config cache on write).
        return self._recordings_dir_override or _recordings_dir()

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
        frame_source: AsyncIterator[bytes] | None = None,
    ) -> VideoRecordingStatus:
        async with self._recording_lock:
            return await self._start_recording_locked(device_name, device_path, settings, frame_source)

    async def _start_recording_locked(
        self,
        device_name: str,
        device_path: str,
        settings: VideoStreamSettings,
        frame_source: AsyncIterator[bytes] | None,
    ) -> VideoRecordingStatus:
        await self._reap_finished_recording()
        if self._recording_process is not None:
            raise ValueError("A recording is already running")

        first_frame: bytes | None = None
        if frame_source is not None:
            # Fail fast when the relay tap is dead — otherwise the recorder
            # reports "recording" while producing a header-only file forever.
            try:
                first_frame = await asyncio.wait_for(
                    frame_source.__anext__(), timeout=RELAY_FIRST_FRAME_TIMEOUT_S
                )
            except (TimeoutError, StopAsyncIteration) as exc:
                raise ValueError("virtual camera is not producing frames") from exc
            frame_source = _prepend_frame(first_frame, frame_source)

        started_at = datetime.now(UTC)
        recordings_dir = self.recordings_dir
        # Milliseconds keep back-to-back recordings from colliding on a name.
        output_path = recordings_dir / (
            f"pixy-arch-{_slugify_device_name(device_name)}-"
            f"{started_at.strftime('%Y%m%d-%H%M%S')}-{started_at.microsecond // 1000:03d}.mkv"
        )
        # Relay-fed recording copies native MJPEG frames from the virtual-cam
        # tap — it never opens the loopback, whose single-reader slot stays
        # free for external consumers like OBS.
        command = (
            build_relay_record_command(output_path)
            if frame_source is not None
            else build_record_command(device_path, settings, output_path)
        )
        try:
            recordings_dir.mkdir(parents=True, exist_ok=True)
            stderr_log = tempfile.NamedTemporaryFile(
                mode="wb", prefix="pixypilot-record-", suffix=".log", delete=False
            )
        except OSError as exc:
            reason = f"recordings directory {recordings_dir} is not writable: {exc.strerror or exc}"
            self._recording_status = VideoRecordingStatus(
                recording=False, device_name=device_name, reason=reason
            )
            raise ValueError(reason) from exc
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdin=asyncio.subprocess.PIPE if frame_source is not None else asyncio.subprocess.DEVNULL,
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
        if frame_source is not None:
            self._recording_feed_task = asyncio.get_running_loop().create_task(
                self._feed_recorder(process, frame_source)
            )
        # Register before the spawn watch: stop() must be able to kill the
        # process during the watch window.
        self._recording_process = process
        self._recording_stderr_path = stderr_log.name
        self._recording_status = VideoRecordingStatus(
            recording=True,
            device_name=device_name,
            path=str(output_path),
            started_at=started_at.isoformat(),
        )

        await asyncio.sleep(0.5)
        if process.returncode is not None:
            await self._stop_recording_feed()
            if self._recording_process is process:
                self._recording_process = None
            if self._recording_stderr_path == stderr_log.name:
                self._recording_stderr_path = None
            reason = _read_stderr_tail(stderr_log.name)
            _remove_quietly(stderr_log.name)
            self._recording_status = VideoRecordingStatus(
                recording=False,
                device_name=device_name,
                reason=f"ffmpeg exited immediately: {reason}" if reason else "ffmpeg exited immediately",
            )
            raise ValueError(self._recording_status.reason)
        return self._recording_status

    async def _feed_recorder(
        self, process: asyncio.subprocess.Process, source: AsyncIterator[bytes]
    ) -> None:
        stdin = process.stdin
        try:
            if stdin is None:
                return
            async for frame in source:
                stdin.write(frame)
                await stdin.drain()
        except asyncio.CancelledError:
            raise
        except (BrokenPipeError, ConnectionResetError):
            # ffmpeg exited mid-record; the reap path reports the reason.
            pass
        finally:
            if stdin is not None:
                try:
                    stdin.close()
                except (BrokenPipeError, ConnectionResetError):
                    pass

    async def _stop_recording_feed(self) -> None:
        task = self._recording_feed_task
        self._recording_feed_task = None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def stop_recording(self) -> VideoRecordingStatus:
        process = self._recording_process
        if process is None:
            self._recording_status = VideoRecordingStatus(recording=False, reason="No recording is running")
            return self._recording_status

        # A relay-fed recorder finalizes on stdin EOF, so close the feed
        # before escalating to signals — keeps the .mkv cleanly muxed.
        await self._stop_recording_feed()
        await _stop_process(process)
        finished = self._recording_status.model_copy(update={"recording": False})
        if self._recording_process is process:
            self._recording_process = None
        self._recording_status = finished
        self._discard_recording_log()
        return finished

    async def recording_status(self) -> VideoRecordingStatus:
        await self._reap_finished_recording()
        return self._recording_status

    async def _reap_finished_recording(self) -> None:
        process = self._recording_process
        if process is None or process.returncode is None:
            return
        await self._stop_recording_feed()
        await process.wait()
        exit_code = process.returncode
        if self._recording_process is process:
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
        except (OSError, RuntimeError, ValueError, struct.error):
            # Device node missing/busy, or the driver rejected the requested
            # mode: finish the response cleanly so the client can surface a
            # retryable "stream unavailable" state instead of a 500.
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
        opening = asyncio.ensure_future(asyncio.to_thread(capture.open))
        try:
            await asyncio.shield(opening)
        except asyncio.CancelledError:
            # Cancelled (first-frame timeout, client gone) while the open is
            # still running in its thread: close the capture once it lands,
            # or its fd and the streaming camera leak.
            opening.add_done_callback(lambda task: _close_after_open(task, capture))
            raise
        try:
            async with self._stream_lock:
                stale_capture = self._native_streams.pop(device_path, None)
                if stale_capture is not None:
                    self._stream_progress.pop(stale_capture, None)
                    await asyncio.to_thread(stale_capture.close)
                self._native_streams[device_path] = capture
                self._stream_progress[capture] = time.monotonic()
                self._ensure_reaper()
        except BaseException:
            if self._native_streams.get(device_path) is not capture:
                asyncio.get_running_loop().run_in_executor(None, capture.close)
            raise
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
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        try:
            async with self._stream_lock:
                stale_processes = self._stream_processes.pop(device_path, [])
                for stale_process in stale_processes:
                    self._stream_progress.pop(stale_process, None)
                    await _stop_process(stale_process)
                self._stream_processes[device_path] = [process]
                self._stream_progress[process] = time.monotonic()
                self._ensure_reaper()
        except BaseException:
            # Cancelled before registration: nothing else would ever reap it.
            if process not in self._stream_processes.get(device_path, []) and process.returncode is None:
                process.kill()
            raise
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
        # q2 is visually near-lossless; q5 read as blur on the loopback path.
        "-q:v",
        "2",
        "pipe:1",
    ]


def build_record_command(device_path: str, settings: VideoStreamSettings, output_path: Path) -> list[str]:
    # MJPEG sources copy frame-for-frame into the container; raw formats
    # (YUYV, from the virtual-cam loopback) would otherwise mux as rawvideo
    # at ~120 MB/s, so they are encoded to MJPEG instead.
    codec_args = ["-c:v", "copy"] if settings.pixel_format.upper() == "MJPG" else ["-c:v", "mjpeg", "-q:v", "3"]
    return [
        *build_input_args(device_path, settings),
        "-an",
        *codec_args,
        "-f",
        "matroska",
        str(output_path),
    ]


def build_relay_record_command(output_path: Path) -> list[str]:
    # Frames arrive on stdin from the virtual-cam MJPEG tap — copy them
    # verbatim, no device is opened at all. The camera's real delivery rate
    # varies with exposure (dark scene → ~10fps at 1080p), so stamp packets
    # at wall-clock arrival time instead of a synthetic fixed rate —
    # otherwise recordings play back fast in low light.
    return [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-use_wallclock_as_timestamps",
        "1",
        "-fflags",
        "+genpts",
        "-f",
        "mjpeg",
        "-i",
        "pipe:0",
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
        # Device-fed ffmpeg never reads stdin; without this it can swallow
        # keystrokes or stop on SIGTTIN when the backend runs in a terminal.
        "-nostdin",
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


def _jpeg_frame_end(data: bytes, start: int) -> int:
    """Offset just past the EOI of the JPEG whose SOI sits at `start`, or -1
    when the frame is incomplete/corrupt.

    Marker walk: length-delimited segments (APPn, COM, DQT, …) are skipped
    wholesale, so a nested thumbnail JPEG (FFD8…FFD9 inside APP1) can never
    truncate the outer frame — the naive byte-scan did cut there. After SOS,
    entropy-coded data is scanned for the next real marker; FF bytes there
    are stuffed as FF00 and RSTn markers are legal.
    """
    n = len(data)
    i = start + 2
    while i + 1 < n:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker == 0x00:
            i += 2
            continue
        if marker == 0xFF:
            i += 1  # fill byte before a marker
            continue
        if marker == 0xD9:
            return i + 2
        if marker == 0xD8 or marker == 0x01 or 0xD0 <= marker <= 0xD7:
            i += 2  # standalone marker (SOI/TEM/RSTn), no length field
            continue
        if i + 4 > n:
            return -1  # segment length not buffered yet
        seglen = (data[i + 2] << 8) | data[i + 3]
        if seglen < 2:
            return -1  # corrupt stream — don't loop forever
        i += 2 + seglen
        if marker == 0xDA:
            # Entropy data until the next non-stuffed marker.
            while i + 1 < n:
                if data[i] == 0xFF and data[i + 1] != 0x00:
                    if 0xD0 <= data[i + 1] <= 0xD7:
                        i += 2
                        continue
                    break
                i += 1
    return -1


# Cap for the buffered-not-yet-framed window: a corrupt stream that never
# terminates a frame must not grow memory without bound. 1080p MJPEG frames
# are ~150KB; even 4K stays under ~2MB.
_JPEG_BUFFER_CAP = 8 * 1024 * 1024


async def _jpeg_frames(stdout: asyncio.StreamReader) -> AsyncIterator[bytes]:
    buffer = b""
    while True:
        chunk = await stdout.read(65536)
        if not chunk:
            break
        buffer += chunk
        while True:
            start = buffer.find(b"\xff\xd8")
            if start < 0:
                buffer = buffer[-1:]
                break
            end = _jpeg_frame_end(buffer, start)
            if end < 0:
                buffer = buffer[start:]
                break
            yield buffer[start:end]
            buffer = buffer[end:]
        if len(buffer) > _JPEG_BUFFER_CAP:
            buffer = buffer[-1:]


async def _stop_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        await process.wait()
        return
    process.terminate()
    # Shield the waits: when this runs inside a finally during task
    # cancellation (client disconnected mid-stream), an unshielded wait is
    # cancelled before the kill escalation — leaving a SIGTERM'd process
    # blocked on a full pipe alive forever, holding the camera node.
    # kill() is synchronous, so once we reach the timeout path it always
    # lands even under repeated cancellation.
    try:
        await asyncio.wait_for(asyncio.shield(process.wait()), timeout=3)
        return
    except (asyncio.TimeoutError, asyncio.CancelledError):
        pass
    if process.returncode is None:
        process.kill()
    try:
        await asyncio.wait_for(asyncio.shield(process.wait()), timeout=3)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        pass


def _read_stderr_tail(path: str | None, max_bytes: int = 4000) -> str:
    if not path:
        return ""
    try:
        data = Path(path).read_bytes()
    except OSError:
        return ""
    text = data.decode("utf-8", errors="replace").strip()
    return text[-max_bytes:]


def _close_after_open(opening: "asyncio.Future[None]", capture: NativeMjpegCapture) -> None:
    if opening.cancelled() or opening.exception() is not None:
        return  # a failed open already closed itself
    asyncio.get_running_loop().run_in_executor(None, capture.close)


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
