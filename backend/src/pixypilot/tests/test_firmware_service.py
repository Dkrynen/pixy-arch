from pixypilot.domains.firmware.service import manifest_versions, versions_differ


def test_versions_differ_detects_newer() -> None:
    assert versions_differ("2.0.4", "2.0.5") is True
    assert versions_differ("2.0.5", "2.0.5") is False
    assert versions_differ("2.1.0", "2.0.9") is False
    assert versions_differ("0x204", "2.0.5") is None
    assert versions_differ(None, "2.0.5") is None


def test_manifest_versions_maps_components() -> None:
    payload = {
        "data": [
            {"name": "FIC7608_IMX362_update.bin", "version": "2.0.4", "md5": "x"},
            {"name": "yuntai_ap.bin", "version": "2.0.5", "md5": "y"},
            {"name": "yuntai_cp.bin", "version": "2.0.5", "md5": "z"},
            {"name": "project.hex", "version": "2.0.7", "md5": "w"},
        ]
    }
    found = manifest_versions(payload)
    assert found["isp"] == "2.0.4"
    assert found["csk"] == "2.0.5"
    assert found["mcu"] == "2.0.7"


def test_manifest_versions_handles_flat_list() -> None:
    payload = [{"file": "project.hex", "ver": "2.0.8"}]
    assert manifest_versions(payload)["mcu"] == "2.0.8"
