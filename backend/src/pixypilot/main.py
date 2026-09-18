import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from pixypilot.api.routes import router
from pixypilot.config import cors_origins, frontend_dist_path, start_in_privacy
from pixypilot.domains.automation.service import get_automation_service
from pixypilot.domains.pixy_hid.service import get_pixy_hid_service


async def _apply_start_in_privacy() -> None:
    # The hidraw node may not be writable yet at boot (udev rule still being
    # applied); retry briefly rather than skipping the safety step.
    service = get_pixy_hid_service()
    for _ in range(20):
        try:
            status = await service.status()
            if status.writable:
                await service.set_tracking("privacy")
                return
        except (FileNotFoundError, PermissionError, OSError):
            pass
        await asyncio.sleep(1.0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    automation = get_automation_service()
    if automation.settings.enabled:
        await automation.start()
    if start_in_privacy():
        asyncio.create_task(_apply_start_in_privacy())
    yield
    await automation.stop()


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
