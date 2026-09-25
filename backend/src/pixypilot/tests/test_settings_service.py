import os

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError

from pixypilot.api.routes import router
from pixypilot.domains.settings.models import AppSettingsUpdate
from pixypilot.domains.settings.service import SettingsService, get_settings_service


async def test_missing_settings_file_defaults_to_starting_in_privacy(tmp_path) -> None:
    service = SettingsService(tmp_path / "missing.yaml")

    settings = await service.get_settings()

    assert settings.safety.start_in_privacy is True
    assert settings.server.host == "127.0.0.1"
    assert settings.server.port == 8000


async def test_settings_file_can_disable_startup_privacy(tmp_path) -> None:
    settings_path = tmp_path / "pixypilot.yaml"
    settings_path.write_text(
        """
safety:
  start_in_privacy: false
""",
        encoding="utf-8",
    )
    service = SettingsService(settings_path)

    settings = await service.get_settings()

    assert settings.safety.start_in_privacy is False


async def test_settings_file_reports_runtime_paths(tmp_path) -> None:
    project = tmp_path / "project"
    config_dir = project / "config"
    config_dir.mkdir(parents=True)
    settings_path = config_dir / "pixypilot.yaml"
    settings_path.write_text(
        """
server:
  host: 0.0.0.0
  port: 8012
storage:
  presets: config/my-presets.yaml
  recordings: captures
hid:
  path: /dev/hidraw9
  report_gap_ms: 40
""",
        encoding="utf-8",
    )
    service = SettingsService(settings_path)

    settings = await service.get_settings()

    assert settings.server.url == "http://0.0.0.0:8012"
    assert settings.storage.presets_path == str(project / "config" / "my-presets.yaml")
    assert settings.storage.recordings_dir == str(project / "captures")
    assert settings.hid.path == "/dev/hidraw9"
    assert settings.hid.report_gap_ms == 40
    assert settings.config.path == str(settings_path)


async def test_settings_update_patches_yaml_without_dropping_existing_values(tmp_path) -> None:
    settings_path = tmp_path / "pixypilot.yaml"
    settings_path.write_text(
        """
server:
  host: 127.0.0.1
  port: 8000
frontend:
  dev_server:
    host: 127.0.0.1
    port: 5173
hid:
  report_gap_ms: 25
""",
        encoding="utf-8",
    )
    service = SettingsService(settings_path)

    settings = await service.update_settings(
        AppSettingsUpdate.model_validate(
            {
                "frontend": {"dev_server": {"port": 5174}},
                "hid": {"path": "/dev/hidraw14"},
            }
        )
    )

    assert settings.frontend.dev_server_host == "127.0.0.1"
    assert settings.frontend.dev_server_port == 5174
    assert settings.hid.path == "/dev/hidraw14"
    assert settings.hid.report_gap_ms == 25
    assert "port: 8000" in settings_path.read_text(encoding="utf-8")


async def test_empty_settings_update_does_not_rewrite_yaml(tmp_path) -> None:
    settings_path = tmp_path / "pixypilot.yaml"
    original_yaml = """
safety:
  start_in_privacy: true

hid:
  path:
  report_gap_ms: 25
"""
    settings_path.write_text(original_yaml, encoding="utf-8")
    service = SettingsService(settings_path)

    await service.update_settings(AppSettingsUpdate())

    assert settings_path.read_text(encoding="utf-8") == original_yaml


async def test_virtualcam_settings_expose_autostart_and_persist(tmp_path) -> None:
    settings_path = tmp_path / "pixypilot.yaml"
    settings_path.write_text("virtualcam:\n  autostart: false\n", encoding="utf-8")
    service = SettingsService(settings_path)

    settings = await service.get_settings()
    assert settings.virtualcam.autostart is False
    assert settings.virtualcam.label == "Pixy Arch Virtual"
    assert settings.virtualcam.on_demand is True
    assert settings.virtualcam.idle_grace_seconds == 8

    updated = await service.update_settings(
        AppSettingsUpdate(virtualcam={"autostart": True, "on_demand": False})
    )
    assert updated.virtualcam.autostart is True
    assert updated.virtualcam.on_demand is False
    assert "autostart: true" in settings_path.read_text(encoding="utf-8")
    assert "on_demand: false" in settings_path.read_text(encoding="utf-8")



def _settings_app(service: SettingsService) -> FastAPI:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_settings_service] = lambda: service
    return app


async def _patch_settings(service: SettingsService, body: dict) -> httpx.Response:
    transport = httpx.ASGITransport(app=_settings_app(service))
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as client:
        return await client.patch("/api/settings", json=body)


@pytest.mark.parametrize(
    "body",
    [
        {"frontend": {"dist": "/etc"}},
        {"storage": {"presets": "/home/user/.bashrc"}},
        {"server": {"hots": "127.0.0.1"}},
        {"virtualcam": {"autostart": True, "bogus": 1}},
        {"unknown_section": {}},
    ],
)
async def test_settings_patch_rejects_config_file_only_and_unknown_fields(tmp_path, body) -> None:
    settings_path = tmp_path / "pixypilot.yaml"
    settings_path.write_text("hid:\n  report_gap_ms: 25\n", encoding="utf-8")

    response = await _patch_settings(SettingsService(settings_path), body)

    assert response.status_code == 422
    assert settings_path.read_text(encoding="utf-8") == "hid:\n  report_gap_ms: 25\n"


