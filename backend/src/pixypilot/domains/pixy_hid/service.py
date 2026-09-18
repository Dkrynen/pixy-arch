import asyncio
import json
import os
import select
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from pixypilot.config import hid_path_override, hid_report_gap_seconds, project_root
from pixypilot.domains.pixy_hid.commands import (
    AUTO_ROTATE_FEATURE,
    MIRROR_HORIZONTAL_FEATURE,
    MIRROR_VERTICAL_FEATURE,
    audio_query_report,
    audio_reports,
    auto_privacy_query_report,
    auto_privacy_reports,
    auto_rotate_reports,
    denoise_query_report,
    denoise_reports,
    device_info_query_report,
    ev_lock_query_report,
    ev_lock_reports,
    feature_query_report,
    firmware_version_query_report,
    focus_lock_query_report,
    focus_lock_reports,
    focus_metering_query_report,
    focus_metering_reports,
    gesture_query_report,
    gesture_reports,
    go_to_default_position_reports,
    meter_mode_query_report,
    mirror_reports,
    motor_absolute_reports,
    motor_position_query_report,
    motor_speed_query_report,
    motor_speed_reports,
    power_on_default_capture_reports,
    power_on_default_disable_reports,
    power_on_default_query_report,
    ptz_absolute_reports,
    ptz_direction_reports,
    ptz_preset_clear_reports,
    ptz_preset_load_reports,
    ptz_preset_query_report,
    ptz_preset_save_reports,
    ptz_recenter_reports,
    ptz_relative_reports,
    ptz_vector_reports,
    remote_pairing_query_report,
    remote_pairing_reports,
    serial_number_query_report,
    subdevice_serial_query_report,
    subdevice_version_query_report,
    target_tracking_query_report,
    target_tracking_reports,
    tracking_capability_query_report,
    tracking_probe_report,
    tracking_query_report,
    tracking_reports,
    wb_lock_query_report,
    wb_lock_reports,
)
from pixypilot.domains.pixy_hid.models import (
    AudioMode,
    FocusMeteringMode,
    PixyHidCommandResult,
    PixyHidDeviceState,
    PixyHidDiagnosticSnapshot,
    PixyHidQueryName,
    PixyHidRawQueryResult,
    PixyHidStatus,
    PtzDirection,
    TargetTrackingMode,
    TrackingMode,
)

PIXY_VENDOR_ID = "0000328F"
PIXY_PRODUCT_ID = "000000C0"
KNOWN_CONTROLS = [
    "tracking",
    "target_tracking",
    "privacy",
    "gesture",
    "auto_rotate",
    "mirror",
    "focus_metering",
    "auto_privacy",
    "audio_mode",
    "denoise",
    "wb_lock",
    "ev_lock",
    "focus_lock",
    "remote_pairing",
    "ptz_direction",
    "ptz_relative",
    "ptz_absolute",
    "ptz_recenter",
    "ptz_vector",
    "ptz_preset_save",
    "ptz_preset_load",
    "ptz_preset_clear",
    "power_on_default",
    "go_to_default_position",
    "motor_speed",
]
DEFAULT_REPORT_GAP_SECONDS = 0.025
DEFAULT_QUERY_TIMEOUT_SECONDS = 0.5
TARGET_TRACKING_REPORT_GAP_SECONDS = 0.05
_HIDRAW_PATH_CACHE: str | None = None
_HID_IO_LOCK = asyncio.Lock()
TRACKING_RESPONSE_VALUES: dict[int, TrackingMode] = {
    0x00: "off",
    0x01: "tracking",
    0x02: "privacy",
}
TARGET_TRACKING_RESPONSE_VALUES: dict[int, TargetTrackingMode] = {
    0x00: "off",
    0x01: "face",
    0x02: "half_body",
    0x03: "full_body",
}
AUDIO_RESPONSE_VALUES: dict[int, AudioMode] = {
    0x01: "noise_cancel",
    0x02: "live",
    0x03: "original",
}


