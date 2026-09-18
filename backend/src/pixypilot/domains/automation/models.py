from typing import Literal

from pydantic import BaseModel, Field

OnOpenMode = Literal["tracking", "none"]
OnCloseMode = Literal["privacy", "previous", "none"]


class AutomationSettings(BaseModel):
    enabled: bool = True
    video_device: str = "/dev/video0"
    on_open: OnOpenMode = "tracking"
    on_close: OnCloseMode = "privacy"
    grace_seconds: float = Field(default=8.0, ge=0.0)
    poll_seconds: float = Field(default=1.0, gt=0.0)
    # Processes that hold the camera node persistently without meaning a
    # call is active (WirePlumber keeps an fd open for enumeration).
    exclude_processes: list[str] = Field(default_factory=lambda: ["wireplumber"])


class AutomationStatus(BaseModel):
    running: bool
    camera_in_use: bool = False
    holders: list[str] = Field(default_factory=list)
    saved_mode: str | None = None
    last_action: str | None = None
    settings: AutomationSettings
