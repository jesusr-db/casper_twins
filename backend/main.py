"""
Digital Twin & Driver Tracking — FastAPI Application

Serves the React frontend as static files and exposes API endpoints
that query Lakebase Postgres for real-time delivery data.
"""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from backend.db import close_pool, init_pool
from backend.routes import cx, drivers, markets, orders, playback

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle — pool init on startup, cleanup on shutdown."""
    logger.info("Starting Digital Twin application...")
    await init_pool()
    logger.info("Application ready")
    yield
    logger.info("Shutting down...")
    await close_pool()


app = FastAPI(
    title="Digital Twin & Driver Tracking",
    description="Real-time delivery operations dashboard powered by Lakebase",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS — allow all origins in dev/demo mode
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Handle missing tables gracefully — use BaseHTTPMiddleware so the exception
# is caught before uvicorn's ServerErrorMiddleware logs a noisy traceback.
class DBErrorMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        try:
            return await call_next(request)
        except Exception as exc:
            if "UndefinedTable" in type(exc).__name__ or "does not exist" in str(exc):
                table = str(exc).split('"')[1] if '"' in str(exc) else "unknown"
                logger.warning("Table not yet available: %s — run setup-lakebase job", table)
                return JSONResponse(
                    status_code=503,
                    content={"error": "data_not_ready", "detail": f"Table '{table}' not synced yet."},
                )
            raise

app.add_middleware(DBErrorMiddleware)


# Mount API routes
app.include_router(markets.router)
app.include_router(orders.router)
app.include_router(drivers.router)
app.include_router(playback.router)
app.include_router(cx.router)


# Health check
@app.get("/api/health")
async def health_check():
    """Health check endpoint for Databricks Apps readiness probe."""
    return {"status": "ok", "app": "digital-twin"}


# Serve React frontend static files
# In production, Vite builds to frontend/dist/
# FastAPI serves index.html for all non-API routes (SPA routing)
FRONTEND_DIR = Path(__file__).parent.parent / "frontend" / "dist"

if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
    logger.info("Serving frontend from %s", FRONTEND_DIR)
else:
    logger.warning(
        "Frontend dist directory not found at %s — API-only mode", FRONTEND_DIR
    )
