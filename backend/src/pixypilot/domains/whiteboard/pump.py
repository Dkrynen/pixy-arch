import asyncio
import contextlib

import cv2
import numpy as np

from pixypilot.domains.whiteboard.detector import detect_quad, quads_close, warp_to_quad

DETECT_INTERVAL_FRAMES = 15


class WhiteboardPump:
    # cv2 does the detection/warp; an ffmpeg feeder converts BGR frames to
    # YUYV on the loopback node (same sink path as the transform pipeline).
    def __init__(
        self,
        source_path: str,
        sink_path: str,
        width: int,
        height: int,
        fps: float,
        out_width: int,
        out_height: int,
    ) -> None:
        self.source_path = source_path
        self.sink_path = sink_path
        self.width = width
        self.height = height
        self.fps = fps
        self.out_width = out_width
        self.out_height = out_height
        self._task: asyncio.Task | None = None
        self._feeder: asyncio.subprocess.Process | None = None
        self.last_quad: np.ndarray | None = None
        self.frames_pumped = 0

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def start(self) -> None:
        if self.running:
            return
        self._feeder = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgr24",
            "-s",
            f"{self.out_width}x{self.out_height}",
            "-r",
            f"{self.fps:g}",
            "-i",
            "-",
            "-f",
            "v4l2",
            "-pix_fmt",
            "yuyv422",
            self.sink_path,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        task = self._task
        self._task = None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        feeder = self._feeder
        self._feeder = None
        if feeder is not None:
            if feeder.stdin:
                feeder.stdin.close()
            try:
                await asyncio.wait_for(feeder.wait(), timeout=3.0)
            except TimeoutError:
                feeder.kill()
                await feeder.wait()

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        opening = asyncio.ensure_future(asyncio.to_thread(self._open_capture))
        try:
            capture = await asyncio.shield(opening)
        except asyncio.CancelledError:
            # Stopped mid-open: release the capture once the open lands.
            opening.add_done_callback(_release_opened_capture)
            raise
        frame_index = 0
        reading: asyncio.Future | None = None
        try:
            while True:
                # Shielded task, not a bare executor future: cancelling the
                # pump must not lose track of a read still running in its
                # thread (see the finally below).
                reading = asyncio.ensure_future(asyncio.to_thread(capture.read))
                ok, frame = await asyncio.shield(reading)
                if not ok or frame is None:
                    await asyncio.sleep(0.05)
                    continue
                frame_index += 1
                if frame_index % DETECT_INTERVAL_FRAMES == 1 or self.last_quad is None:
                    quad = await loop.run_in_executor(None, detect_quad, frame)
                    if not quads_close(quad, self.last_quad):
                        if quad is not None:
                            self.last_quad = quad
                output = frame
                if self.last_quad is not None:
                    output = warp_to_quad(frame, self.last_quad, self.out_width, self.out_height)
                elif output.shape[1] != self.out_width or output.shape[0] != self.out_height:
                    output = cv2.resize(output, (self.out_width, self.out_height))
                self.frames_pumped += 1
                if self._feeder and self._feeder.stdin:
                    try:
                        self._feeder.stdin.write(output.tobytes())
                        await self._feeder.stdin.drain()
                    except (BrokenPipeError, ConnectionResetError):
                        return
        finally:
            if reading is not None and not reading.done():
                # OpenCV can crash when release() runs while read() is still
                # in flight on another thread: let the read finish first.
                with contextlib.suppress(Exception):
                    await reading
            capture.release()

    def _open_capture(self) -> cv2.VideoCapture:
        capture = cv2.VideoCapture(self.source_path, cv2.CAP_V4L2)
        if not capture.isOpened():
            capture.release()
            raise OSError(f"unable to open capture device {self.source_path}")
        capture.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter.fourcc("M", "J", "P", "G"))
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        capture.set(cv2.CAP_PROP_FPS, self.fps)
        return capture


def _release_opened_capture(opening: "asyncio.Future[cv2.VideoCapture]") -> None:
    if opening.cancelled() or opening.exception() is not None:
        return
    opening.result().release()
