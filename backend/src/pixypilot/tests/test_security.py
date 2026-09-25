import httpx
import pytest
from fastapi import FastAPI

from pixypilot.security import LocalRequestGuard, host_name


def build_app(**guard_options) -> FastAPI:
    app = FastAPI()
    app.add_middleware(LocalRequestGuard, **guard_options)

    @app.get("/api/thing")
    async def read_thing() -> dict[str, bool]:
        return {"ok": True}

    @app.post("/api/thing")
    async def change_thing() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/settings")
    async def ui_route() -> dict[str, bool]:
        return {"ok": True}

    return app


async def send(
    app: FastAPI,
    method: str,
    host: str,
    headers: dict[str, str] | None = None,
    path: str = "/api/thing",
):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url=f"http://{host}") as client:
        return await client.request(method, path, headers=headers or {})


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("127.0.0.1:8000", "127.0.0.1"),
        ("LOCALHOST", "localhost"),
        ("[::1]:8000", "::1"),
        ("pixy.example.:8000", "pixy.example"),
        ("", ""),
    ],
)
def test_host_name_strips_port_brackets_and_case(header: str, expected: str) -> None:
    assert host_name(header) == expected


@pytest.mark.parametrize("host", ["127.0.0.1:8000", "localhost:8000", "[::1]:8000", "192.168.1.20:8000"])
async def test_ip_literal_and_localhost_hosts_are_allowed(host: str) -> None:
    response = await send(build_app(), "GET", host)

    assert response.status_code == 200


async def test_rebinding_hostname_is_rejected() -> None:
    response = await send(build_app(), "GET", "attacker.example:8000")

    assert response.status_code == 400
    assert "server.allowed_hosts" in response.json()["detail"]


async def test_configured_hostname_is_allowed() -> None:
    app = build_app(allowed_hosts=["pixy.lan"])

    response = await send(app, "GET", "pixy.lan:8000")

    assert response.status_code == 200


async def test_wildcard_disables_host_check() -> None:
    response = await send(build_app(allowed_hosts=["*"]), "GET", "anything.example")

    assert response.status_code == 200


async def test_non_browser_clients_are_unaffected() -> None:
    # curl, Home Assistant, and scripts send no Origin or Sec-Fetch-* headers.
    response = await send(build_app(), "POST", "127.0.0.1:8000")

    assert response.status_code == 200


async def test_same_origin_browser_write_is_allowed() -> None:
    response = await send(
        build_app(),
        "POST",
        "127.0.0.1:8000",
        {"Origin": "http://127.0.0.1:8000", "Sec-Fetch-Site": "same-origin"},
    )

    assert response.status_code == 200


async def test_cross_origin_write_is_rejected() -> None:
    response = await send(
        build_app(),
        "POST",
        "127.0.0.1:8000",
        {"Origin": "https://attacker.example", "Sec-Fetch-Site": "cross-site"},
    )

    assert response.status_code == 403


async def test_cross_origin_write_without_fetch_metadata_is_rejected() -> None:
    # Older browsers omit Sec-Fetch-*; the Origin header alone must suffice.
    response = await send(
        build_app(), "POST", "127.0.0.1:8000", {"Origin": "https://attacker.example"}
    )

    assert response.status_code == 403


async def test_opaque_origin_write_is_rejected() -> None:
    response = await send(build_app(), "POST", "127.0.0.1:8000", {"Origin": "null"})

    assert response.status_code == 403


async def test_cross_site_embed_is_rejected() -> None:
    # e.g. <img src="http://127.0.0.1:8000/api/devices/video0/stream"> on another site.
    response = await send(
        build_app(),
        "GET",
        "127.0.0.1:8000",
        {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors"},
    )

    assert response.status_code == 403


async def test_same_site_other_port_embed_is_rejected() -> None:
    response = await send(
        build_app(),
        "GET",
        "localhost:8000",
        {"Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "no-cors"},
    )

    assert response.status_code == 403


async def test_cross_site_navigation_to_ui_is_allowed() -> None:
    # Following a link or bookmark to the deck from another site still works.
    response = await send(
        build_app(),
        "GET",
        "127.0.0.1:8000",
        {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate"},
        path="/settings",
    )

    assert response.status_code == 200


async def test_cross_site_navigation_to_api_is_rejected() -> None:
    # A hostile link or popup to e.g. /api/devices/video0/stream would switch
    # the camera on.
    response = await send(
        build_app(),
        "GET",
        "127.0.0.1:8000",
        {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate"},
    )

    assert response.status_code == 403


async def test_configured_cors_origin_is_trusted() -> None:
    app = build_app(allowed_origins=["http://127.0.0.1:5173"])

    response = await send(
        app,
        "POST",
        "127.0.0.1:8000",
        {"Origin": "http://127.0.0.1:5173", "Sec-Fetch-Site": "same-site"},
    )

    assert response.status_code == 200
