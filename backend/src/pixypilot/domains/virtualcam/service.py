import asyncio
import os
import signal
import tempfile
from pathlib import Path

from pixypilot.config import virtualcam_device, virtualcam_label
from pixypilot.domains.virtualcam.models import (
    VirtualCamActionResult,
    VirtualCamStartRequest,
    VirtualCamStatus,
    VirtualCamTransform,
)
from pixypilot.domains.whiteboard.pump import WhiteboardPump

VIDEO4LINUX_SYSFS = Path("/sys/class/video4linux")


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
    return [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "v4l2",
        "-input_format",
        "mjpeg",
        "-video_size",
        f"{request.input_width}x{request.input_height}",
        "-framerate",
        f"{request.input_fps:g}",
        "-i",
        source_path,
        "-vf",
        filters,
        "-f",
        "v4l2",
        "-pix_fmt",
        "yuyv422",
        sink_path,
    ]


def _find_loopback_device() -> Path | None:
    override = virtualcam_device()
    if override is not None and override.exists():
        return override
    label = virtualcam_label().lower()
    if not VIDEO4LINUX_SYSFS.is_dir():
        return None
    for entry in sorted(VIDEO4LINUX_SYSFS.iterdir()):
        name_file = entry / "name"
        try:
            name = name_file.read_text(encoding="utf-8").strip().lower()
        except OSError:
            continue
        if label in name or "v4l2loopback" in name or "loopback" in name:
            return Path("/dev") / entry.name
    return None


def _find_source_device() -> Path | None:
    if not VIDEO4LINUX_SYSFS.is_dir():
        return None
    for entry in sorted(VIDEO4LINUX_SYSFS.iterdir()):
        name_file = entry / "name"
        try:
            name = name_file.read_text(encoding="utf-8").strip().lower()
        except OSError:
            continue
        if "pixy" in name:
            return Path("/dev") / entry.name
    return None


def _find_sink_writer_pid(sink: Path) -> int | None:
    # An ffmpeg pipeline survives a server restart and keeps owning both the
    # source and the sink, so look for a stale writer before trusting state.
    sink_arg = str(sink).encode()
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            parts = (entry / "cmdline").read_bytes().split(b"\0")
        except OSError:
            continue
        if parts and parts[0].endswith(b"ffmpeg") and sink_arg in parts:
            return int(entry.name)
    return None


def _read_stderr_tail(path: str, max_bytes: int = 4000) -> str:
    try:
        data = Path(path).read_bytes()
    except OSError:
        return ""
    text = data.decode("utf-8", errors="replace").strip()
    return text[-max_bytes:]


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


class VirtualCamService:
    # The Pixy is a single-consumer device: while a pipeline owns the
    # capture node, consumers (including the PixyPilot preview) must read
    # the loopback output instead of the physical device.
    def __init__(self) -> None:
        self._process: asyncio.subprocess.Process | None = None
        self._pump: WhiteboardPump | None = None
        self._orphan_pid: int | None = None
        self._pipeline = "transform"
        self._sink_path: Path | None = None
        self._source_path: Path | None = None
        self._transform = VirtualCamTransform()

    def _running(self) -> bool:
        ffmpeg_running = self._process is not None and self._process.returncode is None
        pump_running = self._pump is not None and self._pump.running
        orphan_running = self._orphan_pid is not None
        return ffmpeg_running or pump_running or orphan_running

    async def status(self) -> VirtualCamStatus:
        sink = _find_loopback_device()
        if self._process is not None and self._process.returncode is not None:
            self._process = None
        if self._pump is not None and not self._pump.running:
            self._pump = None
        if self._orphan_pid is not None:
            try:
                os.kill(self._orphan_pid, 0)
            except ProcessLookupError:
                self._orphan_pid = None
        if not self._running() and sink is not None:
            self._orphan_pid = _find_sink_writer_pid(sink)
        running = self._running()
        pid = self._process.pid if self._process else self._orphan_pid
        return VirtualCamStatus(
            available=sink is not None,
            sink_path=str(sink) if sink else None,
            running=running,
            pid=pid if running else None,
            pipeline=self._pipeline,
            source_device=str(self._source_path) if self._source_path else None,
            transform=self._transform,
            reason=None if sink else "no v4l2loopback device found (install v4l2loopback-dkms and load the module)",
        )

    async def start(self, request: VirtualCamStartRequest) -> VirtualCamActionResult:
        if self._running():
            return VirtualCamActionResult(ok=False, running=True, reason="virtual camera already running")
        sink = Path(request.sink_device) if request.sink_device else _find_loopback_device()
        if sink is None or not sink.exists():
            return VirtualCamActionResult(ok=False, reason="no v4l2loopback device found; load the module first")
        orphan = _find_sink_writer_pid(sink)
        if orphan is not None:
            await _kill_pid(orphan)
        source = Path(request.source_device) if request.source_device else _find_source_device()
        if source is None or not source.exists():
            return VirtualCamActionResult(ok=False, sink_path=str(sink), reason="no Pixy capture device found")
        # A 90/270 rotation with default output dims means portrait out.
        if request.transform.rotate in (90, 270) and (
            request.output_width,
            request.output_height,
        ) == (request.input_width, request.input_height):
            request.output_width, request.output_height = request.input_height, request.input_width
        self._sink_path = sink
        self._source_path = source
        self._transform = request.transform
        self._pipeline = request.pipeline
        if request.pipeline == "whiteboard":
            self._pump = WhiteboardPump(
                str(source),
                str(sink),
                request.input_width,
                request.input_height,
                request.input_fps,
                request.output_width,
                request.output_height,
            )
            await self._pump.start()
            return VirtualCamActionResult(ok=True, running=True, sink_path=str(sink))
        command = build_ffmpeg_command(request, str(source), str(sink))
        stderr_log = tempfile.NamedTemporaryFile(
            mode="wb", prefix="pixypilot-vcam-", suffix=".log", delete=False
        )
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=stderr_log,
        )
        stderr_log.close()
        await asyncio.sleep(0.5)
        if process.returncode is not None:
            reason = _read_stderr_tail(stderr_log.name)
            return VirtualCamActionResult(
                ok=False,
                running=False,
                sink_path=str(sink),
                reason=f"ffmpeg exited immediately: {reason}" if reason else "ffmpeg exited immediately",
            )
        self._process = process
        return VirtualCamActionResult(ok=True, running=True, pid=self._process.pid, sink_path=str(sink))

    async def stop(self) -> VirtualCamActionResult:
        pump = self._pump
        self._pump = None
        if pump is not None:
            await pump.stop()
        process = self._process
        self._process = None
        if process is not None and process.returncode is None:
            process.send_signal(signal.SIGINT)
            try:
                await asyncio.wait_for(process.wait(), timeout=3.0)
            except TimeoutError:
                process.kill()
                await process.wait()
        orphan = self._orphan_pid
        self._orphan_pid = None
        if orphan is not None:
            await _kill_pid(orphan)
        return VirtualCamActionResult(ok=True, running=False, sink_path=str(self._sink_path) if self._sink_path else None)


_SERVICE = VirtualCamService()


def get_virtualcam_service() -> VirtualCamService:
    return _SERVICE
