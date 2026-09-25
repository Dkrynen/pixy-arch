from typing import Literal

from pydantic import BaseModel, Field, field_validator

from pixypilot.config import AUTOMATION_AUTO_DEVICE
from pixypilot.core.device_paths import VIDEO_PATH_RE, validate_device_path

OnOpenMode = Literal["tracking", "none"]
OnCloseMode = Literal["privacy", "previous", "none"]


class AutomationSettings(BaseModel):
    enabled: bool = True
    # "auto" watches the EMEET PIXY capture node found via sysfs (nothing
    # when no PIXY is attached); an explicit /dev/videoN path also works.
    video_device: str = AUTOMATION_AUTO_DEVICE
    on_open: OnOpenMode = "tracking"
    on_close: OnCloseMode = "privacy"
    # Unmute the PIXY mic while an app holds the camera; re-muted on release
    # only when automation was the one that unmuted it.
    unmute_mic: bool = True
    grace_seconds: float = Field(default=8.0, ge=0.0)
    # Each poll walks every process's fds in /proc; sub-second polling buys
    # nothing a call cares about and burns CPU.
    poll_seconds: float = Field(default=1.0, ge=0.5, le=60.0)
    # Processes that hold the camera node persistently without meaning a
    # call is active (PipeWire/WirePlumber keep an fd open for enumeration).
    exclude_processes: list[str] = Field(default_factory=lambda: ["pipewire", "wireplumber"])

    @field_validator("video_device")
    @classmethod
    def _check_video_device(cls, value: str) -> str:
        if value.strip().lower() in ("", AUTOMATION_AUTO_DEVICE):
            return AUTOMATION_AUTO_DEVICE
        return validate_device_path(value, VIDEO_PATH_RE, "video device") or AUTOMATION_AUTO_DEVICE


class AutomationStatus(BaseModel):
    running: bool
    camera_in_use: bool = False
    holders: list[str] = Field(default_factory=list)
    saved_mode: str | None = None
    # True while the mic is unmuted because automation unmuted it this call.
    mic_unmuted: bool = False
    last_action: str | None = None
    settings: AutomationSettings
