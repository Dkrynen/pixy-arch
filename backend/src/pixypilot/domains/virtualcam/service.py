import asyncio
import contextlib
import fcntl
import logging
import os
import signal
import struct
import tempfile
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import TYPE_CHECKING

from pixypilot.config import (
    virtualcam_device,
    virtualcam_idle_grace_seconds,
    virtualcam_labels,
    virtualcam_on_demand,
)
from pixypilot.core.runtime_dir import runtime_dir
from pixypilot.domains.v4l2.native import (
    V4L2_CAP_DEVICE_CAPS,
    V4L2_CAP_VIDEO_CAPTURE,
    V4L2_CAPABILITY_SIZE,
    VIDIOC_QUERYCAP,
)
from pixypilot.domains.video.service import _jpeg_frames, get_video_service
from pixypilot.domains.virtualcam.models import (
    VirtualCamActionResult,
    VirtualCamStartRequest,
    VirtualCamStatus,
    VirtualCamTransform,
)

if TYPE_CHECKING:
    from pixypilot.domains.whiteboard.pump import WhiteboardPump

VIDEO4LINUX_SYSFS = Path("/sys/class/video4linux")

# How long the whiteboard pipeline gets to deliver its first frame before the
# start is reported as a failure instead of a silently-dead "running" state.
WHITEBOARD_FIRST_FRAME_TIMEOUT_S = 5.0
# How long to watch a freshly spawned ffmpeg for an early exit (busy device,
# bad input format, ...). Long enough for v4l2 probing to fail, short enough
# for the API to stay snappy.
SPAWN_WATCH_S = 0.5

# On-demand mode: poll cadence for sink-consumer scans, and the backoff after
# a failed demand-start so a busy source doesn't hot-loop ffmpeg spawns.
DEMAND_POLL_S = 1.0
DEMAND_START_BACKOFF_S = 5.0
# Standby writes at 5fps (~2% CPU vs ~16% at 30): the loopback still
# advertises 30fps — its S_PARM default is independent of write pace — and
# a probing reader only waits ~200ms for a frame.
STANDBY_FPS = 5.0

_LOG = logging.getLogger("pixypilot.virtualcam")

_V4L2_BUF_TYPE_VIDEO_CAPTURE = 1
_V4L2_FORMAT_SIZE = 208
_V4L2_STREAMPARM_SIZE = 204
_VIDIOC_G_FMT = 0xC0D05604
_VIDIOC_G_PARM = 0xC0CC5615
# v4l2_format.fmt is a union containing a userspace pointer, so the pixel
# format sits at pointer alignment; v4l2_streamparm.parm has no pointer, so
# capture.timeperframe lands at offset 12 (4-byte type + 8-byte parm header).
_FMT_UNION_OFFSET = struct.calcsize("P")
_PARM_TIMEPERFRAME_OFFSET = 12


def build_filter_chain(transform: VirtualCamTransform, output_width: int, output_height: int) -> str:
    # Order matters: mirror in input orientation, then rotate, then the
    # centered zoom crop is rescaled back to the requested output size.
    filters: list[str] = []
    if transform.mirror:
        filters.append("hflip")
    if transform.rotate == 90:
        filters.append("transpose=1")
    elif transform.rotate == 180:
        filters.extend(["hflip", "vflip"])
    elif transform.rotate == 270:
        filters.append("transpose=2")
    if transform.zoom > 1.0:
        filters.append(f"crop=iw/{transform.zoom:g}:ih/{transform.zoom:g}")
    filters.append(f"scale={output_width}:{output_height}")
    return ",".join(filters)


def build_ffmpeg_command(
    request: VirtualCamStartRequest, source_path: str, sink_path: str
) -> list[str]:
    filters = build_filter_chain(request.transform, request.output_width, request.output_height)
    # Second output tees native-resolution MJPEG frames to stdout for the
    # in-app preview/record relay, so the loopback sink stays exclusively
    # available to external consumers (OBS & friends) — a v4l2loopback
    # device only supports one streaming reader at a time.
    # MJPEG input is copied verbatim (no encode cost); raw input is encoded.
    tap_codec = (
        ["-c:v", "copy"]
        if request.input_format.lower() in ("mjpeg", "mjpg")
        else ["-c:v", "mjpeg", "-q:v", "2"]
    )
    return [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-f",
        "v4l2",
        "-input_format",
        request.input_format,
        "-video_size",
        f"{request.input_width}x{request.input_height}",
        "-framerate",
        f"{request.input_fps:g}",
        "-i",
        source_path,
        "-map",
        "0:v",
        "-vf",
        filters,
        "-f",
        "v4l2",
        "-pix_fmt",
        "yuyv422",
        sink_path,
        "-map",
        "0:v",
        *tap_codec,
        "-f",
        "mjpeg",
        "pipe:1",
    ]


