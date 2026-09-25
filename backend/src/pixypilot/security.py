"""Request guard for the unauthenticated local API.

PixyPilot has no login: anything that can reach the port can drive the camera,
microphone, and recorder. Binding to 127.0.0.1 keeps other machines out, but
not other *websites* open in the user's browser:

- DNS rebinding: a hostile page re-resolves its own domain to 127.0.0.1, so
  the browser treats the API as same-origin with the attacker. A rebinding
  page always sends its own domain as the Host header, so only IP literals,
  ``localhost``, this machine's name, and configured names are accepted.
- Cross-site requests (CSRF, ``<img src=".../stream">``): browsers label them
  with ``Sec-Fetch-Site`` and ``Origin``. They are refused unless the origin
  is this server or an allowed CORS origin. Top-level navigation to the UI (a
  bookmark or a dashboard link to the deck) still works; navigation straight
  to an ``/api`` URL does not, since some GETs switch the camera on.

Non-browser clients (curl, Home Assistant, scripts) send neither
``Sec-Fetch-Site`` nor ``Origin`` and are unaffected.
"""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import Iterable
from urllib.parse import urlsplit

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
UNTRUSTED_FETCH_SITES = frozenset({"cross-site", "same-site"})


def host_name(host_header: str) -> str:
    """Hostname of a Host header: lowercased, no port, no IPv6 brackets."""
    host = host_header.strip().lower()
    if host.startswith("["):
        end = host.find("]")
        return host[1:end] if end != -1 else host[1:]
    if host.count(":") == 1:
        host = host.split(":", 1)[0]
    return host.rstrip(".")


def machine_host_names() -> set[str]:
    names = {"localhost"}
    try:
        machine = socket.gethostname().strip().lower().rstrip(".")
    except OSError:
        machine = ""
    if machine:
        names.update({machine, f"{machine}.local"})
    return names


def _is_ip_literal(name: str) -> bool:
    try:
        ipaddress.ip_address(name)
    except ValueError:
        return False
    return True


def _normalize_origin(origin: str) -> str:
    return origin.strip().lower().rstrip("/")


class LocalRequestGuard:
    """Pure ASGI middleware, so streaming and SSE responses pass untouched."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        allowed_hosts: Iterable[str] = (),
        allowed_origins: Iterable[str] = (),
    ) -> None:
        self.app = app
        hosts = {host_name(host) for host in allowed_hosts if host.strip()}
        self.allow_any_host = "*" in hosts
        self.allowed_host_names = machine_host_names() | hosts
        self.allowed_origins = {
            _normalize_origin(origin) for origin in allowed_origins if origin.strip()
        }

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        rejection = self.rejection(scope["method"], Headers(scope=scope), scope["path"])
        if rejection is None:
            await self.app(scope, receive, send)
            return

        status_code, detail = rejection
        response = JSONResponse({"detail": detail}, status_code=status_code)
        await response(scope, receive, send)

    def rejection(self, method: str, headers: Headers, path: str = "/") -> tuple[int, str] | None:
        host = headers.get("host", "")
        if not self.host_allowed(host):
            return (
                400,
                f"Host '{host}' is not allowed. If you reach PixyPilot through this "
                "name, add it to server.allowed_hosts in config/pixypilot.yaml.",
            )

        origin = headers.get("origin")
        trusted_origin = origin is not None and self.origin_allowed(origin, host)

        fetch_site = headers.get("sec-fetch-site")
        is_ui_navigation = (
            method in {"GET", "HEAD"}
            and headers.get("sec-fetch-mode") == "navigate"
            and not (path == "/api" or path.startswith("/api/"))
        )
        if fetch_site in UNTRUSTED_FETCH_SITES and not trusted_origin and not is_ui_navigation:
            return 403, "Cross-site request refused."

        if method not in SAFE_METHODS and origin is not None and not trusted_origin:
            return 403, "Cross-origin request refused."

        return None

    def host_allowed(self, host_header: str) -> bool:
        if self.allow_any_host:
            return True
        name = host_name(host_header)
        if not name:
            return False
        return _is_ip_literal(name) or name in self.allowed_host_names

    def origin_allowed(self, origin: str, host_header: str) -> bool:
        normalized = _normalize_origin(origin)
        if normalized in self.allowed_origins:
            return True
        return urlsplit(normalized).netloc == host_header.strip().lower()