class _HidChannel:
    # The firmware silently drops the first write on a freshly opened hidraw
    # node, so one persistent fd is kept for all I/O and warmed up on open.

    def __init__(self) -> None:
        self._fd: int | None = None
        self._path: str | None = None
        self._last_write: float | None = None

    def ensure(self, path: str) -> int:
        if self._fd is not None and self._path == path:
            return self._fd
        self.close()
        self._fd = os.open(path, os.O_RDWR | os.O_NONBLOCK)
        self._path = path
        self.transact(tracking_query_report(), timeout=0.08)
        return self._fd

    def close(self) -> None:
        if self._fd is not None:
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None
            self._path = None

    def _pace(self) -> None:
        # The firmware wants >= ~25 ms between reports; enforce it for every
        # write on the channel, including query writes back-to-back.
        if self._last_write is not None:
            delay = DEFAULT_REPORT_GAP_SECONDS - (time.monotonic() - self._last_write)
            if delay > 0:
                time.sleep(delay)
        self._last_write = time.monotonic()

    def send(self, report: bytes) -> None:
        if self._fd is not None:
            self._pace()
            os.write(self._fd, report)

    def transact(self, report: bytes, timeout: float = DEFAULT_QUERY_TIMEOUT_SECONDS, attempts: int = 2) -> bytes | None:
        if self._fd is None:
            return None
        fd = self._fd
        deadline = time.monotonic() + timeout
        # Each attempt gets its own wait window so a lost write is retried
        # instead of stalling the whole timeout on a silent device.
        attempt_window = timeout / attempts
        for _ in range(attempts):
            _drain_hidraw(fd)
            self._pace()
            os.write(fd, report)
            attempt_deadline = min(deadline, time.monotonic() + attempt_window)
            while time.monotonic() < attempt_deadline:
                remaining = attempt_deadline - time.monotonic()
                readable, _, _ = select.select([fd], [], [], remaining)
                if not readable:
                    break
                try:
                    frame = os.read(fd, 64)
                except BlockingIOError:
                    continue
                if not frame:
                    break
                if _is_reply_for(frame, report):
                    return frame
        return None


_CHANNEL = _HidChannel()


@dataclass(frozen=True)
class HidQuerySpec:
    name: PixyHidQueryName
    report: bytes
    value_index: int | None = None
    ascii_start: int | None = None


QUERY_SPECS: dict[PixyHidQueryName, HidQuerySpec] = {
    "tracking_state": HidQuerySpec("tracking_state", tracking_query_report(), value_index=8),
    "target_tracking_state": HidQuerySpec("target_tracking_state", target_tracking_query_report(), value_index=8),
    "tracking_capability": HidQuerySpec("tracking_capability", tracking_capability_query_report(), value_index=8),
    "tracking_probe_0100": HidQuerySpec("tracking_probe_0100", tracking_probe_report(0x00), value_index=8),
    "tracking_probe_0102": HidQuerySpec("tracking_probe_0102", tracking_probe_report(0x02), value_index=8),
    "tracking_probe_0103": HidQuerySpec("tracking_probe_0103", tracking_probe_report(0x03), value_index=8),
    "tracking_probe_0104": HidQuerySpec("tracking_probe_0104", tracking_probe_report(0x04), value_index=8),
    "device_info": HidQuerySpec("device_info", device_info_query_report(), ascii_start=8),
    "audio_state": HidQuerySpec("audio_state", audio_query_report(), value_index=8),
    "gesture_state": HidQuerySpec("gesture_state", gesture_query_report(), value_index=9),
    "auto_privacy_state": HidQuerySpec("auto_privacy_state", auto_privacy_query_report(), value_index=8),
    "focus_metering_state": HidQuerySpec("focus_metering_state", focus_metering_query_report(), value_index=8),
    "mirror_horizontal_state": HidQuerySpec(
        "mirror_horizontal_state",
        feature_query_report(MIRROR_HORIZONTAL_FEATURE),
        value_index=9,
    ),
    "mirror_vertical_state": HidQuerySpec(
        "mirror_vertical_state",
        feature_query_report(MIRROR_VERTICAL_FEATURE),
        value_index=9,
    ),
    "auto_rotate_state": HidQuerySpec(
        "auto_rotate_state",
        feature_query_report(AUTO_ROTATE_FEATURE),
        value_index=9,
    ),
    "serial_number": HidQuerySpec("serial_number", serial_number_query_report(), ascii_start=8),
    "firmware_isp": HidQuerySpec("firmware_isp", firmware_version_query_report(), value_index=8),
    "firmware_ai": HidQuerySpec("firmware_ai", subdevice_version_query_report(0x02), value_index=8),
    "firmware_mcu": HidQuerySpec("firmware_mcu", subdevice_version_query_report(0x03), value_index=8),
    "serial_csk": HidQuerySpec("serial_csk", subdevice_serial_query_report(0x02), ascii_start=8),
    "power_on_default_state": HidQuerySpec("power_on_default_state", power_on_default_query_report(), value_index=8),
    "preset_1_state": HidQuerySpec("preset_1_state", ptz_preset_query_report(1), value_index=9),
    "preset_2_state": HidQuerySpec("preset_2_state", ptz_preset_query_report(2), value_index=9),
    "preset_3_state": HidQuerySpec("preset_3_state", ptz_preset_query_report(3), value_index=9),
    "meter_mode": HidQuerySpec("meter_mode", meter_mode_query_report(), value_index=8),
    "wb_lock_state": HidQuerySpec("wb_lock_state", wb_lock_query_report(), value_index=8),
    "ev_lock_state": HidQuerySpec("ev_lock_state", ev_lock_query_report(), value_index=8),
    "focus_lock_state": HidQuerySpec("focus_lock_state", focus_lock_query_report(), value_index=8),
    "denoise_state": HidQuerySpec("denoise_state", denoise_query_report(), value_index=8),
    "remote_pairing_state": HidQuerySpec("remote_pairing_state", remote_pairing_query_report(), value_index=8),
    "motor_pos_pan": HidQuerySpec("motor_pos_pan", motor_position_query_report(0x01), value_index=8),
    "motor_pos_tilt": HidQuerySpec("motor_pos_tilt", motor_position_query_report(0x02), value_index=8),
    "motor_speed_pan": HidQuerySpec("motor_speed_pan", motor_speed_query_report(0x01), value_index=8),
    "motor_speed_tilt": HidQuerySpec("motor_speed_tilt", motor_speed_query_report(0x02), value_index=8),
}


