from pydantic import BaseModel, Field

# Bounds keep requested modes inside what the V4L2 structs (u32 fields) and
# ffmpeg accept, so a bad query is a 422 rather than a struct.error 500.
MAX_STREAM_DIMENSION = 7680
MIN_STREAM_FPS = 1.0
MAX_STREAM_FPS = 120.0
# 100ns units: 1/120 s .. 1 s.
MIN_FRAME_INTERVAL_100NS = 83_333
MAX_FRAME_INTERVAL_100NS = 10_000_000


class VideoStreamSettings(BaseModel):
    pixel_format: str = "MJPG"
    width: int = Field(default=1280, ge=1, le=MAX_STREAM_DIMENSION)
    height: int = Field(default=720, ge=1, le=MAX_STREAM_DIMENSION)
    fps: float = Field(default=30, ge=MIN_STREAM_FPS, le=MAX_STREAM_FPS)
    frame_interval_100ns: int | None = Field(
        default=None, ge=MIN_FRAME_INTERVAL_100NS, le=MAX_FRAME_INTERVAL_100NS
    )


class VideoRecordingRequest(VideoStreamSettings):
    pass


class VideoRecordingStatus(BaseModel):
    recording: bool
    device_name: str | None = None
    path: str | None = None
    started_at: str | None = None
    reason: str | None = None


class VideoStreamStopResult(BaseModel):
    ok: bool
    device_name: str | None = None
