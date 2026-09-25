import json

import pytest

from pixypilot.domains.pcap_import.service import PcapImportService

PCAP_LE_HEADER = b"\xd4\xc3\xb2\xa1" + b"\x02\x00\x04\x00" + b"\x00" * 16
PCAPNG_SHB = (
    b"\x0a\x0d\x0d\x0a"  # section header block type
    + b"\x1c\x00\x00\x00"  # block total length (28)
    + b"\x4d\x3c\x2b\x1a"  # byte-order magic
    + b"\x01\x00\x00\x00"  # version 1.0
    + b"\xff" * 8  # section length (unknown)
    + b"\x1c\x00\x00\x00"  # block total length (trailer)
)


async def chunks(*parts: bytes):
    for part in parts:
        yield part


@pytest.mark.asyncio
async def test_save_capture_streams_file_and_metadata(tmp_path) -> None:
    service = PcapImportService(root=tmp_path)

    record = await service.save_capture(
        filename="Tracking Mode.pcapng",
        chunks=chunks(PCAPNG_SHB[:10], PCAPNG_SHB[10:], b"packet-bytes"),
        action="Standard -> Tracking",
        notes="Changed one setting in EMEET Studio",
    )

    output_path = tmp_path / "pcaps" / "imports" / record.stored_filename
    metadata_path = output_path.with_suffix(output_path.suffix + ".json")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))

    assert output_path.read_bytes() == PCAPNG_SHB + b"packet-bytes"
    assert record.original_filename == "Tracking Mode.pcapng"
    assert record.size_bytes == len(PCAPNG_SHB) + len(b"packet-bytes")
    assert record.action == "Standard -> Tracking"
    assert metadata["sha256"] == record.sha256


@pytest.mark.asyncio
async def test_save_capture_accepts_pcap_endian_variants(tmp_path) -> None:
    service = PcapImportService(root=tmp_path)
    big_endian = b"\xa1\xb2\xc3\xd4" + b"\x00" * 20
    nanosecond = b"\x4d\x3c\xb2\xa1" + b"\x00" * 20

    for payload in (PCAP_LE_HEADER, big_endian, nanosecond):
        record = await service.save_capture(filename="capture.pcap", chunks=chunks(payload))
        assert record.size_bytes == len(payload)


@pytest.mark.asyncio
async def test_save_capture_rejects_unknown_extensions(tmp_path) -> None:
    service = PcapImportService(root=tmp_path)

    with pytest.raises(ValueError, match="Only .pcap and .pcapng"):
        await service.save_capture(filename="notes.txt", chunks=chunks(b"nope"))


@pytest.mark.asyncio
async def test_save_capture_rejects_wrong_magic_bytes(tmp_path) -> None:
    service = PcapImportService(root=tmp_path)
    garbage = b"this is not a capture, just text " * 4

    with pytest.raises(ValueError, match="do not look like a .pcap"):
        await service.save_capture(filename="fake.pcap", chunks=chunks(garbage))

    assert not list((tmp_path / "pcaps" / "imports").glob("*"))


@pytest.mark.asyncio
async def test_save_capture_rejects_pcap_content_in_pcapng_file(tmp_path) -> None:
    service = PcapImportService(root=tmp_path)

    with pytest.raises(ValueError, match="do not look like a .pcapng"):
        await service.save_capture(filename="misnamed.pcapng", chunks=chunks(PCAP_LE_HEADER))


@pytest.mark.asyncio
async def test_save_capture_rejects_truncated_capture(tmp_path) -> None:
    service = PcapImportService(root=tmp_path)

    with pytest.raises(ValueError, match="do not look like a .pcap"):
        await service.save_capture(filename="tiny.pcap", chunks=chunks(PCAP_LE_HEADER[:10]))


@pytest.mark.asyncio
async def test_save_capture_rejects_empty_upload(tmp_path) -> None:
    service = PcapImportService(root=tmp_path)

    with pytest.raises(ValueError, match="empty"):
        await service.save_capture(filename="empty.pcap", chunks=chunks())


@pytest.mark.asyncio
async def test_list_captures_uses_saved_metadata(tmp_path) -> None:
    service = PcapImportService(root=tmp_path)
    first = await service.save_capture(filename="first.pcapng", chunks=chunks(PCAPNG_SHB))
    second = await service.save_capture(filename="second.pcap", chunks=chunks(PCAP_LE_HEADER))

    records = await service.list_captures()

    assert {record.id for record in records} == {first.id, second.id}


@pytest.mark.asyncio
async def test_save_capture_stops_at_size_cap_and_removes_partial(tmp_path, monkeypatch) -> None:
    import pixypilot.domains.pcap_import.service as pcap_module

    monkeypatch.setattr(pcap_module, "MAX_CAPTURE_SIZE_BYTES", 64)
    service = PcapImportService(root=tmp_path)
    consumed: list[int] = []

    async def endless():
        yield PCAP_LE_HEADER
        while True:
            consumed.append(1)
            yield b"\x00" * 32

    with pytest.raises(pcap_module.CaptureTooLargeError):
        await service.save_capture(filename="huge.pcap", chunks=endless())

    # Streaming stops at the cap instead of reading the whole upload.
    assert len(consumed) <= 2
    assert not list((tmp_path / "pcaps" / "imports").glob("*"))


def _pcap_app(service: PcapImportService):
    from fastapi import FastAPI

    from pixypilot.api.routes import router
    from pixypilot.domains.pcap_import.service import get_pcap_import_service

    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_pcap_import_service] = lambda: service
    return app


@pytest.mark.asyncio
async def test_upload_route_answers_413_for_oversized_captures(tmp_path, monkeypatch) -> None:
    import httpx

    import pixypilot.domains.pcap_import.service as pcap_module

    monkeypatch.setattr(pcap_module, "MAX_CAPTURE_SIZE_BYTES", 64)
    transport = httpx.ASGITransport(app=_pcap_app(PcapImportService(root=tmp_path)))
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as client:
        declared = await client.post(
            "/api/pcap-imports", params={"filename": "big.pcap"}, content=PCAP_LE_HEADER * 4
        )

        async def streamed_body():
            yield PCAP_LE_HEADER
            yield b"\x00" * 100

        streamed = await client.post(
            "/api/pcap-imports", params={"filename": "big.pcap"}, content=streamed_body()
        )
        small = await client.post(
            "/api/pcap-imports", params={"filename": "ok.pcap"}, content=PCAP_LE_HEADER
        )

    assert declared.status_code == 413
    assert streamed.status_code == 413
    assert "upload limit" in streamed.json()["detail"]
    assert small.status_code == 200