class PixyHidService:
    def __init__(self, report_gap_seconds: float | None = None, config_path: Path | None = None) -> None:
        self.config_path = config_path
        self.report_gap_seconds = (
            report_gap_seconds if report_gap_seconds is not None else _configured_report_gap_seconds(config_path)
        )

    async def status(self) -> PixyHidStatus:
        hid_path = self.find_hidraw()
        if hid_path is None:
            return PixyHidStatus(
                available=False,
                reason="EMEET PIXY HID device was not found",
                known_controls=KNOWN_CONTROLS,
            )

        readable = os.access(hid_path, os.R_OK)
        writable = os.access(hid_path, os.W_OK)
        reason = None
        if not writable:
            reason = "HID device is present but not writable by this user"

        return PixyHidStatus(
            available=True,
            path=hid_path,
            readable=readable,
            writable=writable,
            reason=reason,
            known_controls=KNOWN_CONTROLS,
        )

    def find_hidraw(self) -> str | None:
        global _HIDRAW_PATH_CACHE
        configured_path = hid_path_override(self.config_path)
        if configured_path is not None:
            return str(configured_path) if configured_path.exists() else None

        if _HIDRAW_PATH_CACHE and Path(_HIDRAW_PATH_CACHE).exists():
            cached_path = Path(_HIDRAW_PATH_CACHE)
            if self._is_pixy_uevent(self._read_uevent(cached_path)):
                return _HIDRAW_PATH_CACHE
            _HIDRAW_PATH_CACHE = None

        candidates: list[tuple[int, Path]] = []
        for dev in sorted(Path("/dev").glob("hidraw*")):
            uevent = self._read_uevent(dev)
            if self._is_pixy_uevent(uevent):
                candidates.append((self._hidraw_rank(dev), dev))
        if candidates:
            _, dev = min(candidates, key=lambda candidate: (candidate[0], str(candidate[1])))
            _HIDRAW_PATH_CACHE = str(dev)
            return _HIDRAW_PATH_CACHE
        _HIDRAW_PATH_CACHE = None
        return None

    async def set_tracking(self, mode: TrackingMode) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        if mode == "tracking" and await self._tracking_readback_is_privacy(path):
            await self._write_reports(path, tracking_reports("off"), operation="tracking:off:privacy-exit")
            await asyncio.sleep(max(self.report_gap_seconds, 0.15))
        await self._write_reports(path, tracking_reports(mode), operation=f"tracking:{mode}")
        if mode != "privacy":
            await self._unpark_gimbal_if_parked(path)
        return PixyHidCommandResult(ok=True, command="tracking", value=mode, path=path)

    async def _unpark_gimbal_if_parked(self, path: str) -> None:
        # Leaving privacy should bring the lens back up, but the gimbal parks
        # at tilt -90 where absolute moves are ignored (mechanical deadband).
        # A small relative nudge escapes the park position, then an absolute
        # move centres the camera — without this, "Standard" mode leaves the
        # camera staring at the desk.
        tilt = await self._motor_position_deg(path, 0x02)
        if tilt is None or tilt > -80.0:
            return
        await self._write_reports(path, ptz_relative_reports("up", 12.0), operation="ptz:relative:up:unpark")
        await asyncio.sleep(max(self.report_gap_seconds, 0.6))
        await self._write_reports(path, ptz_absolute_reports(0.0, 0.0), operation="ptz:absolute:unpark-center")

    async def _motor_position_deg(self, path: str, axis: int) -> float | None:
        try:
            query = await self._query_raw_with_path(path, "motor_pos_tilt" if axis == 0x02 else "motor_pos_pan")
        except OSError:
            return None
        response = _hex_to_bytes(query.response_hex)
        if response is None or len(response) < 21 or response[0] != 0x09:
            return None
        import struct

        try:
            _target, current, _extra = struct.unpack("<fff", response[9:21])
        except struct.error:
            return None
        return float(current)

    async def set_target_tracking(
        self,
        mode: TargetTrackingMode,
        x: float = 0.5,
        y: float = 0.5,
        scale: float = 1.0,
    ) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(
            path,
            target_tracking_reports(mode, x, y, scale),
            operation=f"target_tracking:{mode}",
            report_gap_seconds=max(self.report_gap_seconds, TARGET_TRACKING_REPORT_GAP_SECONDS),
        )
        return PixyHidCommandResult(ok=True, command="target_tracking", value=mode, path=path)

    async def _tracking_readback_is_privacy(self, path: str) -> bool:
        try:
            tracking_query = await self._query_raw_with_path(path, "tracking_state")
        except OSError:
            return False
        return tracking_query.raw_value == 0x02

    async def query_state(self) -> PixyHidDeviceState:
        path = await self._require_writable_path()
        tracking_query = await self._query_raw_with_path(path, "tracking_state")
        target_tracking_query = await self._query_raw_with_path(path, "target_tracking_state")
        audio_query = await self._query_raw_with_path(path, "audio_state")
        gesture_query = await self._query_raw_with_path(path, "gesture_state")
        tracking_response = _hex_to_bytes(tracking_query.response_hex)
        target_tracking_response = _hex_to_bytes(target_tracking_query.response_hex)
        audio_response = _hex_to_bytes(audio_query.response_hex)
        gesture_response = _hex_to_bytes(gesture_query.response_hex)
        target_tracking_floats = _parse_target_tracking_floats(target_tracking_response)
        return PixyHidDeviceState(
            tracking_mode=_parse_tracking_response(tracking_response),
            tracking_raw_value=tracking_query.raw_value,
            tracking_raw_bits=tracking_query.raw_bits,
            target_tracking_mode=_parse_target_tracking_response(target_tracking_response),
            target_tracking_raw_value=target_tracking_query.raw_value,
            target_tracking_x=target_tracking_floats[0],
            target_tracking_y=target_tracking_floats[1],
            target_tracking_scale=target_tracking_floats[2],
            audio_mode=_parse_audio_response(audio_response),
            audio_raw_value=audio_query.raw_value,
            gesture_enabled=_parse_gesture_response(gesture_response),
            gesture_raw_value=gesture_query.raw_value,
            queries={
                "tracking_state": tracking_query,
                "target_tracking_state": target_tracking_query,
                "audio_state": audio_query,
                "gesture_state": gesture_query,
            },
            path=path,
        )

    async def query_raw(self, name: PixyHidQueryName) -> PixyHidRawQueryResult:
        path = await self._require_writable_path()
        return await self._query_raw_with_path(path, name)

    async def query_raw_all(self) -> list[PixyHidRawQueryResult]:
        path = await self._require_writable_path()
        results = []
        for name in QUERY_SPECS:
            results.append(await self._query_raw_with_path(path, name))
        return results

    async def capture_diagnostics(self, save: bool = False) -> PixyHidDiagnosticSnapshot:
        captured_at = datetime.now(UTC).replace(microsecond=0).isoformat()
        queries = await self.query_raw_all()
        path = queries[0].path if queries else await self._require_writable_path()
        snapshot = PixyHidDiagnosticSnapshot(captured_at=captured_at, path=path, queries=queries)
        if not save:
            return snapshot

        output_dir = project_root() / "diagnostics" / "hid"
        output_dir.mkdir(parents=True, exist_ok=True)
        filename = f"pixypilot-hid-{captured_at.replace(':', '').replace('+0000', 'Z')}.json"
        output_path = output_dir / filename
        payload = snapshot.model_dump(mode="json")
        payload["file_path"] = str(output_path)
        output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return PixyHidDiagnosticSnapshot(**payload)

    async def set_gesture(self, enabled: bool) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(path, gesture_reports(enabled), operation=f"gesture:{enabled}")
        return PixyHidCommandResult(ok=True, command="gesture", value=enabled, path=path)

    async def set_auto_rotate(self, enabled: bool) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(path, auto_rotate_reports(enabled), operation=f"auto_rotate:{enabled}")
        return PixyHidCommandResult(ok=True, command="auto_rotate", value=enabled, path=path)

    async def set_mirror(self, horizontal: bool, vertical: bool) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(path, mirror_reports(horizontal, vertical), operation=f"mirror:{horizontal}:{vertical}")
        value = _mirror_value(horizontal, vertical)
        return PixyHidCommandResult(ok=True, command="mirror", value=value, path=path)

    async def set_focus_metering(
        self,
        mode: FocusMeteringMode,
        x: int | None = None,
        y: int | None = None,
    ) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(path, focus_metering_reports(mode, x, y), operation=f"focus_metering:{mode}")
        return PixyHidCommandResult(ok=True, command="focus_metering", value=mode, path=path)

    async def set_audio_mode(self, mode: AudioMode) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(path, audio_reports(mode), operation=f"audio_mode:{mode}")
        return PixyHidCommandResult(ok=True, command="audio_mode", value=mode, path=path)

    async def set_auto_privacy(self, timeout_seconds: int) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(path, auto_privacy_reports(timeout_seconds), operation=f"auto_privacy:{timeout_seconds}")
        return PixyHidCommandResult(
            ok=True,
            command="auto_privacy",
            value=timeout_seconds,
            path=path,
        )

    async def send_ptz_direction(self, direction: PtzDirection) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(path, ptz_direction_reports(direction), operation=f"ptz_direction:{direction}")
        return PixyHidCommandResult(ok=True, command="ptz_direction", value=direction, path=path)

    async def send_ptz_relative(self, direction: PtzDirection, degrees: float = 3.0) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(path, ptz_relative_reports(direction, degrees), operation=f"ptz_relative:{direction}:{degrees:g}")
        return PixyHidCommandResult(ok=True, command="ptz_relative", value=f"{direction}:{degrees:g}", path=path)

    async def send_ptz_absolute(self, pan: float, tilt: float) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(path, ptz_absolute_reports(pan, tilt), operation=f"ptz_absolute:{pan:g}:{tilt:g}")
        return PixyHidCommandResult(ok=True, command="ptz_absolute", value=f"{pan:g},{tilt:g}", path=path)

    async def recenter_ptz(self) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(path, ptz_recenter_reports(), operation="ptz_recenter")
        return PixyHidCommandResult(ok=True, command="ptz_recenter", value="0,0", path=path)

    async def send_ptz_vector(self, x: float, y: float, z: float = 0.0) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(path, ptz_vector_reports(x, y, z), operation=f"ptz_vector:{x}:{y}:{z}")
        return PixyHidCommandResult(ok=True, command="ptz_vector", value=f"{x},{y},{z}", path=path)

    async def save_ptz_preset(self, slot: int) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(path, ptz_preset_save_reports(slot), operation=f"ptz_preset_save:{slot}")
        return PixyHidCommandResult(ok=True, command="ptz_preset_save", value=slot, path=path)

    async def load_ptz_preset(self, slot: int) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        async with _HID_IO_LOCK:
            value = await asyncio.to_thread(self._load_ptz_preset_sync, path, slot)
        return PixyHidCommandResult(ok=True, command="ptz_preset_load", value=value, path=path)

    def _load_ptz_preset_sync(self, path: str, slot: int) -> str:
        # The vendor goto-preset report ACKs but does not move on current
        # firmware, so the stored position is read back and driven explicitly.
        _CHANNEL.ensure(path)
        response = _CHANNEL.transact(ptz_preset_query_report(slot))
        _append_hid_trace_event(
            {
                "event": "query",
                "operation": f"ptz_preset_state:{slot}",
                "path": path,
                "request_hex": _bytes_to_hex(ptz_preset_query_report(slot)),
                "response_hex": _bytes_to_hex(response),
            }
        )
        self._write_reports_sync(path, ptz_preset_load_reports(slot), operation=f"ptz_preset_load:{slot}")
        position = _parse_preset_position(response)
        if position is None:
            return f"{slot}:empty"
        pan, tilt = position
        reports = [*tracking_reports("off"), *motor_absolute_reports(0x01, pan), *motor_absolute_reports(0x02, tilt)]
        self._write_reports_sync(path, reports, operation=f"ptz_preset_load:{slot}:drive:{pan:g},{tilt:g}")
        return f"{slot}:{pan:g},{tilt:g}"

    async def clear_ptz_preset(self, slot: int) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(path, ptz_preset_clear_reports(slot), operation=f"ptz_preset_clear:{slot}")
        return PixyHidCommandResult(ok=True, command="ptz_preset_clear", value=slot, path=path)

    async def capture_power_on_default(self) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(path, power_on_default_capture_reports(), operation="power_on_default:capture")
        return PixyHidCommandResult(ok=True, command="power_on_default", value="capture", path=path)

    async def disable_power_on_default(self) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(path, power_on_default_disable_reports(), operation="power_on_default:disable")
        return PixyHidCommandResult(ok=True, command="power_on_default", value="disable", path=path)

    async def go_to_default_position(self) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(path, go_to_default_position_reports(), operation="go_to_default_position")
        return PixyHidCommandResult(ok=True, command="go_to_default_position", value=True, path=path)

    async def set_denoise(self, enabled: bool) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(path, denoise_reports(enabled), operation=f"denoise:{enabled}")
        return PixyHidCommandResult(ok=True, command="denoise", value=enabled, path=path)

    async def set_wb_lock(self, enabled: bool) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(path, wb_lock_reports(enabled), operation=f"wb_lock:{enabled}")
        return PixyHidCommandResult(ok=True, command="wb_lock", value=enabled, path=path)

    async def set_focus_lock(self, enabled: bool) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(path, focus_lock_reports(enabled), operation=f"focus_lock:{enabled}")
        return PixyHidCommandResult(ok=True, command="focus_lock", value=enabled, path=path)

    async def set_ev_lock(self, enabled: bool, exposure: int = 0) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(path, ev_lock_reports(enabled, exposure), operation=f"ev_lock:{enabled}:{exposure}")
        return PixyHidCommandResult(ok=True, command="ev_lock", value=enabled, path=path)

    async def set_remote_pairing(self, enabled: bool) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(path, remote_pairing_reports(enabled), operation=f"remote_pairing:{enabled}")
        return PixyHidCommandResult(ok=True, command="remote_pairing", value=enabled, path=path)

    async def set_motor_speed(self, axis: int, degrees_per_second: float) -> PixyHidCommandResult:
        path = await self._require_writable_path()
        await self._write_reports(path, motor_speed_reports(axis, degrees_per_second), operation=f"motor_speed:{axis}:{degrees_per_second:g}")
        return PixyHidCommandResult(ok=True, command="motor_speed", value=f"{axis}:{degrees_per_second:g}", path=path)

    async def _require_writable_path(self) -> str:
        status = await self.status()
        if not status.available or status.path is None:
            raise FileNotFoundError(status.reason or "Pixy HID device not found")
        if not status.writable:
            raise PermissionError(status.reason or "Pixy HID device is not writable")
        return status.path

    async def _write_reports(
        self,
        path: str,
        reports: list[bytes],
        operation: str | None = None,
        report_gap_seconds: float | None = None,
    ) -> None:
        async with _HID_IO_LOCK:
            await asyncio.to_thread(self._write_reports_sync, path, reports, operation, report_gap_seconds)

    def _write_reports_sync(
        self,
        path: str,
        reports: list[bytes],
        operation: str | None = None,
        report_gap_seconds: float | None = None,
    ) -> None:
        gap_seconds = self.report_gap_seconds if report_gap_seconds is None else report_gap_seconds
        try:
            _CHANNEL.ensure(path)
            for index, report in enumerate(reports):
                _CHANNEL.send(report)
                _append_hid_trace_event(
                    {
                        "event": "write",
                        "operation": operation,
                        "path": path,
                        "report_index": index,
                        "report_count": len(reports),
                        "request_hex": _bytes_to_hex(report),
                    }
                )
                if index < len(reports) - 1 and gap_seconds > 0:
                    time.sleep(gap_seconds)
        except OSError:
            _CHANNEL.close()
            raise

    def _write_report(self, path: str, report: bytes) -> None:
        # Kept for direct tests and one-off diagnostics.
        with open(path, "wb", buffering=0) as hidraw:
            hidraw.write(report)

    async def _send_recv_report(self, path: str, report: bytes) -> bytes | None:
        async with _HID_IO_LOCK:
            return await asyncio.to_thread(self._send_recv_report_sync, path, report)

    async def _query_raw_with_path(self, path: str, name: PixyHidQueryName) -> PixyHidRawQueryResult:
        spec = QUERY_SPECS[name]
        response = await self._send_recv_report(path, spec.report)
        raw_value = _response_byte(response, spec.value_index) if spec.value_index is not None else None
        result = PixyHidRawQueryResult(
            name=spec.name,
            request_hex=_bytes_to_hex(spec.report),
            response_hex=_bytes_to_hex(response),
            value_index=spec.value_index,
            raw_value=raw_value,
            raw_bits=_set_bit_indexes(raw_value),
            ascii_value=_response_ascii(response, spec.ascii_start),
            ascii_preview=_ascii_preview(response),
            path=path,
        )
        _append_hid_trace_event(
            {
                "event": "query",
                "operation": spec.name,
                "path": path,
                "request_hex": result.request_hex,
                "response_hex": result.response_hex,
                "value_index": result.value_index,
                "raw_value": result.raw_value,
                "raw_bits": result.raw_bits,
                "ascii_value": result.ascii_value,
                "ascii_preview": result.ascii_preview,
            }
        )
        return result

    def _send_recv_report_sync(self, path: str, report: bytes) -> bytes | None:
        try:
            _CHANNEL.ensure(path)
            return _CHANNEL.transact(report)
        except OSError:
            _CHANNEL.close()
            raise

    def _read_uevent(self, dev: Path) -> str:
        hidraw_name = dev.name
        uevent_path = Path("/sys/class/hidraw") / hidraw_name / "device" / "uevent"
        try:
            return uevent_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""

    def _is_pixy_uevent(self, uevent: str) -> bool:
        has_id = PIXY_VENDOR_ID in uevent.upper() and PIXY_PRODUCT_ID in uevent.upper()
        has_name = "EMEET" in uevent.upper() and "PIXY" in uevent.upper()
        return has_id or has_name

    def _hidraw_rank(self, dev: Path) -> int:
        descriptor_path = Path("/sys/class/hidraw") / dev.name / "device" / "report_descriptor"
        try:
            descriptor = descriptor_path.read_bytes()
        except OSError:
            return 10
        return 0 if b"\x05\x83\x09\x83" in descriptor else 10


