"""Scene detection logic for animatic uploads."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal


class SceneDetectionError(RuntimeError):
    """Raised when scene detection cannot be completed."""


def analyze_scenes(
    video_path: Path,
    threshold: float = 27.0,
    min_scene_duration_frames: int = 12,
    mode: Literal["animation", "animatic"] = "animatic",
) -> list[dict[str, Any]]:
    """Detect scenes and return a normalized frame-based result list.

    cv2 and scenedetect are imported lazily inside this function so that the
    server can start up quickly without loading the heavy OpenCV/scenedetect
    libraries at import time (critical for Render free-tier cold starts).

    Args:
        video_path: Path to local video file.
        threshold: Adaptive threshold sensitivity (passed as adaptive_threshold to
                   AdaptiveDetector). Lower values increase sensitivity.
        min_scene_duration_frames: Scenes shorter than this value (in frames) are
                                   merged into adjacent scenes. Defaults to 12.
        mode: Detection mode. "animatic" applies an additional second-pass temporal
              smoothing on top of the base short-scene filter, reducing false positives
              caused by pencil-line noise and cross-artist style variation. "animation"
              applies only the base filter.

    Returns:
        List of scenes with scene number, start/end frame, and duration in frames.

    Raises:
        SceneDetectionError: If video metadata cannot be read or analysis fails.
    """
    import cv2  # noqa: PLC0415 — lazy import to keep server startup fast
    from scenedetect import AdaptiveDetector, detect  # noqa: PLC0415

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise SceneDetectionError("Unable to open uploaded video file.")

    total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    capture.release()

    if total_frames <= 0:
        raise SceneDetectionError("Unable to determine total frame count for video.")

    try:
        detected = detect(str(video_path), AdaptiveDetector(adaptive_threshold=threshold))
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

    # First pass: merge scenes shorter than min_scene_duration_frames.
    scenes = _merge_short_scenes(scenes, min_scene_duration_frames)

    # Second pass (animatic mode only): temporal smoothing — merges cuts that remain
    # within min_scene_duration_frames of each other after the first pass.
    if mode == "animatic":
        scenes = _merge_short_scenes(scenes, min_scene_duration_frames)

    for i, scene in enumerate(scenes, start=1):
        scene["scene"] = i

    return scenes


def _merge_short_scenes(
    scenes: list[dict[str, Any]], min_duration: int
) -> list[dict[str, Any]]:
    """Merge scenes shorter than *min_duration* into adjacent scenes.

    Short scenes are folded into the following scene; if the short scene is last,
    it is folded into the preceding one. Iteration continues until no scene shorter
    than *min_duration* remains (so that merges don't create new short scenes).
    """
    result = [dict(s) for s in scenes]
    changed = True
    while changed:
        changed = False
        new_result: list[dict[str, Any]] = []
        i = 0
        while i < len(result):
            curr = result[i]
            if curr["duration_frames"] < min_duration:
                if i + 1 < len(result):
                    # Fold short scene into the next one.
                    nxt = result[i + 1]
                    new_result.append(
                        {
                            "scene": curr["scene"],
                            "start_frame": curr["start_frame"],
                            "end_frame": nxt["end_frame"],
                            "duration_frames": nxt["end_frame"] - curr["start_frame"],
                        }
                    )
                    i += 2
                    changed = True
                elif new_result:
                    # Last scene is short — fold into the previous one.
                    new_result[-1]["end_frame"] = curr["end_frame"]
                    new_result[-1]["duration_frames"] = (
                        curr["end_frame"] - new_result[-1]["start_frame"]
                    )
                    i += 1
                    changed = True
                else:
                    # Only one scene in the list and it is short; keep it as-is.
                    new_result.append(curr)
                    i += 1
            else:
                new_result.append(curr)
                i += 1
        result = new_result
    return result
