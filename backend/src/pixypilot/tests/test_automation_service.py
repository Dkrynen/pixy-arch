import os
import stat

from pixypilot.domains.automation.service import _scan_holders


def test_scan_holders_finds_own_open_char_device(tmp_path) -> None:
    fd = os.open("/dev/null", os.O_RDONLY)
    try:
        rdev = os.fstat(fd).st_rdev
        holders = _scan_holders(rdev, exclude=set())
    finally:
        os.close(fd)
    assert "pytest" in holders or "python" in holders


def test_scan_holders_respects_exclude_list() -> None:
    fd = os.open("/dev/null", os.O_RDONLY)
    try:
        rdev = os.fstat(fd).st_rdev
        import sys

        holders = _scan_holders(rdev, exclude={os.path.basename(sys.argv[0]) or "pytest", "pytest", "python", "python3"})
    finally:
        os.close(fd)
    assert all("pytest" not in h and "python" not in h for h in holders)
