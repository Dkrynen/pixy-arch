from typing import Literal

from pydantic import BaseModel, Field, field_validator

# V4L2 fourccs (as reported by /api/devices/{n}/formats) mapped to the
# decoder name ffmpeg expects for -input_format. Anything not listed is
# passed through verbatim so new pixel formats still reach ffmpeg, which
# then fails honestly if it cannot decode them.
INPUT_FORMAT_ALIASES = {
    "mjpg": "mjpeg",
    "jpeg": "mjpeg",
    "mjpeg": "mjpeg",
    "yuyv": "yuyv422",
    "yuyv422": "yuyv422",
    "yuv420": "yuv420p",
    "yuv420p": "yuv420p",
    "nv12": "nv12",
    "h264": "h264",
}


def normalize_input_format(value: str) -> str:
    """Map a V4L2 fourcc or ffmpeg decoder name to an ffmpeg -input_format value."""
    normalized = value.strip().lower()
    if not normalized or not normalized.replace("_", "").isalnum():
        raise ValueError(f"invalid input format {value!r}")
    return INPUT_FORMAT_ALIASES.get(normalized, normalized)


class VirtualCamTransform(BaseModel):
    mirror: bool = False
    rotate: Literal[0, 90, 180, 270] = 0
    zoom: float = Field(default=1.0, ge=1.0, le=4.0)


class VirtualCamStartRequest(BaseModel):
    source_device: str | None = None
    sink_device: str | None = None
    pipeline: Literal["transform", "whiteboard"] = "transform"
    input_width: int = Field(default=1920, ge=1)
    input_height: int = Field(default=1080, ge=1)
    input_fps: float = Field(default=30.0, gt=0)
    input_format: str = "mjpeg"
    output_width: int = Field(default=1920, ge=1)
    output_height: int = Field(default=1080, ge=1)
    transform: VirtualCamTransform = Field(default_factory=VirtualCamTransform)

    @field_validator("input_format")
    @classmethod
    def _normalize_input_format(cls, value: str) -> str:
        return normalize_input_format(value)


class VirtualCamStatus(BaseModel):
    available: bool
    sink_path: str | None = None
    running: bool = False
    # "live" = real pipeline streaming, "standby" = armed with a synthetic
    # feed holding the sink's caps while the camera stays off, "off" =
    # sink unmanaged. `armed` is true while the on-demand watcher owns the
    # live↔standby transitions.
    mode: Literal["off", "standby", "live"] = "off"
    armed: bool = False
    pid: int | None = None
    pipeline: str = "transform"
    source_device: str | None = None
    output_width: int | None = None
    output_height: int | None = None
    output_pixel_format: str | None = None
    fps: float | None = None
    frames: int | None = None
    consumers: int = 0
    transform: VirtualCamTransform = Field(default_factory=VirtualCamTransform)
    reason: str | None = None
    last_error: str | None = None


class VirtualCamActionResult(BaseModel):
    ok: bool
    running: bool = False
    pid: int | None = None
    sink_path: str | None = None
    source_device: str | None = None
    reason: str | None = None
