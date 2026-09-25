import asyncio
import threading

from pixypilot.domains.whiteboard.pump import WhiteboardPump


class BlockingCapture:
    """Stands in for cv2.VideoCapture: release() during read() is the crash."""

    def __init__(self) -> None:
        self.reading = threading.Event()
        self.unblock = threading.Event()
        self.in_read = False
        self.released_during_read = False
        self.released = False

    def read(self):
        self.in_read = True
        self.reading.set()
        self.unblock.wait(5)
        self.in_read = False
        return False, None

    def release(self) -> None:
        self.released_during_read = self.in_read
        self.released = True


async def test_stop_waits_for_inflight_read_before_release(monkeypatch) -> None:
    capture = BlockingCapture()
    pump = WhiteboardPump("/dev/video2", "/dev/video10", 640, 480, 30.0, 640, 480)
    monkeypatch.setattr(pump, "_open_capture", lambda: capture)
    pump._task = asyncio.create_task(pump._run())  # noqa: SLF001

    await asyncio.to_thread(capture.reading.wait, 2)
    threading.Timer(0.1, capture.unblock.set).start()
    await pump.stop()

    assert capture.released is True
    assert capture.released_during_read is False


async def test_capture_opened_after_stop_is_released(monkeypatch) -> None:
    capture = BlockingCapture()
    opening = threading.Event()
    finish_open = threading.Event()

    def slow_open():
        opening.set()
        finish_open.wait(5)
        return capture

    pump = WhiteboardPump("/dev/video2", "/dev/video10", 640, 480, 30.0, 640, 480)
    monkeypatch.setattr(pump, "_open_capture", slow_open)
    pump._task = asyncio.create_task(pump._run())  # noqa: SLF001

    await asyncio.to_thread(opening.wait, 2)
    await pump.stop()
    assert capture.released is False
    finish_open.set()
    for _ in range(100):
        if capture.released:
            break
        await asyncio.sleep(0.01)

    assert capture.released is True
