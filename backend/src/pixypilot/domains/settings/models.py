import ipaddress

from pydantic import BaseModel, ConfigDict, Field, field_validator

from pixypilot import config
from pixypilot.core.device_paths import HIDRAW_PATH_RE, VIDEO_PATH_RE, validate_device_path

# v4l2 card labels live in a 32-byte field including the terminating NUL.
VIRTUALCAM_LABEL_MAX_LENGTH = 31


def validate_bind_host(value: str | None) -> str | None:
    if value is None:
        return None
    host = value.strip()
    if host.lower() == "localhost":
        return "localhost"
    try:
        ipaddress.ip_address(host)
    except ValueError as exc:
        raise ValueError("host must be an IP address or 'localhost'") from exc
    return host


class _SettingsPatch(BaseModel):
    # Unknown or config-file-only keys are an error, not silently dropped, so
    # a client never believes it changed something it did not.
    model_config = ConfigDict(extra="forbid")


class SafetySettings(BaseModel):
    start_in_privacy: bool = True


class SafetySettingsUpdate(_SettingsPatch):
    start_in_privacy: bool | None = None


class ServerSettings(BaseModel):
    host: str = "127.0.0.1"
    port: int = 8000
    reload: bool = False
    url: str = "http://127.0.0.1:8000"


class ServerSettingsUpdate(_SettingsPatch):
    host: str | None = None
    port: int | None = Field(default=None, ge=1, le=65535)
    reload: bool | None = None

    @field_validator("host")
    @classmethod
    def _check_host(cls, value: str | None) -> str | None:
        return validate_bind_host(value)


class FrontendSettings(BaseModel):
    dist_path: str = "frontend/dist"
    dev_server_host: str = "127.0.0.1"
    dev_server_port: int = 5173
    single_port: bool = True


class FrontendDevServerSettingsUpdate(_SettingsPatch):
    host: str | None = None
    port: int | None = Field(default=None, ge=1, le=65535)

    @field_validator("host")
    @classmethod
    def _check_host(cls, value: str | None) -> str | None:
        # The dev-server host becomes an allowed CORS/request-guard origin.
        return validate_bind_host(value)


class FrontendSettingsUpdate(_SettingsPatch):
    # frontend.dist is config-file-only: the backend serves files from it.
    dev_server: FrontendDevServerSettingsUpdate | None = None


class StorageSettings(BaseModel):
    presets_path: str = "config/presets.yaml"
    recordings_dir: str = "recordings"


class StorageSettingsUpdate(_SettingsPatch):
    # storage.presets is config-file-only: the backend writes YAML there.
    recordings: str | None = None

    @field_validator("recordings")
    @classmethod
    def _check_recordings(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("recordings directory must not be empty")
        if "\x00" in value:
            raise ValueError("recordings directory must not contain NUL bytes")
        path = config.expand_config_path(value)
        if path.exists() and not path.is_dir():
            raise ValueError(f"{path} exists and is not a directory")
        return value


class HidSettings(BaseModel):
    path: str | None = None
    report_gap_ms: int = 25


class HidSettingsUpdate(_SettingsPatch):
    path: str | None = None
    report_gap_ms: int | None = Field(default=None, ge=0, le=1000)

    @field_validator("path")
    @classmethod
    def _check_path(cls, value: str | None) -> str | None:
        return validate_device_path(value, HIDRAW_PATH_RE, "HID")


class VirtualCamSettings(BaseModel):
    device: str | None = None
    label: str = config.DEFAULT_VIRTUALCAM_LABEL
    autostart: bool = True
    on_demand: bool = True
    idle_grace_seconds: int = 8


class VirtualCamSettingsUpdate(_SettingsPatch):
    device: str | None = None
    label: str | None = Field(default=None, min_length=1, max_length=VIRTUALCAM_LABEL_MAX_LENGTH)
    autostart: bool | None = None
    on_demand: bool | None = None
    idle_grace_seconds: int | None = Field(default=None, ge=0, le=600)

    @field_validator("device")
    @classmethod
    def _check_device(cls, value: str | None) -> str | None:
        return validate_device_path(value, VIDEO_PATH_RE, "virtual camera")

    @field_validator("label")
    @classmethod
    def _check_label(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not value.strip() or not value.isprintable():
            raise ValueError("label must be printable text")
        return value


class ConfigSettings(BaseModel):
    path: str = "config/pixypilot.yaml"


class AppSettings(BaseModel):
    safety: SafetySettings = Field(default_factory=SafetySettings)
    server: ServerSettings = Field(default_factory=ServerSettings)
    frontend: FrontendSettings
    storage: StorageSettings
    hid: HidSettings = Field(default_factory=HidSettings)
    virtualcam: VirtualCamSettings = Field(default_factory=VirtualCamSettings)
    config: ConfigSettings


class AppSettingsUpdate(_SettingsPatch):
    safety: SafetySettingsUpdate | None = None
    server: ServerSettingsUpdate | None = None
    frontend: FrontendSettingsUpdate | None = None
    storage: StorageSettingsUpdate | None = None
    hid: HidSettingsUpdate | None = None
    virtualcam: VirtualCamSettingsUpdate | None = None
