import asyncio
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI, HTTPException

import pixypilot.main as main_module
from pixypilot.main import frontend_fallback_response, mount_frontend


@pytest.fixture
def frontend_dist(tmp_path: Path) -> Path:
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "index.js").write_text("export {};", encoding="utf-8")
    (tmp_path / "index.html").write_text("<!doctype html><title>deck</title>", encoding="utf-8")
    return tmp_path


def test_spa_fallback_rejects_api_paths(frontend_dist: Path) -> None:
    with pytest.raises(HTTPException) as exc_info:
        frontend_fallback_response(frontend_dist / "index.html", "api/does-not-exist")

    assert exc_info.value.status_code == 404


def test_spa_fallback_rejects_missing_assets(frontend_dist: Path) -> None:
    # A missing asset must 404 — serving index.html to a JS request produces
    # a confusing MIME-type failure in the browser.
    with pytest.raises(HTTPException) as exc_info:
        frontend_fallback_response(frontend_dist / "index.html", "assets/missing-bundle.js")

    assert exc_info.value.status_code == 404


def test_spa_fallback_serves_index_for_app_routes(frontend_dist: Path) -> None:
    response = frontend_fallback_response(frontend_dist / "index.html", "settings")

    assert Path(response.path).name == "index.html"


def test_mount_frontend_skips_missing_build(tmp_path: Path) -> None:
    app = FastAPI()

    assert mount_frontend(app, tmp_path / "missing-dist") is False
    assert len(app.routes) == len(FastAPI().routes)


async def test_mounted_frontend_serves_index_assets_and_app_routes(frontend_dist: Path) -> None:
    app = FastAPI()
    assert mount_frontend(app, frontend_dist) is True

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as client:
        index = await client.get("/")
        asset = await client.get("/assets/index.js")
        app_route = await client.get("/settings")
        missing_asset = await client.get("/assets/missing.js")
        missing_api = await client.get("/api/missing")

    assert index.status_code == 200
    assert "<title>deck</title>" in index.text
    assert asset.status_code == 200
    assert app_route.status_code == 200
    assert "<title>deck</title>" in app_route.text
    assert missing_asset.status_code == 404
    assert missing_api.status_code == 404


def test_api_title_uses_product_name() -> None:
    assert main_module.app.title == "Pixy Arch API"


class _Recorder:
    def __init__(self, calls: list[str], name: str) -> None:
        self.calls = calls
        self.name = name

    def __getattr__(self, method: str):
        async def record(*_args, **_kwargs):
            self.calls.append(f"{self.name}.{method}")

        return record


async def test_lifespan_keeps_startup_tasks_and_stops_audio_on_shutdown(monkeypatch) -> None:
    calls: list[str] = []
    started = asyncio.Event()
    cancelled: list[bool] = []

    async def privacy_loop() -> None:
        started.set()
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            cancelled.append(True)
            raise

    class Automation(_Recorder):
        settings = type("S", (), {"enabled": False})()

    async def watchdog_shutdown() -> None:
        calls.append("ptz.shutdown")

    monkeypatch.setattr(main_module, "get_automation_service", lambda: Automation(calls, "automation"))
    monkeypatch.setattr(main_module, "get_video_service", lambda: _Recorder(calls, "video"))
    monkeypatch.setattr(main_module, "get_virtualcam_service", lambda: _Recorder(calls, "vcam"))
    monkeypatch.setattr(main_module, "get_audio_service", lambda: _Recorder(calls, "audio"))
    monkeypatch.setattr(main_module, "shutdown_ptz_watchdog", watchdog_shutdown)
    monkeypatch.setattr(main_module, "start_in_privacy", lambda: True)
    monkeypatch.setattr(main_module, "virtualcam_autostart", lambda: False)
    monkeypatch.setattr(main_module, "_apply_start_in_privacy", privacy_loop)

    async with main_module.lifespan(main_module.app):
        await asyncio.wait_for(started.wait(), timeout=1)
        # A strong reference keeps the task alive; the loop only holds a weak one.
        assert len(main_module._BACKGROUND_TASKS) == 1  # noqa: SLF001

    assert cancelled == [True]
    assert main_module._BACKGROUND_TASKS == set()  # noqa: SLF001
    assert "audio.stop_monitor" in calls
    assert "audio.stop_meter" in calls
    assert "ptz.shutdown" in calls
    assert calls.index("video.stop_recording") < calls.index("vcam.stop")


async def test_shutdown_step_failure_does_not_skip_later_steps(monkeypatch) -> None:
    calls: list[str] = []

    async def boom() -> None:
        raise RuntimeError("pw-loopback vanished")

    async def fine() -> None:
        calls.append("fine")

    await main_module._shutdown_step("boom", boom())  # noqa: SLF001
    await main_module._shutdown_step("fine", fine())  # noqa: SLF001

    assert calls == ["fine"]
