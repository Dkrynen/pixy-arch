from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI, HTTPException

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
