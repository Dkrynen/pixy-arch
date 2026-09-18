import asyncio
import json
import re
import urllib.request
from typing import Any

from pixypilot.config import firmware_manifest_url
from pixypilot.domains.firmware.models import FirmwareComponent, FirmwareStatus
from pixypilot.domains.pixy_hid.models import PixyHidRawQueryResult
from pixypilot.domains.pixy_hid.service import get_pixy_hid_service

COMPONENT_QUERIES = {
    "isp": "firmware_isp",
    "csk": "firmware_ai",
    "mcu": "firmware_mcu",
}
# Manifest entry names vary (FIC7608, yuntai, project.hex); match loosely.
MANIFEST_NAME_RE = {
    "isp": re.compile(r"fic|isp|7608", re.IGNORECASE),
    "csk": re.compile(r"yuntai|csk|_ap\.|_cp\.|_res\.", re.IGNORECASE),
    "mcu": re.compile(r"mcu|cw32|project", re.IGNORECASE),
}
VERSION_RE = re.compile(r"\d+(?:\.\d+)+")


def _version_from_result(result: PixyHidRawQueryResult) -> str | None:
    if result.ascii_value:
        match = VERSION_RE.search(result.ascii_value)
        if match:
            return match.group(0)
    if result.raw_value is not None:
        # The PIXY version-query payload is a short raw value (e.g. byte 0x04
        # followed by 0x20) whose numeric-version mapping is not confirmed, so
        # expose the raw byte as hex rather than inventing a dotted version.
        return f"0x{result.raw_value:02x}"
    return None


def _version_tuple(version: str | None) -> tuple[int, ...] | None:
    if version is None:
        return None
    match = VERSION_RE.search(version)
    if not match:
        return None
    return tuple(int(part) for part in match.group(0).split("."))


def versions_differ(current: str | None, latest: str | None) -> bool | None:
    current_tuple = _version_tuple(current)
    latest_tuple = _version_tuple(latest)
    if current_tuple is None or latest_tuple is None:
        return None
    return latest_tuple > current_tuple


def manifest_versions(payload: Any) -> dict[str, str]:
    found: dict[str, str] = {}
    entries: list[dict] = []
    if isinstance(payload, dict):
        for key in ("data", "list", "files", "components", "items"):
            if isinstance(payload.get(key), list):
                entries.extend(item for item in payload[key] if isinstance(item, dict))
        entries.append(payload)
    elif isinstance(payload, list):
        entries.extend(item for item in payload if isinstance(item, dict))
    for entry in entries:
        text = json.dumps(entry)
        version = None
        for key in ("version", "ver", "sw_version", "fw_version"):
            if isinstance(entry.get(key), str) and VERSION_RE.search(entry[key]):
                version = VERSION_RE.search(entry[key]).group(0)
                break
        if version is None:
            continue
        for component, pattern in MANIFEST_NAME_RE.items():
            if pattern.search(text):
                found.setdefault(component, version)
    return found


def _fetch_manifest(url: str) -> dict[str, str] | None:
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    return manifest_versions(payload)


class FirmwareService:
    # Read-only by design: flashing without a captured official update
    # session can brick the camera's three processors.
    async def status(self, check_updates: bool = False) -> FirmwareStatus:
        hid = get_pixy_hid_service()
        hid_status = await hid.status()
        manifest_url = firmware_manifest_url()
        components: list[FirmwareComponent] = []
        serial = None
        if not hid_status.writable:
            return FirmwareStatus(
                components=[FirmwareComponent(name=name) for name in COMPONENT_QUERIES],
                manifest_url=manifest_url,
                reason=hid_status.reason or "HID device is not writable",
            )
        for name, query_name in COMPONENT_QUERIES.items():
            try:
                result = await hid.query_raw(query_name)  # type: ignore[arg-type]
            except (FileNotFoundError, PermissionError, OSError):
                result = None
            components.append(
                FirmwareComponent(
                    name=name,
                    current=_version_from_result(result) if result else None,
                    request_hex=result.request_hex if result else None,
                    response_hex=result.response_hex if result else None,
                )
            )
        try:
            serial_result = await hid.query_raw("serial_number")
            serial = serial_result.ascii_value
        except (FileNotFoundError, PermissionError, OSError):
            pass
        latest: dict[str, str] = {}
        manifest_checked = False
        if check_updates and manifest_url:
            fetched = await asyncio.get_running_loop().run_in_executor(None, _fetch_manifest, manifest_url)
            if fetched is not None:
                latest = fetched
                manifest_checked = True
        for component in components:
            component.latest = latest.get(component.name)
            component.update_available = versions_differ(component.current, component.latest)
        return FirmwareStatus(
            components=components,
            manifest_url=manifest_url,
            manifest_checked=manifest_checked,
            serial_number=serial,
            reason=None if manifest_checked or not check_updates else "update manifest could not be fetched",
        )


_SERVICE = FirmwareService()


def get_firmware_service() -> FirmwareService:
    return _SERVICE
