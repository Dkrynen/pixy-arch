import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from pixypilot.api.routes import router
from pixypilot.config import (
    cors_origins,
    frontend_dist_path,
    start_in_privacy,
    virtualcam_autostart,
    virtualcam_on_demand,
)
from pixypilot.domains.audio.service import get_audio_service
from pixypilot.domains.automation.service import get_automation_service
from pixypilot.domains.pixy_hid.service import get_pixy_hid_service
from pixypilot.domains.video.service import get_video_service
from pixypilot.domains.virtualcam.models import VirtualCamStartRequest
from pixypilot.domains.virtualcam.service import get_virtualcam_service

_LOG = logging.getLogger("pixypilot.startup")


async def _apply_start_in_privacy() -> None:
    # The hidraw node may not be writable yet at boot (udev rule still being
    # applied); retry rather than skipping the safety step. Privacy covers the
    # lens; the mic is muted too — entering privacy never depends on a browser
    # being open. Failures are logged, not fatal: any exception type retries.
    service = get_pixy_hid_service()
    audio = get_audio_service()
    for attempt in range(45):
        try:
            status = await service.status()
            if status.writable:
                await service.set_tracking("privacy")
                try:
                    await audio.set_mute(True)
                except Exception:
                    _LOG.exception("privacy start: mic mute failed")
                _LOG.info("privacy start: tracking=privacy applied (attempt %d)", attempt + 1)
                return
        except Exception:
            _LOG.warning("privacy start: attempt %d failed", attempt + 1, exc_info=True)
        await asyncio.sleep(1.0)
    _LOG.error("privacy start: gave up after 45s — HID device never writable")


async def _autostart_virtualcam() -> None:
    # Give udev/hotplug a beat to enumerate /dev/video0 + the loopback sink
    # before claiming the camera — and don't keep retrying forever: a missing
    # device at boot is reported by /api/virtualcam/status anyway.
    service = get_virtualcam_service()
    on_demand = virtualcam_on_demand()
    for attempt in range(30):
        try:
            status = await service.status()
            if status.running or status.mode == "standby":
                return
            if status.available:
                if on_demand:
                    result = await service.arm(VirtualCamStartRequest())
                    if result.ok:
                        _LOG.info(
                            "virtualcam autostart: armed on-demand standby (attempt %d)",
                            attempt + 1,
                        )
                        return
                else:
                    await service.start(VirtualCamStartRequest())
                    _LOG.info("virtualcam autostart: pipeline started (attempt %d)", attempt + 1)
                    return
        except Exception:
            _LOG.warning("virtualcam autostart: attempt %d failed", attempt + 1, exc_info=True)
        await asyncio.sleep(1.0)
    _LOG.error("virtualcam autostart: gave up after 30s — loopback never available")


@asynccontextmanager
async def lifespan(app: FastAPI):
    automation = get_automation_service()
    if automation.settings.enabled:
        await automation.start()
    if start_in_privacy():
        asyncio.create_task(_apply_start_in_privacy())
    if virtualcam_autostart():
        asyncio.create_task(_autostart_virtualcam())
    yield
    await automation.stop()
    # Stop recordings/streams before the vcam: a device-fed recorder ffmpeg
    # would otherwise outlive the process holding the camera node, blocking
    # the next boot's autostart.
    video = get_video_service()
    await video.stop_recording()
    await video.stop_streams()
    await get_virtualcam_service().stop()


app = FastAPI(title="PixyPilot API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins(),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


frontend_dist = frontend_dist_path()
frontend_index = frontend_dist / "index.html"
frontend_assets = frontend_dist / "assets"

if frontend_index.exists():
    if frontend_assets.exists():
        app.mount("/assets", StaticFiles(directory=frontend_assets), name="assets")

    @app.get("/")
    async def frontend_index_route() -> FileResponse:
        return FileResponse(frontend_index)

    @app.get("/{path:path}", include_in_schema=False)
    async def frontend_fallback(path: str) -> FileResponse:
        # API misses and asset misses must not be answered with index.html:
        # a JS import receiving HTML fails with a confusing MIME error.
        if path.startswith("api/") or path.startswith("assets/"):
            raise HTTPException(status_code=404, detail="Not found")
        return FileResponse(frontend_index)
