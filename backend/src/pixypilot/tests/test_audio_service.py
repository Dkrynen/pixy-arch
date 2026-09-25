import asyncio
import signal
import struct

import pytest

import pixypilot.domains.audio.service as audio_module
from pixypilot.core.commands import CommandResult
from pixypilot.domains.audio.service import (
    AudioService,
    _parse_mic_muted,
    _parse_mic_volume,
    _parse_mic_volume_percent,
    _parse_pixy_card,
    _pcm_s16le_level,
)


def test_parse_pixy_card_from_arecord_output() -> None:
    output = """
card 1: Wireless [Arctis Nova Pro Wireless], device 0: USB Audio [USB Audio]
card 3: PIXY [EMEET PIXY], device 0: USB Audio [USB Audio]
"""

    assert _parse_pixy_card(output) == 3


def test_parse_mic_mute_and_volume_from_amixer_contents() -> None:
    output = """
numid=2,iface=MIXER,name='Mic Capture Switch'
  ; type=BOOLEAN,access=rw------,values=1
  : values=off
numid=3,iface=MIXER,name='Mic Capture Volume'
  ; type=INTEGER,access=rw---R--,values=1,min=0,max=10,step=0
  : values=7
"""

    assert _parse_mic_muted(output) is True
    assert _parse_mic_volume(output) == 7


def test_parse_mic_volume_percent_scales_to_control_bounds() -> None:
    # The PIXY exposes raw 0-10; the API speaks percent like PATCH /audio/volume.
    output = """
numid=3,iface=MIXER,name='Mic Capture Volume'
  ; type=INTEGER,access=rw---R--,values=1,min=0,max=10,step=0
  : values=7
"""

    assert _parse_mic_volume_percent(output) == 70


def test_parse_mic_volume_percent_handles_full_and_zero() -> None:
    output = """
numid=3,iface=MIXER,name='Mic Capture Volume'
  ; type=INTEGER,access=rw---R--,values=1,min=0,max=10,step=0
  : values=10
numid=4,iface=MIXER,name='Mic Capture Volume'
  ; type=INTEGER,access=rw---R--,values=1,min=0,max=10,step=0
  : values=0
"""

    assert _parse_mic_volume_percent(output) == 100


def test_parse_mic_volume_percent_falls_back_to_raw_without_bounds() -> None:
    output = """
numid=3,iface=MIXER,name='Mic Capture Volume'
  ; type=INTEGER,access=rw---R--,values=1
  : values=42
"""

    assert _parse_mic_volume_percent(output) == 42


def test_pcm_s16le_level_silence_is_zero() -> None:
    assert _pcm_s16le_level(b"\x00" * 4096) == 0


def test_pcm_s16le_level_full_scale_is_hundred() -> None:
    chunk = struct.pack("<2048h", *([32767] * 2048))

    assert _pcm_s16le_level(chunk) == 100


def test_pcm_s16le_level_scales_quiet_signal() -> None:
    # ~-30 dBFS RMS should land near the middle of the -60 dBFS floor scale.
    amplitude = round(32768 * 10 ** (-30 / 20))
    chunk = struct.pack("<2048h", *([amplitude, -amplitude] * 1024))
    level = _pcm_s16le_level(chunk)

    assert level is not None
    assert 45 <= level <= 55


AMIXER_CONTENTS_NUMID_5 = """
numid=4,iface=MIXER,name='Mic Capture Volume'
  ; type=INTEGER,access=rw---R--,values=1,min=0,max=10,step=0
  : values=7
numid=5,iface=MIXER,name='Mic Capture Switch'
  ; type=BOOLEAN,access=rw------,values=1
  : values=on
"""


class FakeRunner:
    def __init__(self, contents: str) -> None:
        self.contents = contents
        self.calls: list[list[str]] = []

    async def run(self, argv: list[str]) -> CommandResult:
        self.calls.append(argv)
        if argv[:2] == ["arecord", "-l"]:
            return CommandResult("card 3: PIXY [EMEET PIXY], device 0: USB Audio [USB Audio]\n", "", 0)
        if argv[-1] == "contents":
            return CommandResult(self.contents, "", 0)
        return CommandResult("", "", 0)


async def test_set_mute_looks_up_switch_numid_by_name() -> None:
    runner = FakeRunner(AMIXER_CONTENTS_NUMID_5)
    service = AudioService(runner=runner)

    result = await service.set_mute(True)

    assert result.ok is True
    assert runner.calls[-1] == ["amixer", "-c", "3", "cset", "numid=5", "off"]


async def test_set_mute_reports_missing_switch() -> None:
    runner = FakeRunner("numid=4,iface=MIXER,name='Mic Capture Volume'\n  : values=7\n")
    service = AudioService(runner=runner)

    with pytest.raises(FileNotFoundError, match="Mic Capture Switch"):
        await service.set_mute(False)
    assert not any("cset" in call for call in runner.calls)


class FakeMeterProcess:
    pid = 5150

    def __init__(self) -> None:
        self.returncode: int | None = None
        self.stdout = asyncio.StreamReader()
        self.signals: list[int] = []

    def send_signal(self, sig: int) -> None:
        self.signals.append(sig)
        self.returncode = 0
        self.stdout.feed_eof()

    def kill(self) -> None:
        self.returncode = -9
        self.stdout.feed_eof()

    async def wait(self) -> int | None:
        return self.returncode


def _fake_meter(monkeypatch) -> tuple[AudioService, list[FakeMeterProcess]]:
    spawned: list[FakeMeterProcess] = []

    async def fake_exec(*args, **kwargs):
        process = FakeMeterProcess()
        spawned.append(process)
        return process

    async def pixy_node():
        return {"id": 77, "name": "alsa_input.usb-EMEET_PIXY"}

    monkeypatch.setattr(audio_module.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(audio_module, "METER_IDLE_TIMEOUT_S", 0.3)
    monkeypatch.setattr(audio_module, "METER_IDLE_CHECK_S", 0.02)
    service = AudioService(runner=FakeRunner(""))
    monkeypatch.setattr(service, "find_pixy_source_node", pixy_node)
    return service, spawned


async def test_meter_stops_itself_when_nobody_polls(monkeypatch) -> None:
    service, spawned = _fake_meter(monkeypatch)

    started = await service.start_meter()
    assert started.running is True

    for _ in range(100):
        if spawned[0].signals:
            break
        await asyncio.sleep(0.02)

    assert spawned[0].signals == [signal.SIGINT]
    assert service._meter is None  # noqa: SLF001
    assert (await service.meter_status()).running is False


async def test_polled_meter_keeps_running(monkeypatch) -> None:
    service, spawned = _fake_meter(monkeypatch)

    await service.start_meter()
    for _ in range(25):  # ~0.5s, longer than the 0.3s idle timeout
        await asyncio.sleep(0.02)
        await service.meter_status()

    assert spawned[0].signals == []
    assert (await service.meter_status()).running is True
    await service.stop_meter()
    assert service._meter_idle_task is None  # noqa: SLF001
