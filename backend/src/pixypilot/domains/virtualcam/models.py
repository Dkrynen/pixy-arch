from typing import Literal

from pydantic import BaseModel, Field


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
    output_width: int = Field(default=1920, ge=1)
    output_height: int = Field(default=1080, ge=1)
    transform: VirtualCamTransform = Field(default_factory=VirtualCamTransform)


class VirtualCamStatus(BaseModel):
    available: bool
    sink_path: str | None = None
    running: bool = False
    pid: int | None = None
    pipeline: str = "transform"
    source_device: str | None = None
    transform: VirtualCamTransform = Field(default_factory=VirtualCamTransform)
    reason: str | None = None


class VirtualCamActionResult(BaseModel):
    ok: bool
    running: bool = False
    pid: int | None = None
    sink_path: str | None = None
    reason: str | None = None
