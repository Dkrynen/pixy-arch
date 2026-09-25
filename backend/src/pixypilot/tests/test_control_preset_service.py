import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError

from pixypilot.api.routes import router
from pixypilot.domains.control_presets.models import ControlPresetCreateRequest
from pixypilot.domains.control_presets.service import ControlPresetService, get_control_preset_service


async def test_missing_preset_file_returns_empty_list(tmp_path) -> None:
    service = ControlPresetService(tmp_path / "missing.yaml")

    presets = await service.list_presets()

    assert presets == []


async def test_create_and_list_presets_from_yaml(tmp_path) -> None:
    service = ControlPresetService(tmp_path / "presets.yaml")

    preset = await service.create_preset(
        ControlPresetCreateRequest(
            name="  Desk Light  ",
            scope="image",
            values={"brightness": 180, "contrast": 140},
        )
    )

    reloaded = ControlPresetService(tmp_path / "presets.yaml")
    presets = await reloaded.list_presets("image")

    assert presets == [preset]
    assert presets[0].name == "Desk Light"
    assert presets[0].values == {"brightness": 180, "contrast": 140}


async def test_delete_preset_removes_it_from_store(tmp_path) -> None:
    service = ControlPresetService(tmp_path / "presets.yaml")
    preset = await service.create_preset(
        ControlPresetCreateRequest(name="Manual Focus", scope="focus", values={"focus_absolute": 512})
    )

    result = await service.delete_preset(preset.id)

    assert result.ok is True
    assert await service.list_presets() == []


async def test_delete_unknown_preset_raises(tmp_path) -> None:
    service = ControlPresetService(tmp_path / "presets.yaml")

    with pytest.raises(ValueError, match="Unknown preset"):
        await service.delete_preset("missing")


@pytest.mark.parametrize(
    "key",
    ["Brightness", "bright ness", "a" * 65, "", "x: 1\ny", "focus-absolute", "\u00e9clat"],
)
def test_preset_values_keys_must_be_control_names(key) -> None:
    with pytest.raises(ValidationError):
        ControlPresetCreateRequest(name="Bad", scope="image", values={key: 1})


def test_preset_values_accept_v4l2_control_names() -> None:
    request = ControlPresetCreateRequest(
        name="Ok", scope="exposure", values={"exposure_time_absolute": 250, "gain": 0, "a" * 64: 1}
    )
    assert "exposure_time_absolute" in request.values


async def test_create_preset_route_reports_corrupt_store(tmp_path) -> None:
    presets_path = tmp_path / "presets.yaml"
    presets_path.write_text("presets: [unclosed\n", encoding="utf-8")
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_control_preset_service] = lambda: ControlPresetService(presets_path)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as client:
        response = await client.post(
            "/api/control-presets", json={"name": "Desk", "scope": "image", "values": {"brightness": 1}}
        )

    assert response.status_code == 500
    assert "not valid YAML" in response.json()["detail"]
    assert presets_path.read_text(encoding="utf-8") == "presets: [unclosed\n"
