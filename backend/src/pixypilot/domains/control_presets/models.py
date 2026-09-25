import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator


ControlPresetScope = Literal["image", "focus", "exposure"]
# Keys are V4L2 control names (native_control_name): they become YAML keys in
# the presets file, so arbitrary text is refused.
CONTROL_NAME_RE = re.compile(r"[a-z0-9_]{1,64}")
MAX_PRESET_VALUES = 64


class ControlPreset(BaseModel):
    id: str
    name: str
    scope: ControlPresetScope
    values: dict[str, int]
    created_at: str


class ControlPresetCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=48)
    scope: ControlPresetScope
    values: dict[str, int] = Field(min_length=1, max_length=MAX_PRESET_VALUES)

    @field_validator("values")
    @classmethod
    def check_control_names(cls, value: dict[str, int]) -> dict[str, int]:
        for name in value:
            if not CONTROL_NAME_RE.fullmatch(name):
                raise ValueError(f"{name!r} is not a V4L2 control name")
        return value

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        cleaned = " ".join(value.strip().split())
        if not cleaned:
            raise ValueError("Preset name is required")
        return cleaned


class ControlPresetDeleteResult(BaseModel):
    ok: bool
    id: str


class ControlPresetStore(BaseModel):
    presets: list[ControlPreset] = Field(default_factory=list)
