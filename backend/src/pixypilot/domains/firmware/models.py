from pydantic import BaseModel


class FirmwareComponent(BaseModel):
    # isp = FIC7608 UVC bridge, csk = ListenAI CSK6 AI/gimbal, mcu = motor MCU
    name: str
    current: str | None = None
    latest: str | None = None
    update_available: bool | None = None
    request_hex: str | None = None
    response_hex: str | None = None


class FirmwareStatus(BaseModel):
    components: list[FirmwareComponent]
    manifest_url: str | None = None
    manifest_checked: bool = False
    serial_number: str | None = None
    reason: str | None = None
