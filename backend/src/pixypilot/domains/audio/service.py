import asyncio
import json
import math
import re
import signal
import struct

from pixypilot.core.commands import AsyncCommandRunner, CommandError
from pixypilot.domains.audio.models import AudioCommandResult, AudioMonitorResult, AudioStatus

PIXY_AUDIO_NAME = "EMEET PIXY"
PIXY_NODE_NAME_RE = re.compile(r"EMEET_PIXY", re.IGNORECASE)
MIC_SWITCH_NUMID = "2"

CARD_LINE_RE = re.compile(r"card\s+(?P<card>\d+):\s+(?P<short>[^\[]+)\[(?P<long>[^\]]+)\]")
VALUE_RE = re.compile(r": values=(?P<value>.+)")
BOUNDS_RE = re.compile(r"min=(?P<min>-?\d+),max=(?P<max>-?\d+)")

METER_SAMPLE_RATE = 48000
METER_CHANNELS = 1
METER_SAMPLE_FORMAT = "s16"
# ~85 ms of 48 kHz s16 mono per read — a ~12 Hz meter refresh.
METER_CHUNK_BYTES = 8192
METER_FLOOR_DB = -60.0


class AudioService:
    def __init__(self, runner: AsyncCommandRunner | None = None) -> None:
        self.runner = runner or AsyncCommandRunner()
        self._monitor: asyncio.subprocess.Process | None = None
        self._monitor_node: str | None = None
        self._meter: asyncio.subprocess.Process | None = None
        self._meter_node: str | None = None
        self._meter_task: asyncio.Task | None = None
        self._level: int | None = None
        self._previous_default_source_id: int | None = None

    async def status(self) -> AudioStatus:
        card = await self.find_pixy_card()
        node = await self.find_pixy_source_node()
        monitor_running = self._monitor is not None and self._monitor.returncode is None
        meter_running = self._meter is not None and self._meter.returncode is None
        if card is None:
            return AudioStatus(
                available=False,
                source_node=node["name"] if node else None,
                monitor_running=monitor_running,
                meter_running=meter_running,
                reason="EMEET PIXY audio capture device was not found",
            )

        try:
            contents = await self._card_contents(card)
        except CommandError as exc:
            return AudioStatus(available=False, card=card, reason=str(exc))

        muted = _parse_mic_muted(contents)
        volume = _parse_mic_volume_percent(contents)
        return AudioStatus(
            available=muted is not None,
            card=card,
            name=PIXY_AUDIO_NAME,
            muted=muted,
            volume=volume,
            source_node=node["name"] if node else None,
            default_source=await self.is_default_source() if node else None,
            previous_default_source=self._previous_default_source_id is not None,
            monitor_running=monitor_running,
            meter_running=meter_running,
            level=self._level if meter_running else None,
            reason=None if muted is not None else "Mic Capture Switch was not found",
        )

    async def set_mute(self, muted: bool) -> AudioCommandResult:
        card = await self.find_pixy_card()
        if card is None:
            raise FileNotFoundError("EMEET PIXY audio capture device was not found")

        value = "off" if muted else "on"
        await self.runner.run(["amixer", "-c", str(card), "cset", f"numid={MIC_SWITCH_NUMID}", value])
        return AudioCommandResult(ok=True, command="mic_mute", value=muted, card=card)

    async def set_volume(self, percent: int) -> AudioCommandResult:
        card = await self.find_pixy_card()
        if card is None:
            raise FileNotFoundError("EMEET PIXY audio capture device was not found")
        contents = await self._card_contents(card)
        numid = _control_numid(contents, "Mic Capture Volume")
        if numid is None:
            raise FileNotFoundError("Mic Capture Volume control was not found")
        await self.runner.run(["amixer", "-c", str(card), "cset", f"numid={numid}", f"{percent}%"])
        return AudioCommandResult(ok=True, command="mic_volume", value=percent, card=card)

    async def find_pixy_source_node(self) -> dict | None:
        # Match on media.class=Audio/Source, not the nickname — the video and
        # audio nodes can both carry the "EMEET PIXY" label.
        try:
            result = await self.runner.run(["pw-dump"])
        except CommandError:
            return None
        try:
            objects = json.loads(result.stdout)
        except json.JSONDecodeError:
            return None
        for obj in objects:
            props = obj.get("info", {}).get("props", {})
            if props.get("media.class") != "Audio/Source":
                continue
            name = props.get("node.name", "")
            if PIXY_NODE_NAME_RE.search(name):
                return {"id": obj.get("id"), "name": name}
        return None

    async def is_default_source(self) -> bool | None:
        node = await self.find_pixy_source_node()
        if node is None:
            return None
        try:
            result = await self.runner.run(["wpctl", "inspect", "@DEFAULT_AUDIO_SOURCE@"])
        except CommandError:
            return None
        return node["name"] in result.stdout

    async def set_default_source(self) -> AudioCommandResult:
        node = await self.find_pixy_source_node()
        if node is None:
            raise FileNotFoundError("EMEET PIXY PipeWire source node was not found")
        previous_id = await self._current_default_source_id()
        if previous_id is not None and previous_id != node["id"]:
            self._previous_default_source_id = previous_id
        await self.runner.run(["wpctl", "set-default", str(node["id"])])
        return AudioCommandResult(ok=True, command="default_source", value=node["name"])

    async def restore_default_source(self) -> AudioCommandResult:
        if self._previous_default_source_id is None:
            raise FileNotFoundError("No previous default source was captured this session")
        await self.runner.run(["wpctl", "set-default", str(self._previous_default_source_id)])
        restored = self._previous_default_source_id
        self._previous_default_source_id = None
        return AudioCommandResult(ok=True, command="default_source_restore", value=str(restored))

    async def _current_default_source_id(self) -> int | None:
        try:
            result = await self.runner.run(["wpctl", "inspect", "@DEFAULT_AUDIO_SOURCE@"])
        except CommandError:
            return None
        match = re.search(r"^id\s+(\d+)", result.stdout, re.MULTILINE)
        return int(match.group(1)) if match else None

    async def monitor_status(self) -> AudioMonitorResult:
        running = self._monitor is not None and self._monitor.returncode is None
        return AudioMonitorResult(
            ok=True,
            running=running,
            pid=self._monitor.pid if running and self._monitor else None,
            source_node=self._monitor_node,
        )

    async def start_monitor(self) -> AudioMonitorResult:
        if self._monitor is not None and self._monitor.returncode is None:
            return AudioMonitorResult(ok=True, running=True, pid=self._monitor.pid, source_node=self._monitor_node)
        node = await self.find_pixy_source_node()
        if node is None:
            return AudioMonitorResult(ok=False, running=False, reason="EMEET PIXY PipeWire source node was not found")
        try:
            self._monitor = await asyncio.create_subprocess_exec(
                "pw-loopback",
                f"--capture={node['name']}",
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
        except OSError as exc:
            return AudioMonitorResult(ok=False, running=False, reason=f"pw-loopback could not be started: {exc}")
        self._monitor_node = node["name"]
        return AudioMonitorResult(ok=True, running=True, pid=self._monitor.pid, source_node=node["name"])

    async def stop_monitor(self) -> AudioMonitorResult:
        process = self._monitor
        self._monitor = None
        if process is None or process.returncode is not None:
            return AudioMonitorResult(ok=True, running=False, source_node=self._monitor_node)
        process.send_signal(signal.SIGINT)
        try:
            await asyncio.wait_for(process.wait(), timeout=3.0)
        except TimeoutError:
            process.kill()
            await process.wait()
        return AudioMonitorResult(ok=True, running=False, source_node=self._monitor_node)

    async def meter_status(self) -> AudioMonitorResult:
        running = self._meter is not None and self._meter.returncode is None
        return AudioMonitorResult(
            ok=True,
            running=running,
            pid=self._meter.pid if running and self._meter else None,
            source_node=self._meter_node,
            level=self._level if running else None,
        )

    async def start_meter(self) -> AudioMonitorResult:
        if self._meter is not None and self._meter.returncode is None:
            return await self.meter_status()
        node = await self.find_pixy_source_node()
        if node is None:
            return AudioMonitorResult(
                ok=False, running=False, reason="EMEET PIXY PipeWire source node was not found"
            )
        # Meter via PipeWire, not hw:X — the ALSA capture node is single-open,
        # while PipeWire lets the meter share the mic with calls/monitoring.
        try:
            self._meter = await asyncio.create_subprocess_exec(
                "pw-cat",
                "-r",
                "--target",
                node["name"],
                "--format",
                METER_SAMPLE_FORMAT,
                "--rate",
                str(METER_SAMPLE_RATE),
                "--channels",
                str(METER_CHANNELS),
                "-",
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
        except OSError as exc:
            return AudioMonitorResult(ok=False, running=False, reason=f"pw-cat could not be started: {exc}")
        self._meter_node = node["name"]
        self._level = None
        self._meter_task = asyncio.create_task(self._read_meter(self._meter))
        # A bad target makes pw-cat exit immediately — surface that instead of
        # reporting a running meter that produces nothing.
        await asyncio.sleep(0.15)
        if self._meter.returncode is not None:
            exit_code = self._meter.returncode
            self._meter = None
            self._meter_task = None
            return AudioMonitorResult(
                ok=False,
                running=False,
                source_node=node["name"],
                reason=f"pw-cat exited immediately (code {exit_code})",
            )
        return await self.meter_status()

    async def stop_meter(self) -> AudioMonitorResult:
        process = self._meter
        task = self._meter_task
        self._meter = None
        self._meter_task = None
        if process is not None and process.returncode is None:
            process.send_signal(signal.SIGINT)
            try:
                await asyncio.wait_for(process.wait(), timeout=3.0)
            except TimeoutError:
                process.kill()
                await process.wait()
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._level = None
        return AudioMonitorResult(ok=True, running=False, source_node=self._meter_node)

    async def _read_meter(self, process: asyncio.subprocess.Process) -> None:
        if process.stdout is None:
            return
        try:
            while True:
                chunk = await process.stdout.read(METER_CHUNK_BYTES)
                if not chunk:
                    break
                level = _pcm_s16le_level(chunk)
                if level is not None and self._meter is process:
                    self._level = level
        except asyncio.CancelledError:
            raise
        except OSError:
            pass
        finally:
            if self._meter is process:
                self._level = None

    async def find_pixy_card(self) -> int | None:
        try:
            result = await self.runner.run(["arecord", "-l"])
        except CommandError:
            return None
        return _parse_pixy_card(result.stdout)

    async def _card_contents(self, card: int) -> str:
        result = await self.runner.run(["amixer", "-c", str(card), "contents"])
        return result.stdout


def _parse_pixy_card(output: str) -> int | None:
    for line in output.splitlines():
        match = CARD_LINE_RE.search(line)
        if not match:
            continue
        if "EMEET PIXY" in line:
            return int(match.group("card"))
    return None


def _parse_mic_muted(output: str) -> bool | None:
    switch_block = _control_block(output, "Mic Capture Switch")
    if switch_block is None:
        return None
    value = _parse_value(switch_block)
    if value is None:
        return None
    return value.strip().lower() == "off"


def _parse_mic_volume(output: str) -> int | None:
    volume_block = _control_block(output, "Mic Capture Volume")
    if volume_block is None:
        return None
    value = _parse_value(volume_block)
    if value is None:
        return None
    try:
        return int(value.strip())
    except ValueError:
        return None


def _parse_mic_volume_percent(output: str) -> int | None:
    # PATCH /audio/volume takes percent, so status reports percent: scale the
    # raw ALSA value by the control's own min/max (PIXY exposes 0-10).
    volume_block = _control_block(output, "Mic Capture Volume")
    if volume_block is None:
        return None
    value = _parse_value(volume_block)
    if value is None:
        return None
    try:
        raw = int(value.strip().split(",")[0])
    except ValueError:
        return None
    bounds = BOUNDS_RE.search(volume_block)
    if bounds is None:
        return raw
    low = int(bounds.group("min"))
    high = int(bounds.group("max"))
    if high <= low:
        return raw
    return round(max(0, min(100, (raw - low) * 100 / (high - low))))


def _pcm_s16le_level(chunk: bytes) -> int | None:
    sample_count = len(chunk) // 2
    if sample_count == 0:
        return None
    samples = struct.unpack(f"<{sample_count}h", chunk[: sample_count * 2])
    rms = math.sqrt(sum(sample * sample for sample in samples) / sample_count)
    if rms <= 0:
        return 0
    decibels = 20 * math.log10(rms / 32768)
    return round(max(0, min(100, (decibels - METER_FLOOR_DB) * (100 / -METER_FLOOR_DB))))


def _control_numid(output: str, control_name: str) -> str | None:
    block = _control_block(output, control_name)
    if block is None:
        return None
    match = re.search(r"numid=(\d+)", block)
    return match.group(1) if match else None


def _control_block(output: str, control_name: str) -> str | None:
    lines = output.splitlines()
    for index, line in enumerate(lines):
        if f"name='{control_name}'" not in line:
            continue
        block_lines = [line]
        for following in lines[index + 1 :]:
            if following.startswith("numid="):
                break
            block_lines.append(following)
        return "\n".join(block_lines)
    return None


def _parse_value(block: str) -> str | None:
    for line in block.splitlines():
        match = VALUE_RE.search(line.strip())
        if match:
            return match.group("value")
    return None


_AUDIO_SERVICE = AudioService()


def get_audio_service() -> AudioService:
    return _AUDIO_SERVICE
