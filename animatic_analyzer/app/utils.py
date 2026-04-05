"""Utility helpers for filesystem operations and safe file naming."""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any


BASE_DIR = Path(__file__).resolve().parent.parent
UPLOADS_DIR = BASE_DIR / "uploads"
OUTPUTS_DIR = BASE_DIR / "outputs"



def ensure_directories() -> None:
    """Ensure local data directories exist before reading/writing files."""
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)



def unique_upload_path(original_filename: str) -> Path:
    """Create a collision-resistant upload path preserving original extension."""
    _, extension = os.path.splitext(original_filename)
    unique_name = f"{uuid.uuid4().hex}{extension.lower()}"
    return UPLOADS_DIR / unique_name



def output_report_path(upload_path: Path) -> Path:
    """Generate a matching output JSON report path for an uploaded file."""
    return OUTPUTS_DIR / f"{upload_path.stem}.json"



def write_json_report(path: Path, payload: list[dict[str, Any]]) -> None:
    """Persist scene analysis output to disk for debugging/auditing."""
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
