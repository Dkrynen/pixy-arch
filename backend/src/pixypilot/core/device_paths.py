import os
import re

HIDRAW_PATH_RE = re.compile(r"/dev/hidraw\d+")
VIDEO_PATH_RE = re.compile(r"/dev/video\d+")


def validate_device_path(value: str | None, pattern: re.Pattern[str], kind: str) -> str | None:
    """None/"" pass (auto-detect); anything else must resolve to `pattern`.

    realpath: a by-id/by-path alias is fine, but a symlink planted to point a
    device setting at an arbitrary file is not.
    """
    if value is None or value.strip() == "":
        return None
    value = value.strip()
    if "\x00" in value:
        raise ValueError(f"{kind} path must not contain NUL bytes")
    if not pattern.fullmatch(os.path.realpath(value)):
        expected = pattern.pattern.replace(r"\d+", "N")
        raise ValueError(f"{kind} path must be a {expected} device node")
    return value
