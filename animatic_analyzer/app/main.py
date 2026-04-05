"""FastAPI application entrypoint for Animatic Analyzer."""

from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .scenes import SceneDetectionError, analyze_scenes
from .utils import (
    ensure_directories,
    output_report_path,
    unique_upload_path,
    write_json_report,
)

app = FastAPI(title="Animatic Analyzer API", version="1.1.0")

# For production you should set specific origins via environment variables.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ALLOWED_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}


@app.on_event("startup")
def startup_event() -> None:
    """Create local storage directories used by the service."""
    ensure_directories()


@app.get("/health")
def health() -> dict[str, str]:
    """Simple health endpoint for deployment checks."""
    return {"status": "ok"}


@app.post("/analyze/")
async def analyze_video(file: UploadFile = File(...)) -> list[dict[str, int]]:
    """Upload an animatic video and return detected scenes in JSON format."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="Filename is required.")

    extension = Path(file.filename).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file extension '{extension}'. Allowed: {sorted(ALLOWED_EXTENSIONS)}",
        )

    upload_path = unique_upload_path(file.filename)

    try:
        with upload_path.open("wb") as out_file:
            shutil.copyfileobj(file.file, out_file)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save upload: {exc}") from exc
    finally:
        file.file.close()

    try:
        scenes = analyze_scenes(upload_path)
        write_json_report(output_report_path(upload_path), scenes)
    except SceneDetectionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - defensive path.
        raise HTTPException(status_code=500, detail=f"Unexpected analysis error: {exc}") from exc

    return scenes
