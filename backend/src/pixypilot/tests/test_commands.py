import httpx
import pytest

from pixypilot.core.commands import AsyncCommandRunner, CommandError
from pixypilot.domains.audio.service import AudioService
from pixypilot.main import app


async def test_missing_binary_raises_command_error() -> None:
    with pytest.raises(CommandError) as exc_info:
        await AsyncCommandRunner().run(["pixypilot-definitely-not-installed", "--help"])

    assert exc_info.value.result.returncode == 127
    assert "command not found" in str(exc_info.value)


async def test_nonzero_exit_raises_command_error() -> None:
    with pytest.raises(CommandError) as exc_info:
        await AsyncCommandRunner().run(["sh", "-c", "echo broken >&2; exit 3"])

    assert exc_info.value.result.returncode == 3
    assert "broken" in str(exc_info.value)


async def test_audio_status_degrades_without_alsa_or_pipewire_tools() -> None:
    class MissingTools(AsyncCommandRunner):
        async def run(self, argv: list[str]):
            return await super().run([f"pixypilot-missing-{argv[0]}", *argv[1:]])

    status = await AudioService(runner=MissingTools()).status()

    assert status.available is False
    assert status.reason


async def test_command_errors_become_readable_503s() -> None:
    @app.get("/__test__/command-error")
    async def fail() -> None:
        await AsyncCommandRunner().run(["pixypilot-definitely-not-installed"])

    # Ahead of the SPA catch-all, which would otherwise answer with index.html.
    test_route = app.router.routes.pop()
    app.router.routes.insert(0, test_route)
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as client:
            response = await client.get("/__test__/command-error")
    finally:
        app.router.routes.remove(test_route)

    assert response.status_code == 503
    assert "command not found" in response.json()["detail"]