def build_standby_command(
    width: int, height: int, fps: float, frame_path: str, sink_path: str
) -> list[str]:
    # Synthetic dark feed that holds the sink's capture caps while nothing
    # reads it — an idle v4l2loopback advertises output-only and disappears
    # from OBS. It never opens the source, so the Pixy sensor stays powered
    # down until a real consumer attaches. A canned YUYV frame looped
    # straight to the device at 5fps costs ~2% CPU; a lavfi generator burns
    # ~30% because loopback never blocks writers. -re + -r pace the loop.
    return [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-re",
        "-stream_loop",
        "-1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "yuyv422",
        "-s",
        f"{width}x{height}",
        "-r",
        f"{fps:g}",
        "-i",
        frame_path,
        "-f",
        "v4l2",
        "-pix_fmt",
        "yuyv422",
        sink_path,
    ]


# v4l2loopback reports this as its VIDIOC_QUERYCAP driver name.
_LOOPBACK_DRIVER = "v4l2 loopback"


def _video_nodes() -> list[Path]:
    """sysfs video4linux entries in numeric order (video2 before video10)."""
    if not VIDEO4LINUX_SYSFS.is_dir():
        return []
    entries = [entry for entry in VIDEO4LINUX_SYSFS.iterdir() if entry.name.startswith("video")]

    def node_number(entry: Path) -> tuple[int, str]:
        digits = entry.name[len("video"):]
        return (int(digits), entry.name) if digits.isdigit() else (1 << 30, entry.name)

    return sorted(entries, key=node_number)


def _node_name(entry: Path) -> str | None:
    try:
        return (entry / "name").read_text(encoding="utf-8").strip().lower()
    except OSError:
        return None


def _is_loopback_name(name: str) -> bool:
    if "loopback" in name:
        return True
    return any(label.lower() in name for label in virtualcam_labels())


