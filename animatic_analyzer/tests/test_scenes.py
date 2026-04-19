"""Tests for app/scenes.py scene detection logic."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class _FakeTimecode:
    """Minimal stand-in for scenedetect.FrameTimecode used in detect() output."""

    def __init__(self, frames: int) -> None:
        self._frames = frames

    def get_frames(self) -> int:
        return self._frames


def _make_cv2_mock(total_frames: int) -> MagicMock:
    cap = MagicMock()
    cap.isOpened.return_value = True
    cap.get.return_value = float(total_frames)

    cv2 = MagicMock()
    cv2.VideoCapture.return_value = cap
    return cv2


def _make_scenedetect_mock(boundaries: list[tuple[int, int]]) -> MagicMock:
    sd = MagicMock()
    sd.detect.return_value = [
        (_FakeTimecode(s), _FakeTimecode(e)) for s, e in boundaries
    ]
    return sd


def _run(
    total_frames: int,
    boundaries: list[tuple[int, int]],
    **kwargs,
) -> list[dict]:
    """Call analyze_scenes with fully mocked cv2 and scenedetect modules."""
    mock_cv2 = _make_cv2_mock(total_frames)
    mock_sd = _make_scenedetect_mock(boundaries)

    with pytest.MonkeyPatch().context() as mp:
        mp.setitem(sys.modules, "cv2", mock_cv2)
        mp.setitem(sys.modules, "scenedetect", mock_sd)

        # Import here so the lazy import inside analyze_scenes picks up our mocks.
        from app.scenes import analyze_scenes  # noqa: PLC0415

        return analyze_scenes(Path("fake.mp4"), **kwargs)


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

def test_normal_video_returns_correct_scenes():
    """Case 1: clear three-scene video in animation mode returns three dicts."""
    scenes = _run(
        total_frames=300,
        boundaries=[(0, 100), (100, 200), (200, 300)],
        mode="animation",
        min_scene_duration_frames=1,
    )

    assert len(scenes) == 3

    assert scenes[0] == {
        "scene": 1,
        "start_frame": 0,
        "end_frame": 100,
        "duration_frames": 100,
    }
    assert scenes[1] == {
        "scene": 2,
        "start_frame": 100,
        "end_frame": 200,
        "duration_frames": 100,
    }
    assert scenes[2] == {
        "scene": 3,
        "start_frame": 200,
        "end_frame": 300,
        "duration_frames": 100,
    }


def test_empty_detection_returns_full_video_as_single_scene():
    """Case 2: when detector finds no cuts, full video is returned as scene 1."""
    scenes = _run(
        total_frames=240,
        boundaries=[],
        mode="animatic",
    )

    assert len(scenes) == 1
    assert scenes[0] == {
        "scene": 1,
        "start_frame": 0,
        "end_frame": 240,
        "duration_frames": 240,
    }


def test_short_scenes_merged_in_animatic_mode():
    """Case 3: a flash scene below min_scene_duration_frames is folded into its neighbour."""
    # Scene 2 (frames 100-105) is only 5 frames — below the 12-frame threshold.
    # It should be merged forward into scene 3, producing three scenes total.
    scenes = _run(
        total_frames=300,
        boundaries=[(0, 100), (100, 105), (105, 200), (200, 300)],
        mode="animatic",
        min_scene_duration_frames=12,
    )

    assert len(scenes) == 3
    assert scenes[0] == {
        "scene": 1,
        "start_frame": 0,
        "end_frame": 100,
        "duration_frames": 100,
    }
    # The 5-frame flash was folded into the next scene.
    assert scenes[1] == {
        "scene": 2,
        "start_frame": 100,
        "end_frame": 200,
        "duration_frames": 100,
    }
    assert scenes[2] == {
        "scene": 3,
        "start_frame": 200,
        "end_frame": 300,
        "duration_frames": 100,
    }


def test_animation_mode_does_not_apply_second_pass():
    """animation mode still applies the first-pass filter but not the second."""
    # With min=12, the 5-frame scene is still merged even in animation mode.
    scenes = _run(
        total_frames=200,
        boundaries=[(0, 100), (100, 105), (105, 200)],
        mode="animation",
        min_scene_duration_frames=12,
    )

    # First pass merges the flash → 2 scenes.
    assert len(scenes) == 2
    assert scenes[0]["end_frame"] == 100
    assert scenes[1]["start_frame"] == 100
    assert scenes[1]["end_frame"] == 200


def test_short_last_scene_merged_into_previous():
    """A trailing short scene is folded backward into the preceding scene."""
    # Last scene is only 4 frames.
    scenes = _run(
        total_frames=204,
        boundaries=[(0, 100), (100, 200), (200, 204)],
        mode="animation",
        min_scene_duration_frames=12,
    )

    assert len(scenes) == 2
    assert scenes[-1]["end_frame"] == 204
    assert scenes[-1]["start_frame"] == 100
    assert scenes[-1]["duration_frames"] == 104




def test_threshold_forwarded_to_adaptive_detector():
    """threshold arg must be passed as adaptive_threshold to AdaptiveDetector."""
    mock_cv2 = _make_cv2_mock(total_frames=120)
    mock_sd = _make_scenedetect_mock(boundaries=[(0, 120)])

    with pytest.MonkeyPatch().context() as mp:
        mp.setitem(sys.modules, "cv2", mock_cv2)
        mp.setitem(sys.modules, "scenedetect", mock_sd)

        from app.scenes import analyze_scenes  # noqa: PLC0415

        analyze_scenes(Path("fake.mp4"), threshold=19.5, mode="animation")

    mock_sd.AdaptiveDetector.assert_called_once_with(adaptive_threshold=19.5)


def test_scene_detection_error_on_unopenable_video():
    """SceneDetectionError is raised when cv2 cannot open the file."""
    mock_cv2 = MagicMock()
    cap = MagicMock()
    cap.isOpened.return_value = False
    mock_cv2.VideoCapture.return_value = cap
    mock_sd = MagicMock()

    with pytest.MonkeyPatch().context() as mp:
        mp.setitem(sys.modules, "cv2", mock_cv2)
        mp.setitem(sys.modules, "scenedetect", mock_sd)

        from app.scenes import SceneDetectionError, analyze_scenes  # noqa: PLC0415

        with pytest.raises(SceneDetectionError, match="Unable to open"):
            analyze_scenes(Path("nonexistent.mp4"))