async def test_settings_patch_writes_valid_update_through_route(tmp_path) -> None:
    settings_path = tmp_path / "pixypilot.yaml"

    response = await _patch_settings(
        SettingsService(settings_path), {"virtualcam": {"label": "Desk Cam", "idle_grace_seconds": 30}}
    )

    assert response.status_code == 200
    assert response.json()["virtualcam"]["label"] == "Desk Cam"
    assert "idle_grace_seconds: 30" in settings_path.read_text(encoding="utf-8")


def test_recordings_setting_rejects_empty_nul_and_files(tmp_path) -> None:
    not_a_dir = tmp_path / "file.txt"
    not_a_dir.write_text("x", encoding="utf-8")
    for bad in ["", "   ", "rec\x00ordings", str(not_a_dir)]:
        with pytest.raises(ValidationError):
            AppSettingsUpdate.model_validate({"storage": {"recordings": bad}})

    existing_dir = tmp_path / "videos"
    existing_dir.mkdir()
    for good in [str(existing_dir), str(tmp_path / "not-yet-created"), "recordings"]:
        update = AppSettingsUpdate.model_validate({"storage": {"recordings": good}})
        assert update.storage is not None and update.storage.recordings == good


def test_device_settings_must_resolve_to_device_nodes(tmp_path) -> None:
    alias = tmp_path / "pixy-hid"
    os.symlink("/dev/hidraw7", alias)
    sneaky = tmp_path / "sneaky"
    os.symlink("/etc/passwd", sneaky)

    assert AppSettingsUpdate.model_validate({"hid": {"path": "/dev/hidraw3"}}).hid.path == "/dev/hidraw3"
    assert AppSettingsUpdate.model_validate({"hid": {"path": str(alias)}}).hid.path == str(alias)
    assert AppSettingsUpdate.model_validate({"hid": {"path": ""}}).hid.path is None
    assert AppSettingsUpdate.model_validate({"hid": {"path": None}}).hid.path is None
    for bad in ["/etc/passwd", str(sneaky), "/dev/video0", "/dev/hidraw", "/dev/hidraw1\x00"]:
        with pytest.raises(ValidationError):
            AppSettingsUpdate.model_validate({"hid": {"path": bad}})

    assert AppSettingsUpdate.model_validate({"virtualcam": {"device": "/dev/video10"}}).virtualcam.device == "/dev/video10"
    assert AppSettingsUpdate.model_validate({"virtualcam": {"device": ""}}).virtualcam.device is None
    for bad in ["/dev/hidraw0", "/tmp/video10", str(sneaky)]:
        with pytest.raises(ValidationError):
            AppSettingsUpdate.model_validate({"virtualcam": {"device": bad}})


def test_virtualcam_label_and_grace_are_bounded() -> None:
    assert AppSettingsUpdate.model_validate({"virtualcam": {"label": "x" * 31}}).virtualcam.label == "x" * 31
    for bad in ["", "x" * 32, "tab\there"]:
        with pytest.raises(ValidationError):
            AppSettingsUpdate.model_validate({"virtualcam": {"label": bad}})
    assert AppSettingsUpdate.model_validate({"virtualcam": {"idle_grace_seconds": 600}})
    with pytest.raises(ValidationError):
        AppSettingsUpdate.model_validate({"virtualcam": {"idle_grace_seconds": 601}})


def test_bind_hosts_must_be_ip_literals_or_localhost() -> None:
    for good, expected in [("0.0.0.0", "0.0.0.0"), (" ::1 ", "::1"), ("LOCALHOST", "localhost")]:
        assert AppSettingsUpdate.model_validate({"server": {"host": good}}).server.host == expected
    for bad in ["evil.example", "", "127.0.0.1; rm -rf /", "localhost.evil"]:
        with pytest.raises(ValidationError):
            AppSettingsUpdate.model_validate({"server": {"host": bad}})
    # The dev-server host becomes an allowed CORS origin, so it is held to
    # the same rule.
    with pytest.raises(ValidationError):
        AppSettingsUpdate.model_validate({"frontend": {"dev_server": {"host": "evil.example"}}})


async def test_settings_update_creates_missing_config_file_and_directory(tmp_path) -> None:
    settings_path = tmp_path / "fresh-clone" / "config" / "pixypilot.yaml"
    service = SettingsService(settings_path)

    settings = await service.update_settings(AppSettingsUpdate.model_validate({"safety": {"start_in_privacy": False}}))

    assert settings.safety.start_in_privacy is False
    assert settings_path.read_text(encoding="utf-8") == "safety:\n  start_in_privacy: false\n"
    assert [path.name for path in settings_path.parent.iterdir()] == ["pixypilot.yaml"]


async def test_settings_update_reports_corrupt_yaml_as_value_error(tmp_path) -> None:
    settings_path = tmp_path / "pixypilot.yaml"
    settings_path.write_text("safety: [unclosed\n", encoding="utf-8")

    with pytest.raises(ValueError, match="not valid YAML"):
        await SettingsService(settings_path).update_settings(
            AppSettingsUpdate.model_validate({"safety": {"start_in_privacy": False}})
        )
    assert settings_path.read_text(encoding="utf-8") == "safety: [unclosed\n"
