from pydantic import BaseModel, Field


class AudioStatus(BaseModel):
    available: bool
    card: int | None = None
    name: str | None = None
    muted: bool | None = None
    # Mic gain normalized to percent (0-100) — the same unit PATCH /audio/volume
    # accepts — even though the ALSA control exposes a smaller raw range.
    volume: int | None = None
    source_node: str | None = None
    default_source: bool | None = None
    # True when set_default_source captured the source it replaced — a
    # /audio/default-source/restore call can then put the old default back.
    previous_default_source: bool = False
    monitor_running: bool = False
    meter_running: bool = False
    # RMS mic level in percent (0-100, -60 dBFS floor) while the meter runs.
    level: int | None = None
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
    # Current RMS level percent when reporting the meter; None for the monitor.
    level: int | None = None
    reason: str | None = None