def _query_capabilities(device: Path) -> tuple[str, bool] | None:
    """(driver, supports VIDEO_CAPTURE) via VIDIOC_QUERYCAP; None if unreadable.

    Opening a node for QUERYCAP does not start streaming, so it never claims
    the single-consumer camera.
    """
    try:
        fd = os.open(device, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError:
        return None
    try:
        buffer = bytearray(V4L2_CAPABILITY_SIZE)
        fcntl.ioctl(fd, VIDIOC_QUERYCAP, buffer, True)
    except OSError:
        return None
    finally:
        os.close(fd)
    driver = bytes(buffer[0:16]).split(b"\0", 1)[0].decode("ascii", errors="replace")
    capabilities, device_caps = struct.unpack_from("=II", buffer, 84)
    effective = device_caps if capabilities & V4L2_CAP_DEVICE_CAPS else capabilities
    return driver, bool(effective & V4L2_CAP_VIDEO_CAPTURE)


def _sysfs_index(entry: Path) -> int | None:
    try:
        return int((entry / "index").read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None


def _find_loopback_device() -> Path | None:
    override = virtualcam_device()
    if override is not None and override.exists():
        # Canonicalize so a configured alias (/dev/v4l/by-path/*) matches
        # both the feeder's argv and /proc fd readlinks in holder scans.
        return override.resolve()
    for entry in _video_nodes():
        name = _node_name(entry)
        if name is not None and _is_loopback_name(name):
            return Path("/dev") / entry.name
    return None


def _find_source_device() -> Path | None:
    """The EMEET PIXY's video-capture node.

    The sink's label ("Pixy Arch Virtual") also contains "pixy", and UVC
    exposes a metadata node next to the capture node, so both are skipped.
    """
    for entry in _video_nodes():
        name = _node_name(entry)
        if name is None or "pixy" not in name or _is_loopback_name(name):
            continue
        device = Path("/dev") / entry.name
        caps = _query_capabilities(device)
        if caps is None:
            # Unopenable (permissions): UVC puts the capture node at index 0
            # and its metadata node at 1, so fall back to that.
            if _sysfs_index(entry) in (None, 0):
                return device
            continue
        driver, is_capture = caps
        if is_capture and driver != _LOOPBACK_DRIVER:
            return device
    return None


def _read_sink_format(sink: Path) -> tuple[int, int, str, float | None] | None:
    """Negotiated format on the loopback: (width, height, fourcc, fps).

    Returns None when no writer has configured the sink yet — v4l2loopback
    answers G_FMT/G_PARM with EINVAL until the first writer sets a format.
    """
    try:
        fd = os.open(sink, os.O_RDWR | os.O_NONBLOCK)
    except OSError:
        return None
    try:
        fmt = bytearray(_V4L2_FORMAT_SIZE)
        struct.pack_into("=I", fmt, 0, _V4L2_BUF_TYPE_VIDEO_CAPTURE)
        fcntl.ioctl(fd, _VIDIOC_G_FMT, fmt, True)
        width, height, fourcc_raw = struct.unpack_from("=II4s", fmt, _FMT_UNION_OFFSET)
        if width <= 0 or height <= 0:
            return None
        fps: float | None = None
        parm = bytearray(_V4L2_STREAMPARM_SIZE)
        struct.pack_into("=I", parm, 0, _V4L2_BUF_TYPE_VIDEO_CAPTURE)
        try:
            fcntl.ioctl(fd, _VIDIOC_G_PARM, parm, True)
            numerator, denominator = struct.unpack_from("=II", parm, _PARM_TIMEPERFRAME_OFFSET)
            if numerator > 0 and denominator > 0:
                fps = denominator / numerator
        except OSError:
            pass
        return width, height, fourcc_raw.decode("ascii", errors="replace"), fps
    except OSError:
        return None
    finally:
        os.close(fd)


# PipeWire/WirePlumber hold camera nodes open for portal enumeration — they
# are not consumers in the "an app is using the virtual camera" sense.
_ENUMERATOR_COMMS = {"pipewire", "wireplumber"}


def _scan_sink_holders(sink: Path, proc_root: Path = Path("/proc")) -> tuple[int, int | None]:
    """Count non-writer processes holding the sink open; find the ffmpeg writer.

    Returns (consumers, writer_pid). "Consumers" are processes other than the
    writer holding the node open — readers like OBS, browsers or ffprobe. An
    ffmpeg whose arguments write to the sink is the writer (both PixyPilot
    pipelines and foreign producers match that shape); anything else with the
    node open counts as a consumer.
    """
    # realpath: /proc fd links resolve to the canonical node, while the sink
    # may have been configured via an alias (/dev/v4l/by-path/*).
    sink_arg = os.path.realpath(sink).encode()
    sink_real = os.path.realpath(sink)
    consumers = 0
    writer_pid: int | None = None
    self_pid = os.getpid()
    for entry in proc_root.iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid == self_pid:
            continue
        try:
            if (entry / "comm").read_text(encoding="utf-8").strip() in _ENUMERATOR_COMMS:
                continue
        except OSError:
            pass
        try:
            holds_sink = False
            for fd in (entry / "fd").iterdir():
                try:
                    if os.readlink(fd) in (str(sink), sink_real):
                        holds_sink = True
                        break
                except OSError:
                    continue
        except OSError:
            continue
        if not holds_sink:
            continue
        try:
            parts = (entry / "cmdline").read_bytes().split(b"\0")
        except OSError:
            parts = []
        args = [part for part in parts if part]
        if _is_ffmpeg_sink_writer(args, sink_arg):
            writer_pid = pid
        else:
            consumers += 1
    return consumers, writer_pid


def _is_ffmpeg_sink_writer(args: list[bytes], sink_arg: bytes) -> bool:
    """True when an ffmpeg cmdline outputs to the sink rather than reading it.

    The writer's cmdline may end in extra outputs after the sink (the preview
    tap's ``pipe:1``), so the sink is matched anywhere in argv — but a
    consumer reads the sink via ``-i sink``, which disqualifies it.
    """
    if not args or not args[0].endswith(b"ffmpeg"):
        return False
    if sink_arg not in args[1:]:
        return False
    for index, part in enumerate(args):
        if part == b"-i" and index + 1 < len(args) and args[index + 1] == sink_arg:
            return False
    return True


def _inspect_sink(sink: Path) -> tuple[int, int | None, tuple[int, int, str, float | None] | None]:
    consumers, writer_pid = _scan_sink_holders(sink)
    return consumers, writer_pid, _read_sink_format(sink)


def _find_sink_writer_pid(sink: Path) -> int | None:
    # An ffmpeg pipeline survives a server restart and keeps owning both the
    # source and the sink, so look for a stale writer before trusting state.
    _, writer_pid = _scan_sink_holders(sink)
    return writer_pid


def _read_stderr_tail(path: str | None, max_bytes: int = 4000) -> str:
    if not path:
        return ""
    try:
        data = Path(path).read_bytes()
    except OSError:
        return ""
    text = data.decode("utf-8", errors="replace").strip()
    return text[-max_bytes:]


def _write_standby_frame(path: Path, width: int, height: int) -> None:
    # One dark YUYV frame: Y=0x10 (limited-range black), U=V=0x80 (neutral).
    path.write_bytes(b"\x10\x80\x10\x80" * (width * height // 2))


def _remove_quietly(path: str | Path | None) -> None:
    if not path:
        return
    try:
        Path(path).unlink()
    except OSError:
        pass


def _spawn_error_reason(exc: OSError) -> str:
    if isinstance(exc, FileNotFoundError):
        return "ffmpeg is not installed or not on PATH"
    return f"ffmpeg could not be started: {exc}"


async def _kill_pid(pid: int) -> None:
    try:
        os.kill(pid, signal.SIGINT)
    except ProcessLookupError:
        return
    for _ in range(30):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        await asyncio.sleep(0.1)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


class FrameRelay:
    """Latest-frame fanout from the feeder's MJPEG tap to N subscribers.

    Preview and recording clients subscribe to frames() instead of opening
    the loopback device — a v4l2loopback sink only supports one streaming
    reader, and that slot belongs to external apps (OBS & friends).
    Subscribers always get the newest frame; slow consumers skip, they
    never build a backlog.
    """

    def __init__(self) -> None:
        self._cond = asyncio.Condition()
        self._frame: bytes | None = None
        self._seq = 0
        self._closed = False

    async def publish(self, frame: bytes) -> None:
        async with self._cond:
            self._frame = frame
            self._seq += 1
            self._cond.notify_all()

    async def close(self) -> None:
        async with self._cond:
            self._closed = True
            self._cond.notify_all()

    async def frames(self) -> AsyncIterator[bytes]:
        last = 0
        while True:
            async with self._cond:
                await self._cond.wait_for(lambda: self._closed or self._seq != last)
                if self._closed:
                    return
                frame, last = self._frame, self._seq
            if frame is not None:
                yield frame


class VirtualCamService:
    # The Pixy is a single-consumer device: while a pipeline owns the
    # capture node, consumers (including the PixyPilot preview) must read
    # the loopback output instead of the physical device.
    def __init__(self) -> None:
        self._process: asyncio.subprocess.Process | None = None
        self._pump: WhiteboardPump | None = None  # lazily imported (needs cv2)
        self._orphan_pid: int | None = None
        self._pipeline = "transform"
        self._sink_path: Path | None = None
        self._source_path: Path | None = None
        self._transform = VirtualCamTransform()
        self._requested_fps: float | None = None
        self._output_width: int | None = None
        self._output_height: int | None = None
        self._stderr_path: str | None = None
        self._last_error: str | None = None
        self._relay: FrameRelay | None = None
        self._relay_task: asyncio.Task[None] | None = None
        # On-demand mode state: armed means the sink is managed — a standby
        # feeder holds its caps while idle, the real pipeline runs only while
        # a consumer is attached. Disarmed (manual stop) frees the sink.
        self._armed = False
        self._armed_request: VirtualCamStartRequest | None = None
        self._idle_process: asyncio.subprocess.Process | None = None
        self._idle_stderr_path: str | None = None
        self._idle_frame_path: str | None = None
        self._demand_task: asyncio.Task[None] | None = None
        self._idle_since: float | None = None
        self._demand_backoff_until = 0.0
        # Serializes start/stop: two concurrent starts could both pass the
        # _running() check, and the loser's ffmpeg would leak holding the
        # source device with no tracked pid to reap.
        self._lifecycle_lock = asyncio.Lock()

    def _running(self) -> bool:
        ffmpeg_running = self._process is not None and self._process.returncode is None
        pump_running = self._pump is not None and self._pump.running
        orphan_running = self._orphan_pid is not None
        return ffmpeg_running or pump_running or orphan_running

    def _standby_running(self) -> bool:
        return self._idle_process is not None and self._idle_process.returncode is None

    def _own_writer_pids(self) -> set[int]:
        pids: set[int] = set()
        if self._process is not None and self._process.returncode is None:
            pids.add(self._process.pid)
        pump_pid = self._pump_feeder_pid()
        if pump_pid is not None:
            pids.add(pump_pid)
        if self._standby_running():
            pids.add(self._idle_process.pid)
        return pids

    def _pump_feeder_pid(self) -> int | None:
        pump = self._pump
        feeder = getattr(pump, "_feeder", None)
        return getattr(feeder, "pid", None)

    def _fail(self, reason: str, sink: Path | None = None, running: bool = False) -> VirtualCamActionResult:
        self._last_error = reason
        return VirtualCamActionResult(
            ok=False,
            running=running,
            sink_path=str(sink) if sink else None,
            reason=reason,
        )

    def _activate(self, request: VirtualCamStartRequest, source: Path, sink: Path) -> None:
        self._sink_path = sink
        self._source_path = source
        self._transform = request.transform
        self._pipeline = request.pipeline
        self._requested_fps = request.input_fps
        self._output_width = request.output_width
        self._output_height = request.output_height
        self._last_error = None

    async def _drain_preview_tap(
        self, process: asyncio.subprocess.Process, relay: FrameRelay
    ) -> None:
        try:
            if process.stdout is not None:
                async for frame in _jpeg_frames(process.stdout):
                    await relay.publish(frame)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # A dead drain leaves ffmpeg blocked on a full pipe, which freezes
            # the virtual camera for every consumer — kill it and report the
            # failure rather than letting a live-but-stuck pipeline look fine.
            self._last_error = f"preview tap failed: {exc}"
            if process.returncode is None:
                process.kill()
        finally:
            await relay.close()

    async def _clear_relay(self) -> None:
        task = self._relay_task
        self._relay_task = None
        relay = self._relay
        self._relay = None
        if relay is not None:
            await relay.close()
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    def preview_frames(self) -> AsyncIterator[bytes] | None:
        """Subscribe to feeder frames when the transform pipeline owns the source.

        Returns None when the virtual cam is not running under our control
        (stopped, whiteboard pipeline, or a foreign writer owns the sink) —
        callers then fall back to reading the sink device directly.
        """
        if (
            self._process is None
            or self._process.returncode is not None
            or self._relay is None
        ):
            return None
        return self._relay.frames()

    async def status(self) -> VirtualCamStatus:
        sink = _find_loopback_device()
        # Reap a dead transform ffmpeg before reporting "not running" — the
        # reason it died (crash, device unplugged) belongs in last_error.
        if self._process is not None and self._process.returncode is not None:
            exit_code = self._process.returncode
            tail = _read_stderr_tail(self._stderr_path)
            _remove_quietly(self._stderr_path)
            self._stderr_path = None
            self._process = None
            await self._clear_relay()
            detail = f": {tail}" if tail else ""
            exit_msg = f"ffmpeg exited (code {exit_code}){detail}"
            # Keep a more precise earlier error (e.g. the drain's "preview
            # tap failed") ahead of the generic exit report.
            self._last_error = (
                f"{self._last_error}; {exit_msg}" if self._last_error else exit_msg
            )
        if self._pump is not None and not self._pump.running:
            self._pump = None
            if self._last_error is None:
                self._last_error = "whiteboard pipeline stopped unexpectedly"
        if self._idle_process is not None and self._idle_process.returncode is not None:
            tail = _read_stderr_tail(self._idle_stderr_path)
            _remove_quietly(self._idle_stderr_path)
            self._idle_stderr_path = None
            self._idle_process = None
            if self._armed and self._last_error is None:
                detail = f": {tail}" if tail else ""
                self._last_error = f"standby feeder exited unexpectedly{detail}"
        if self._orphan_pid is not None:
            try:
                os.kill(self._orphan_pid, 0)
            except ProcessLookupError:
                self._orphan_pid = None

        consumers = 0
        negotiated: tuple[int, int, str, float | None] | None = None
        if sink is not None:
            consumers, writer_pid, negotiated = await asyncio.to_thread(_inspect_sink, sink)
            if (
                not self._running()
                and writer_pid is not None
                and writer_pid not in self._own_writer_pids()
            ):
                # A foreign/stale ffmpeg owns the sink — report it as running
                # so the UI does not pretend the virtual cam is free. Our own
                # standby feeder is expected, not an orphan.
                self._orphan_pid = writer_pid
        running = self._running()
        mode = "live" if running else "standby" if self._standby_running() else "off"

        status = VirtualCamStatus(
            available=sink is not None,
            sink_path=str(sink) if sink else None,
            running=running,
            mode=mode,
            armed=self._armed,
            pipeline=self._pipeline,
            transform=self._transform,
            consumers=consumers,
            reason=None if sink else "no v4l2loopback device found (install v4l2loopback-dkms and load the module)",
            last_error=self._last_error,
        )
        if self._process is not None:
            status.pid = self._process.pid
        elif self._pump is not None:
            status.pid = self._pump_feeder_pid()
        elif self._standby_running():
            status.pid = self._idle_process.pid
        else:
            status.pid = self._orphan_pid
        if not running and not self._standby_running():
            return status

        status.source_device = str(self._source_path) if self._source_path else None
        if self._pump is not None:
            status.frames = self._pump.frames_pumped
        if negotiated is not None:
            status.output_width, status.output_height, status.output_pixel_format, negotiated_fps = negotiated
            status.fps = negotiated_fps if negotiated_fps is not None else self._requested_fps
        else:
            status.output_width = self._output_width
            status.output_height = self._output_height
            status.fps = self._requested_fps
        return status

    async def arm(self, request: VirtualCamStartRequest | None = None) -> VirtualCamActionResult:
        """Arm the sink for on-demand feeding: standby frames while idle,
        the real pipeline only while an app consumes the virtual camera."""
        async with self._lifecycle_lock:
            self._armed = True
            if request is not None:
                self._armed_request = request
            elif self._armed_request is None:
                self._armed_request = VirtualCamStartRequest()
            self._ensure_demand_watch()
            sink = self._sink_path or _find_loopback_device()
            if sink is None or not sink.exists():
                return self._fail("no v4l2loopback device found; load the module first")
            sink = Path(os.path.realpath(sink))
            if self._running() or self._standby_running():
                return VirtualCamActionResult(
                    ok=True, running=self._running(), sink_path=str(sink)
                )
            if not await self._start_idle_locked(sink):
                return self._fail(
                    self._last_error or "standby feeder could not be started", sink
                )
            return VirtualCamActionResult(
                ok=True,
                running=False,
                pid=self._idle_process.pid if self._idle_process else None,
                sink_path=str(sink),
            )

    async def start(self, request: VirtualCamStartRequest) -> VirtualCamActionResult:
        async with self._lifecycle_lock:
            # A manual start arms on-demand too: the pipeline goes live now,
            # then returns to standby when the last consumer detaches.
            self._armed = True
            self._armed_request = request
            self._ensure_demand_watch()
            await self._stop_idle_locked()
            return await self._start_locked(request)

    def _ensure_demand_watch(self) -> None:
        if self._demand_task is None or self._demand_task.done():
            self._demand_task = asyncio.get_running_loop().create_task(self._demand_loop())

    async def _demand_loop(self) -> None:
        while True:
            try:
                await self._demand_tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                _LOG.exception("demand watch tick failed")
            await asyncio.sleep(DEMAND_POLL_S)

    def _own_live(self) -> bool:
        ffmpeg_live = self._process is not None and self._process.returncode is None
        pump_live = self._pump is not None and self._pump.running
        return ffmpeg_live or pump_live

    async def _recording_active(self) -> bool:
        # An active recording consumes the frame relay, not the sink — don't
        # drop to standby out from under it just because no app is reading.
        try:
            return (await get_video_service().recording_status()).recording
        except Exception:
            return True  # can't tell → keep the feed alive rather than risk it

    async def _demand_tick(self) -> None:
        if not self._armed or not virtualcam_on_demand():
            self._idle_since = None
            return
        sink = self._sink_path or _find_loopback_device()
        if sink is None:
            self._idle_since = None
            return
        consumers, writer_pid = await asyncio.to_thread(_scan_sink_holders, sink)
        foreign_writer = (
            writer_pid
            if writer_pid is not None and writer_pid not in self._own_writer_pids()
            else None
        )
        if consumers > 0:
            self._idle_since = None
            if self._own_live() or foreign_writer is not None:
                return
            if time.monotonic() < self._demand_backoff_until:
                return
            async with self._lifecycle_lock:
                await self._stop_idle_locked()
                result = await self._start_locked(
                    self._armed_request or VirtualCamStartRequest()
                )
                if not result.ok:
                    # Keep the sink's caps alive for the waiting app even
                    # though the source could not be claimed right now.
                    await self._start_idle_locked(sink)
            if result.ok:
                _LOG.info("demand start: %d consumer(s) on %s", consumers, sink)
            else:
                self._demand_backoff_until = time.monotonic() + DEMAND_START_BACKOFF_S
                _LOG.warning("demand start failed: %s", result.reason)
            return
        if self._own_live():
            if self._idle_since is None:
                self._idle_since = time.monotonic()
                return
            if time.monotonic() - self._idle_since < virtualcam_idle_grace_seconds():
                return
            async with self._lifecycle_lock:
                if await self._recording_active():
                    self._idle_since = time.monotonic()
                    return
                await self._stop_locked()
                await self._start_idle_locked(sink)
            self._idle_since = None
            _LOG.info("demand idle: camera released, standby feed on %s", sink)
            return
        # Armed but nothing owns the sink: a foreign writer is left alone;
        # otherwise (re)establish the standby feed so caps stay advertised.
        self._idle_since = None
        if foreign_writer is None and not self._standby_running():
            async with self._lifecycle_lock:
                if not self._standby_running():
                    await self._start_idle_locked(sink)

    async def _start_idle_locked(self, sink: Path) -> bool:
        request = self._armed_request or VirtualCamStartRequest()
        try:
            # Fixed names: standby spawns on every idle transition, so unique
            # tempfiles would leak a frame + log per cycle on restarts. They
            # live in a private runtime dir, not the shared /tmp.
            scratch = runtime_dir()
            frame_path = scratch / "standby-frame.yuyv"
            log_path = scratch / "standby.log"
            # Up to 32MB at the size cap: build it off the event loop.
            await asyncio.to_thread(
                _write_standby_frame, frame_path, request.output_width, request.output_height
            )
            stderr_log = log_path.open("wb")
        except OSError as exc:
            self._last_error = f"standby frame could not be written: {exc}"
            return False
        command = build_standby_command(
            request.output_width,
            request.output_height,
            STANDBY_FPS,
            str(frame_path),
            str(sink),
        )
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=stderr_log,
            )
        except OSError as exc:
            stderr_log.close()
            _remove_quietly(log_path)
            _remove_quietly(frame_path)
            self._last_error = _spawn_error_reason(exc)
            return False
        stderr_log.close()
        self._idle_process = process
        self._idle_stderr_path = str(log_path)
        self._idle_frame_path = str(frame_path)
        self._sink_path = sink
        await asyncio.sleep(SPAWN_WATCH_S)
        if process.returncode is not None:
            tail = _read_stderr_tail(str(log_path))
            if self._idle_process is process:
                self._idle_process = None
            if self._idle_stderr_path == str(log_path):
                self._idle_stderr_path = None
            if self._idle_frame_path == str(frame_path):
                self._idle_frame_path = None
            _remove_quietly(log_path)
            _remove_quietly(frame_path)
            self._last_error = (
                f"standby feeder exited immediately: {tail}"
                if tail
                else "standby feeder exited immediately"
            )
            return False
        return True

    async def _stop_idle_locked(self) -> None:
        process = self._idle_process
        self._idle_process = None
        _remove_quietly(self._idle_stderr_path)
        self._idle_stderr_path = None
        _remove_quietly(self._idle_frame_path)
        self._idle_frame_path = None
        if process is None or process.returncode is not None:
            return
        process.send_signal(signal.SIGINT)
        try:
            await asyncio.wait_for(process.wait(), timeout=3.0)
        except TimeoutError:
            process.kill()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(process.wait(), timeout=5.0)

    async def _start_locked(self, request: VirtualCamStartRequest) -> VirtualCamActionResult:
        if self._orphan_pid is not None:
            # A status() poll may have recorded a writer that died since;
            # refuse only on a live one, not on a stale pid.
            try:
                os.kill(self._orphan_pid, 0)
            except ProcessLookupError:
                self._orphan_pid = None
        if self._running():
            return VirtualCamActionResult(ok=False, running=True, reason="virtual camera already running")
        self._last_error = None
        sink = Path(request.sink_device) if request.sink_device else _find_loopback_device()
        if sink is None or not sink.exists():
            return self._fail("no v4l2loopback device found; load the module first")
        sink = Path(os.path.realpath(sink))
        _, orphan = await asyncio.to_thread(_scan_sink_holders, sink)
        if orphan is not None:
            await _kill_pid(orphan)
        source = Path(request.source_device) if request.source_device else _find_source_device()
        if source is None or not source.exists():
            return self._fail("no Pixy capture device found", sink)
        # A 90/270 rotation with default output dims means portrait out.
        if request.transform.rotate in (90, 270) and (
            request.output_width,
            request.output_height,
        ) == (request.input_width, request.input_height):
            request.output_width, request.output_height = request.input_height, request.input_width
        # Free the capture node from any preview stream only now that the
        # start is committed — doing it earlier kills previews on doomed
        # starts (already-running 409, missing source/sink).
        await get_video_service().stop_streams(None)
        if request.pipeline == "whiteboard":
            return await self._start_whiteboard(request, source, sink)
        return await self._start_transform(request, source, sink)

    async def _start_transform(
        self, request: VirtualCamStartRequest, source: Path, sink: Path
    ) -> VirtualCamActionResult:
        command = build_ffmpeg_command(request, str(source), str(sink))
        stderr_log = tempfile.NamedTemporaryFile(
            mode="wb", prefix="pixypilot-vcam-", suffix=".log", delete=False
        )
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdin=asyncio.subprocess.DEVNULL,
                # stdout carries the MJPEG preview tap — it must be drained
                # continuously or ffmpeg stalls and the virtual cam freezes.
                stdout=asyncio.subprocess.PIPE,
                stderr=stderr_log,
            )
        except OSError as exc:
            stderr_log.close()
            _remove_quietly(stderr_log.name)
            return self._fail(_spawn_error_reason(exc), sink)
        stderr_log.close()
        # Register before the spawn watch: during those 0.5s a status() poll
        # must not mistake our own feeder for a foreign orphan, stop() must
        # be able to kill it, and stream requests must see the relay rather
        # than racing the feeder for the physical device.
        self._process = process
        self._stderr_path = stderr_log.name
        self._relay = FrameRelay()
        self._relay_task = asyncio.get_running_loop().create_task(
            self._drain_preview_tap(process, self._relay)
        )
        self._activate(request, source, sink)
        await asyncio.sleep(SPAWN_WATCH_S)
        if process.returncode is not None:
            tail = _read_stderr_tail(stderr_log.name)
            if self._process is process:
                self._process = None
            if self._stderr_path == stderr_log.name:
                self._stderr_path = None
            await self._clear_relay()
            _remove_quietly(stderr_log.name)
            return self._fail(
                f"ffmpeg exited immediately: {tail}" if tail else "ffmpeg exited immediately",
                sink,
            )
        return VirtualCamActionResult(
            ok=True,
            running=True,
            pid=process.pid,
            sink_path=str(sink),
            source_device=str(source),
        )

    async def _start_whiteboard(
        self, request: VirtualCamStartRequest, source: Path, sink: Path
    ) -> VirtualCamActionResult:
        try:
            from pixypilot.domains.whiteboard.pump import WhiteboardPump
        except ImportError:
            return self._fail("whiteboard mode requires opencv (python-cv2), which is not installed", sink)
        pump = WhiteboardPump(
            str(source),
            str(sink),
            request.input_width,
            request.input_height,
            request.input_fps,
            request.output_width,
            request.output_height,
        )
        try:
            await pump.start()
        except OSError as exc:
            return self._fail(_spawn_error_reason(exc), sink)
        except Exception as exc:  # cv2/ffmpeg setup failures surface, not 500
            return self._fail(f"whiteboard pipeline could not be started: {exc}", sink)
        # Unlike the ffmpeg path, the pump reports "running" the moment its
        # feeder exists — even when cv2 can never open a busy camera. Wait for
        # the first real frame so a dead pipeline is not sold as streaming.
        deadline = WHITEBOARD_FIRST_FRAME_TIMEOUT_S
        elapsed = 0.0
        while pump.frames_pumped == 0 and elapsed < deadline:
            if not pump.running:
                break
            await asyncio.sleep(0.25)
            elapsed += 0.25
        if pump.frames_pumped == 0:
            pump_died = not pump.running
            await pump.stop()
            if pump_died:
                return self._fail(
                    "whiteboard pipeline stopped before producing any frames — "
                    "the camera may be busy, unreadable, or not delivering video",
                    sink,
                )
            return self._fail(
                f"whiteboard pipeline produced no frames within {deadline:g}s — "
                "the camera is busy, unreadable, or not delivering video",
                sink,
            )
        self._pump = pump
        self._activate(request, source, sink)
        return VirtualCamActionResult(
            ok=True,
            running=True,
            pid=self._pump_feeder_pid(),
            sink_path=str(sink),
            source_device=str(source),
        )

    async def stop(self) -> VirtualCamActionResult:
        # Stop means stop: release the camera AND free the sink (no standby
        # feed). The watcher is cancelled after our own teardown wins the
        # lifecycle lock so a mid-transition tick can't leave partial state.
        self._armed = False
        async with self._lifecycle_lock:
            result = await self._stop_locked()
            await self._stop_idle_locked()
        task = self._demand_task
        self._demand_task = None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        return result

    async def _stop_locked(self) -> VirtualCamActionResult:
        await self._clear_relay()
        pump = self._pump
        self._pump = None
        if pump is not None:
            await pump.stop()
        process = self._process
        self._process = None
        _remove_quietly(self._stderr_path)
        self._stderr_path = None
        if process is not None and process.returncode is None:
            process.send_signal(signal.SIGINT)
            try:
                await asyncio.wait_for(process.wait(), timeout=3.0)
            except TimeoutError:
                process.kill()
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(process.wait(), timeout=5.0)
        orphan = self._orphan_pid
        self._orphan_pid = None
        if orphan is not None:
            await _kill_pid(orphan)
        return VirtualCamActionResult(ok=True, running=False, sink_path=str(self._sink_path) if self._sink_path else None)


_SERVICE = VirtualCamService()


def get_virtualcam_service() -> VirtualCamService:
    return _SERVICE
