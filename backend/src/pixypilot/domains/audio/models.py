from pydantic import BaseModel, Field


class AudioStatus(BaseModel):
    available: bool
    card: int | None = None
    name: str | None = None
    muted: bool | None = None
    volume: int | None = None
    source_node: str | None = None
    default_source: bool | None = None
    monitor_running: bool = False
    reason: str | None = None


class AudioMuteRequest(BaseModel):
    muted: bool


class AudioVolumeRequest(BaseModel):
    volume: int = Field(ge=0, le=100)


class AudioCommandResult(BaseModel):
    ok: bool
    command: str
    value: bool | int | str
    card: int | None = None


class AudioMonitorResult(BaseModel):
    ok: bool
    running: bool
    pid: int | None = None
    source_node: str | None = None
    reason: str | None = None
