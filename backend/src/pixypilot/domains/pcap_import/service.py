import hashlib
import json
import re
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from pixypilot.config import project_root
from pixypilot.domains.pcap_import.models import PcapImportRecord

ALLOWED_CAPTURE_SUFFIXES = {".pcap", ".pcapng"}
MAX_LABEL_LENGTH = 180
# First four bytes of the capture container, checked while streaming so a
# renamed text/log file cannot be parked in pcaps/imports as a capture.
CAPTURE_MAGIC_BYTES = {
    ".pcap": {
        b"\xd4\xc3\xb2\xa1",  # libpcap, little-endian
        b"\xa1\xb2\xc3\xd4",  # libpcap, big-endian
        b"\x4d\x3c\xb2\xa1",  # libpcap nanosecond, little-endian
        b"\xa1\xb2\x3c\x4d",  # libpcap nanosecond, big-endian
    },
    ".pcapng": {
        b"\x0a\x0d\x0d\x0a",  # section header block type
    },
}
# libpcap global header is 24 bytes; a pcapng section header block is at
# least 28 bytes. Anything shorter is not a usable capture.
MIN_CAPTURE_SIZE_BYTES = {".pcap": 24, ".pcapng": 28}
# Captures of the handful of HID/UVC exchanges worth decoding are a few MB;
# the cap keeps an upload from filling the disk.
MAX_CAPTURE_SIZE_BYTES = 512 * 1024 * 1024


class CaptureTooLargeError(ValueError):
    pass


def capture_too_large_message() -> str:
    return f"Capture exceeds the {MAX_CAPTURE_SIZE_BYTES // (1024 * 1024)} MB upload limit"


class PcapImportService:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or project_root()

    async def save_capture(
        self,
        filename: str,
        chunks: AsyncIterator[bytes],
        action: str | None = None,
        notes: str | None = None,
        source: str = "windows",
    ) -> PcapImportRecord:
        original_filename = _clean_filename(filename)
        suffix = Path(original_filename).suffix.lower()
        if suffix not in ALLOWED_CAPTURE_SUFFIXES:
            raise ValueError("Only .pcap and .pcapng capture files are allowed")

        uploaded_at = datetime.now(UTC).replace(microsecond=0).isoformat()
        capture_id = uuid4().hex[:12]
        stored_filename = f"{uploaded_at.replace(':', '').replace('+0000', 'Z')}-{capture_id}-{original_filename}"
        output_dir = self.root / "pcaps" / "imports"
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / stored_filename
        partial_path = output_path.with_suffix(output_path.suffix + ".part")
        digest = hashlib.sha256()
        size_bytes = 0
        header = bytearray()
        magic_checked = False
        expected_magic = CAPTURE_MAGIC_BYTES[suffix]

        try:
            with partial_path.open("wb") as handle:
                async for chunk in chunks:
                    if not chunk:
                        continue
                    size_bytes += len(chunk)
                    if size_bytes > MAX_CAPTURE_SIZE_BYTES:
                        raise CaptureTooLargeError(capture_too_large_message())
                    digest.update(chunk)
                    handle.write(chunk)
                    if not magic_checked:
                        header.extend(chunk[: 4 - len(header)])
                        if len(header) >= 4:
                            magic_checked = True
                            if bytes(header[:4]) not in expected_magic:
                                raise ValueError(
                                    f"File contents do not look like a {suffix} capture"
                                )
            if size_bytes == 0:
                raise ValueError("Capture upload was empty")
            if size_bytes < MIN_CAPTURE_SIZE_BYTES[suffix]:
                raise ValueError(f"File contents do not look like a {suffix} capture")
            partial_path.replace(output_path)
        except Exception:
            partial_path.unlink(missing_ok=True)
            raise

        record = PcapImportRecord(
            id=capture_id,
            original_filename=original_filename,
            stored_filename=stored_filename,
            file_path=str(output_path),
            size_bytes=size_bytes,
            sha256=digest.hexdigest(),
            uploaded_at=uploaded_at,
            action=_clean_label(action),
            notes=_clean_label(notes, max_length=2000),
            source=_clean_label(source) or "windows",
        )
        _metadata_path(output_path).write_text(json.dumps(record.model_dump(mode="json"), indent=2), encoding="utf-8")
        return record

    async def delete_capture(self, capture_id: str) -> PcapImportRecord:
        output_dir = self.root / "pcaps" / "imports"
        for record in await self.list_captures():
            if record.id != capture_id:
                continue
            capture_path = Path(record.file_path)
            if capture_path.parent != output_dir.resolve() and capture_path.parent != output_dir:
                raise ValueError("Capture path is outside the imports directory")
            capture_path.unlink(missing_ok=True)
            _metadata_path(capture_path).unlink(missing_ok=True)
            return record
        raise LookupError(f"No capture import with id {capture_id}")

    async def list_captures(self) -> list[PcapImportRecord]:
        output_dir = self.root / "pcaps" / "imports"
        if not output_dir.exists():
            return []

        records: list[PcapImportRecord] = []
        for metadata_path in sorted(output_dir.glob("*.json"), key=lambda path: path.name, reverse=True):
            try:
                records.append(PcapImportRecord(**json.loads(metadata_path.read_text(encoding="utf-8"))))
            except (OSError, json.JSONDecodeError, ValueError):
                continue
        return records


def _metadata_path(capture_path: Path) -> Path:
    return capture_path.with_suffix(capture_path.suffix + ".json")


def _clean_filename(filename: str) -> str:
    cleaned = Path(filename.strip().replace("\\", "/")).name
    cleaned = re.sub(r"[^A-Za-z0-9._ -]+", "_", cleaned).strip(" .")
    if not cleaned:
        raise ValueError("Capture filename is required")
    return cleaned[:160]


def _clean_label(value: str | None, max_length: int = MAX_LABEL_LENGTH) -> str | None:
    if value is None:
        return None
    cleaned = re.sub(r"\s+", " ", value).strip()
    return cleaned[:max_length] or None


def get_pcap_import_service() -> PcapImportService:
    return PcapImportService()
