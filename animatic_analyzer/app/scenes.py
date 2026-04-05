"""Scene detection logic for animatic uploads."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import cv2
from scenedetect import ContentDetector, detect


class SceneDetectionError(RuntimeError):
    """Raised when scene detection cannot be completed."""



def analyze_scenes(video_path: Path, threshold: float = 27.0) -> list[dict[str, Any]]:
    """Detect scenes and return a normalized frame-based result list.

    Args:
        video_path: Path to local video file.
        threshold: Detector sensitivity threshold. Lower values increase sensitivity.

    Returns:
        List of scenes with scene number, start/end frame, and duration in frames.

    Raises:
        SceneDetectionError: If video metadata cannot be read or analysis fails.
    """
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise SceneDetectionError("Unable to open uploaded video file.")

    total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    capture.release()

    if total_frames <= 0:
        raise SceneDetectionError("Unable to determine total frame count for video.")

    try:
        detected = detect(str(video_path), ContentDetector(threshold=threshold))
    except Exception as exc:  # pragma: no cover - defensive catch for third-party errors.
        raise SceneDetectionError(f"Scene detection failed: {exc}") from exc

    if not detected:
        return [
            {
                "scene": 1,
                "start_frame": 0,
                "end_frame": total_frames,
                "duration_frames": total_frames,
            }
        ]

    scenes: list[dict[str, Any]] = []
    for index, (start_time, end_time) in enumerate(detected, start=1):
        start_frame = max(0, int(start_time.get_frames()))
        end_frame = min(total_frames, int(end_time.get_frames()))

        if end_frame < start_frame:
            end_frame = start_frame

        scenes.append(
            {
                "scene": index,
                "start_frame": start_frame,
                "end_frame": end_frame,
                "duration_frames": end_frame - start_frame,
            }
        )

    return scenes