def _configured_report_gap_seconds(config_path: Path | None = None) -> float:
    return hid_report_gap_seconds(config_path)


def _mirror_value(horizontal: bool, vertical: bool) -> str:
    if horizontal and vertical:
        return "hv"
    if horizontal:
        return "h"
    if vertical:
        return "v"
    return "off"


def _parse_tracking_response(response: bytes | None) -> TrackingMode | None:
    if not response or len(response) < 9 or response[0] != 0x09 or (response[1] & 0x1F) != 0x01:
        return None
    return TRACKING_RESPONSE_VALUES.get(response[8])


def _parse_target_tracking_response(response: bytes | None) -> TargetTrackingMode | None:
    if not response or len(response) < 9 or response[0] != 0x09 or (response[1] & 0x1F) != 0x04:
        return None
    if response[2] != 0x01 or response[3] != 0x01:
        return None
    return TARGET_TRACKING_RESPONSE_VALUES.get(response[8])


def _parse_target_tracking_floats(response: bytes | None) -> tuple[float | None, float | None, float | None]:
    if not response or len(response) < 21:
        return (None, None, None)
    if response[0] != 0x09 or (response[1] & 0x1F) != 0x04 or response[2] != 0x01 or response[3] != 0x01:
        return (None, None, None)
    try:
        import struct

        return struct.unpack("<fff", response[9:21])
    except struct.error:
        return (None, None, None)


