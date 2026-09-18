import asyncio

from pixypilot.domains.hotplug.models import HotplugEvent
from pixypilot.domains.hotplug.service import HotplugService, _event_from_device


class FakeDevice:
    def __init__(self, subsystem: str, device_node: str | None, action: str | None = "add") -> None:
        self.subsystem = subsystem
        self.device_node = device_node
        self.action = action


def test_video4linux_event_is_mapped_to_video_hotplug_event() -> None:
    event = _event_from_device(FakeDevice("video4linux", "/dev/video0", "add"))

    assert event is not None
    assert event.action == "add"
    assert event.subsystem == "video4linux"
    assert event.device_node == "/dev/video0"
    assert event.device_type == "video"


def test_hidraw_event_is_mapped_to_hid_hotplug_event() -> None:
    event = _event_from_device(FakeDevice("hidraw", "/dev/hidraw14", "change"))

    assert event is not None
    assert event.action == "change"
    assert event.subsystem == "hidraw"
    assert event.device_node == "/dev/hidraw14"
    assert event.device_type == "hid"


def test_unrelated_subsystem_is_ignored() -> None:
    assert _event_from_device(FakeDevice("block", "/dev/sda")) is None


class FakeObserver:
    def __init__(self) -> None:
        self.stopped = False
        self.joined = False

    def stop(self) -> None:
        self.stopped = True

    def join(self, timeout: float | None = None) -> None:
        self.joined = True


async def test_events_yields_queued_events_and_stops_observer(monkeypatch) -> None:
    service = HotplugService()
    observer = FakeObserver()
    captured: dict[str, asyncio.Queue] = {}

    def fake_start(loop, queue):
        captured["queue"] = queue
        return observer

    monkeypatch.setattr(
        "pixypilot.domains.hotplug.service._start_observer",
        fake_start,
    )

    event = HotplugEvent(
        action="add",
        subsystem="video4linux",
        device_node="/dev/video0",
        device_type="video",
    )

    async def produce() -> None:
        while "queue" not in captured:
            await asyncio.sleep(0)
        await captured["queue"].put(event)
        await captured["queue"].put(None)

    producer = asyncio.create_task(produce())
    received = [item async for item in service.events()]
    await producer

    assert received == [event]
    assert observer.stopped is True
    assert observer.joined is True
