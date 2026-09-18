import pytest
from fastapi import HTTPException

from pixypilot.main import frontend_fallback


async def test_spa_fallback_rejects_api_paths() -> None:
    with pytest.raises(HTTPException) as exc_info:
        await frontend_fallback("api/does-not-exist")

    assert exc_info.value.status_code == 404


async def test_spa_fallback_rejects_missing_assets() -> None:
    # A missing asset must 404 — serving index.html to a JS request produces
    # a confusing MIME-type failure in the browser.
    with pytest.raises(HTTPException) as exc_info:
        await frontend_fallback("assets/missing-bundle.js")

    assert exc_info.value.status_code == 404


async def test_spa_fallback_serves_index_for_app_routes() -> None:
    response = await frontend_fallback("settings")

    assert response.path.name == "index.html"