def _parse_audio_response(response: bytes | None) -> AudioMode | None:
    if not response or len(response) < 9 or response[0] != 0x09 or (response[1] & 0x1F) != 0x05:
        return None
    return AUDIO_RESPONSE_VALUES.get(response[8])


def _parse_gesture_response(response: bytes | None) -> bool | None:
    if not response or len(response) < 10 or response[0] != 0x09 or (response[1] & 0x1F) != 0x04:
        return None
    return response[9] == 0x01


def _response_byte(response: bytes | None, index: int, group: int | None = None) -> int | None:
    if not response or len(response) <= index or response[0] != 0x09:
        return None
    if group is not None and (response[1] & 0x1F) != group:
        return None
    return response[index]


def _bytes_to_hex(value: bytes | None) -> str | None:
    if value is None:
        return None
    return value.hex(" ")


def _hex_to_bytes(value: str | None) -> bytes | None:
    if value is None:
        return None
    return bytes.fromhex(value)


def _append_hid_trace_event(event: dict) -> None:
    output_dir = project_root() / "diagnostics" / "hid"
    payload = {
        "captured_at": datetime.now(UTC).replace(microsecond=0).isoformat(),
        **event,
    }
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
        with (output_dir / "pixypilot-hid-trace.jsonl").open("a", encoding="utf-8") as trace_file:
            trace_file.write(json.dumps(payload, sort_keys=True) + "\n")
    except OSError:
        # Tracing must never break camera control.
        return


def _set_bit_indexes(value: int | None) -> list[int]:
    if value is None:
        return []
    return [bit for bit in range(8) if value & (1 << bit)]


def _response_ascii(response: bytes | None, start: int | None) -> str | None:
    if response is None or start is None or len(response) <= start:
        return None
    payload = response[start:].split(b"\x00", 1)[0]
    if not payload:
        return None
    try:
        return payload.decode("ascii")
    except UnicodeDecodeError:
        return None


def _ascii_preview(response: bytes | None) -> str | None:
    if response is None:
        return None
    preview = "".join(chr(byte) if 0x20 <= byte <= 0x7E else "." for byte in response)
    return preview.rstrip(".") or None


def _drain_hidraw(fd: int) -> None:
    while True:
        readable, _, _ = select.select([fd], [], [], 0)
        if not readable:
            return
        try:
            if not os.read(fd, 64):
                return
        except BlockingIOError:
            return


def _parse_preset_position(response: bytes | None) -> tuple[float, float] | None:
    if not response or len(response) < 22 or response[0] != 0x09:
        return None
    if (response[1] & 0x1F) != 0x03 or response[2] != 0x01 or response[3] != 0x16:
        return None
    if response[9] != 0x01:
        return None
    import struct

    pan, tilt, _ = struct.unpack("<fff", response[10:22])
    return pan, tilt


def _is_reply_for(frame: bytes, request: bytes) -> bool:
    # The device pushes unsolicited state reports (gesture flips, privacy
    # status); only a frame echoing the request's group/page/index is a reply.
    return (
        len(frame) >= 4
        and frame[0] == 0x09
        and (frame[1] & 0x1F) == (request[1] & 0x1F)
        and frame[2] == request[2]
        and frame[3] == request[3]
    )


def get_pixy_hid_service() -> PixyHidService:
    return PixyHidService()
