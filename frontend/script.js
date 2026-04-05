const DEFAULT_API_BASE = window.ANIMATIC_API_BASE || "http://127.0.0.1:8000";
const FPS = 24;

const apiBaseInput = document.getElementById("apiBaseUrl");
const videoInput = document.getElementById("videoFile");
const videoPreview = document.getElementById("videoPreview");
const videoThumbnail = document.getElementById("thumbnail") || document.getElementById("videoThumbnail");
const videoPlayer = document.getElementById("videoPlayer");
const timeline = document.getElementById("timeline");
const frameTicks = document.getElementById("frameTicks");
const markersContainer = document.getElementById("markers");
const playhead = document.getElementById("playhead");
const currentFrameDisplay = document.getElementById("currentFrameDisplay");
const totalFramesDisplay = document.getElementById("totalFramesDisplay");
const zoomInButton = document.getElementById("zoomIn");
const zoomOutButton = document.getElementById("zoomOut");
const playheadBackButton = document.getElementById("playheadBack");
const playheadForwardButton = document.getElementById("playheadForward");
const addMarkerButton = document.getElementById("addMarker");
const deleteMarkerButton = document.getElementById("deleteMarker");
const undoChangeButton = document.getElementById("undoChange");
const redoChangeButton = document.getElementById("redoChange");
const saveChangesButton = document.getElementById("saveChanges");
const analyzeButton = document.getElementById("analyzeButton");
const statusEl = document.getElementById("status");
const resultsTable = document.getElementById("resultsTable");
const tableBody = resultsTable.querySelector("tbody");

const ZOOM_MIN = 1;
const ZOOM_MAX = 20;
const baseWidth = 1000;

let markers = [];
let currentVideoUrl = null;
let selectedMarkerIndex = null;
let isDirty = false;
let zoomLevel = 1;
let selectedMarkerLockedToPlayhead = false;
let history = [];
let historyIndex = -1;
let savedMarkersSnapshot = "[]";

const storedApiBase = localStorage.getItem("animaticApiBase");
apiBaseInput.value = storedApiBase || DEFAULT_API_BASE;

apiBaseInput.addEventListener("change", () => {
  localStorage.setItem("animaticApiBase", apiBaseInput.value.trim());
});

function timeToFrame(time) {
  return Math.round(time * FPS);
}

function frameToTime(frame) {
  return frame / FPS;
}

function getVideoLastFrame() {
  if (!videoPlayer.duration || !Number.isFinite(videoPlayer.duration)) {
    return 0;
  }

  return Math.max(0, timeToFrame(videoPlayer.duration) - 1);
}

function updateFrameDisplays() {
  const currentFrame = Math.max(0, timeToFrame(videoPlayer.currentTime));
  const lastFrame = getVideoLastFrame();

  currentFrameDisplay.textContent = String(Math.min(currentFrame, lastFrame));
  totalFramesDisplay.textContent = String(lastFrame + 1);
}

function getTimelineWidth() {
  return baseWidth * zoomLevel;
}

function serializeMarkers(markerList = markers) {
  return JSON.stringify(markerList.map((marker) => ({ frame: marker.frame })));
}

function normalizeMarkers() {
  const lastFrame = getVideoLastFrame();
  markers.forEach((marker) => {
    const parsedFrame = Number(marker.frame);
    const safeFrame = Number.isFinite(parsedFrame) ? parsedFrame : 0;
    marker.frame = Math.max(0, Math.min(Math.round(safeFrame), lastFrame));
  });
  markers.sort((a, b) => a.frame - b.frame);
}

function setDirtyState(dirty) {
  isDirty = dirty;
  saveChangesButton.style.display = dirty ? "inline-block" : "none";
}

function syncDirtyStateWithSavedSnapshot() {
  setDirtyState(serializeMarkers() !== savedMarkersSnapshot);
}

function setVideoTimeByFrame(frame) {
  if (!videoPlayer.duration || !Number.isFinite(videoPlayer.duration)) {
    return;
  }
  const totalFrames = getVideoLastFrame();
  const safeFrame = Math.max(0, Math.min(frame, totalFrames));
  videoPlayer.currentTime = frameToTime(safeFrame);
  updateFrameDisplays();
}

function updateUndoRedoButtons() {
  undoChangeButton.disabled = historyIndex <= 0;
  redoChangeButton.disabled = historyIndex >= history.length - 1;
}

function pushHistorySnapshot() {
  const snapshot = {
    markers: markers.map((marker) => ({ frame: marker.frame })),
    selectedMarkerIndex,
    selectedMarkerLockedToPlayhead,
  };

  history = history.slice(0, historyIndex + 1);
  history.push(snapshot);
  historyIndex = history.length - 1;
  updateUndoRedoButtons();
}

function restoreHistorySnapshot(targetIndex) {
  if (targetIndex < 0 || targetIndex >= history.length) {
    return;
  }

  const snapshot = history[targetIndex];
  historyIndex = targetIndex;
  markers = snapshot.markers.map((marker) => ({ frame: marker.frame }));

  if (snapshot.selectedMarkerIndex === null || snapshot.selectedMarkerIndex >= markers.length) {
    selectedMarkerIndex = null;
    selectedMarkerLockedToPlayhead = false;
  } else {
    selectedMarkerIndex = snapshot.selectedMarkerIndex;
    selectedMarkerLockedToPlayhead = snapshot.selectedMarkerLockedToPlayhead;
    if (selectedMarkerLockedToPlayhead) {
      setVideoTimeByFrame(markers[selectedMarkerIndex].frame);
    }
  }

  renderMarkers();
  updateTable();
  syncDirtyStateWithSavedSnapshot();
  updateUndoRedoButtons();
}

function commitMarkerChange(mutator) {
  mutator();
  const selectedMarker = selectedMarkerIndex !== null ? markers[selectedMarkerIndex] : null;
  normalizeMarkers();
  selectedMarkerIndex = selectedMarker ? markers.indexOf(selectedMarker) : null;
  if (selectedMarkerIndex === -1) {
    selectedMarkerIndex = null;
    selectedMarkerLockedToPlayhead = false;
  }
  renderMarkers();
  updateTable();
  syncDirtyStateWithSavedSnapshot();
  pushHistorySnapshot();
}

function setStatus(message, type = "info") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

function resetThumbnail() {
  videoThumbnail.removeAttribute("src");
  videoPreview.hidden = true;
}

function resetVideoSource() {
  if (currentVideoUrl) {
    URL.revokeObjectURL(currentVideoUrl);
    currentVideoUrl = null;
  }
  videoPlayer.removeAttribute("src");
  videoPlayer.load();
  playhead.style.left = "0px";
  updateFrameDisplays();
}

function applyChanges() {
  normalizeMarkers();
  if (selectedMarkerIndex !== null && selectedMarkerIndex >= markers.length) {
    selectedMarkerIndex = null;
    selectedMarkerLockedToPlayhead = false;
  }
  renderMarkers();
  updateTable();
  savedMarkersSnapshot = serializeMarkers();
  setDirtyState(false);
  pushHistorySnapshot();
}

function generateVideoThumbnail(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const hiddenVideo = document.createElement("video");
    hiddenVideo.preload = "metadata";
    hiddenVideo.muted = true;
    hiddenVideo.playsInline = true;
    hiddenVideo.style.display = "none";
    document.body.appendChild(hiddenVideo);

    let seekedHandled = false;

    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
      hiddenVideo.pause();
      hiddenVideo.removeAttribute("src");
      hiddenVideo.load();
      hiddenVideo.remove();
    };

    hiddenVideo.addEventListener("loadeddata", () => {
      hiddenVideo.currentTime = 1;
    });

    hiddenVideo.addEventListener("seeked", () => {
      if (seekedHandled) {
        return;
      }
      seekedHandled = true;

      const canvas = document.createElement("canvas");
      canvas.width = hiddenVideo.videoWidth;
      canvas.height = hiddenVideo.videoHeight;
      const context = canvas.getContext("2d");

      if (!context || !canvas.width || !canvas.height) {
        cleanup();
        reject(new Error("Could not render preview frame."));
        return;
      }

      context.drawImage(hiddenVideo, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/png");
      cleanup();
      resolve(dataUrl);
    });

    hiddenVideo.addEventListener("error", () => {
      cleanup();
      reject(new Error("Could not read video preview."));
    });

    hiddenVideo.src = objectUrl;
  });
}

function updatePlayhead() {
  if (!videoPlayer.duration || !Number.isFinite(videoPlayer.duration)) {
    playhead.style.left = "0px";
    updateFrameDisplays();
    return;
  }

  const frame = timeToFrame(videoPlayer.currentTime);
  const timelineWidth = timeline.clientWidth;
  const totalFrames = Math.max(1, getVideoLastFrame());
  const x = (frame / totalFrames) * timelineWidth;
  playhead.style.left = `${x}px`;
  updateFrameDisplays();
}

function renderFrameTicks() {
  frameTicks.innerHTML = "";

  if (!videoPlayer.duration || !Number.isFinite(videoPlayer.duration)) {
    return;
  }

  const totalFrames = Math.max(1, getVideoLastFrame());
  const width = getTimelineWidth();
  const fragment = document.createDocumentFragment();

  for (let i = 0; i <= totalFrames; i += 1) {
    const tick = document.createElement("div");
    tick.className = "tick";
    const x = (i / totalFrames) * width;
    tick.style.left = `${x}px`;
    fragment.appendChild(tick);
  }

  frameTicks.appendChild(fragment);
}

function renderMarkers() {
  markersContainer.innerHTML = "";

  if (!videoPlayer.duration || !Number.isFinite(videoPlayer.duration)) {
    return;
  }

  const timelineWidth = timeline.clientWidth;
  const totalFrames = Math.max(1, getVideoLastFrame());

  markers.forEach((m, index) => {
    const el = document.createElement("div");
    el.className = "marker";
    if (selectedMarkerIndex === index) {
      el.classList.add("selected");
    }

    const label = document.createElement("span");
    label.className = "marker-label";
    label.textContent = String(index + 1);
    el.appendChild(label);

    const clampedFrame = Math.max(0, Math.min(m.frame, totalFrames));
    const x = (clampedFrame / totalFrames) * timelineWidth;
    el.style.left = `${x}px`;

    el.draggable = true;
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      selectedMarkerIndex = index;
      selectedMarkerLockedToPlayhead = true;
      setVideoTimeByFrame(m.frame);
      renderMarkers();
    });

    el.addEventListener("dragend", (e) => {
      const rect = markersContainer.getBoundingClientRect();
      const relativeX = e.clientX - rect.left;
      const safeX = Math.min(Math.max(relativeX, 0), timelineWidth);
      const newFrame = Math.round((safeX / timelineWidth) * totalFrames);

      commitMarkerChange(() => {
        m.frame = Math.max(0, Math.min(newFrame, totalFrames));
        selectedMarkerIndex = index;
        if (selectedMarkerLockedToPlayhead) {
          setVideoTimeByFrame(m.frame);
        }
      });
    });

    markersContainer.appendChild(el);
  });
}

function updateTable() {
  tableBody.innerHTML = "";

  if (!videoPlayer.duration || !Number.isFinite(videoPlayer.duration) || markers.length < 1) {
    resultsTable.hidden = true;
    return;
  }

  const lastVideoFrame = getVideoLastFrame();

  for (let i = 0; i < markers.length; i += 1) {
    const start = markers[i].frame;
    const nextStart = i < markers.length - 1 ? markers[i + 1].frame : lastVideoFrame + 1;
    const end = Math.min(lastVideoFrame, nextStart - 1);
    const duration = Math.max(0, end - start + 1);

    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${i + 1}</td>
      <td>${start}</td>
      <td>${end}</td>
      <td>${duration}</td>
    `;
    tableBody.appendChild(row);
  }

  resultsTable.hidden = false;
}

async function parseResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text || "Unexpected server response." };
  }
}

videoInput.addEventListener("change", async () => {
  const file = videoInput.files[0];

  if (!file) {
    resetThumbnail();
    resetVideoSource();
    markers = [];
    selectedMarkerIndex = null;
    renderMarkers();
    applyChanges();
    return;
  }

  resetVideoSource();
  currentVideoUrl = URL.createObjectURL(file);
  videoPlayer.src = currentVideoUrl;
  videoPlayer.load();

  markers = [];
  selectedMarkerIndex = null;
  renderMarkers();
  applyChanges();

  try {
    const thumbnailDataUrl = await generateVideoThumbnail(file);
    videoThumbnail.src = thumbnailDataUrl;
    videoPreview.hidden = false;
  } catch {
    resetThumbnail();
    setStatus("Video selected, but preview thumbnail could not be generated.", "info");
  }
});

videoPlayer.addEventListener("loadedmetadata", () => {
  updateTimeline();
  renderMarkers();
  updatePlayhead();
});

videoPlayer.addEventListener("timeupdate", () => {
  updatePlayhead();
});

timeline.addEventListener("click", (e) => {
  if (!videoPlayer.duration || !Number.isFinite(videoPlayer.duration)) {
    return;
  }

  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const timelineWidth = rect.width;
  const totalFrames = Math.max(1, getVideoLastFrame());
  const frame = Math.round((x / timelineWidth) * totalFrames);

  selectedMarkerIndex = null;
  selectedMarkerLockedToPlayhead = false;
  renderMarkers();
  videoPlayer.currentTime = frameToTime(frame);
  updateFrameDisplays();
});

markersContainer.addEventListener("click", () => {
  selectedMarkerIndex = null;
  selectedMarkerLockedToPlayhead = false;
  renderMarkers();
});

document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".marker")) {
    selectedMarkerIndex = null;
    selectedMarkerLockedToPlayhead = false;
    renderMarkers();
  }
});

window.addEventListener("resize", () => {
  updateTimeline();
  renderMarkers();
  updatePlayhead();
});

function updateTimeline() {
  timeline.style.width = `${getTimelineWidth()}px`;
  renderMarkers();
  renderFrameTicks();
  updatePlayhead();
  updateFrameDisplays();
}

async function analyzeAnimatic() {
  const file = videoInput.files[0];
  if (!file) {
    setStatus("Please select a video file first.", "error");
    return;
  }

  const apiBaseUrl = apiBaseInput.value.trim().replace(/\/$/, "");
  if (!apiBaseUrl) {
    setStatus("Please enter a valid backend API URL.", "error");
    return;
  }

  localStorage.setItem("animaticApiBase", apiBaseUrl);

  const formData = new FormData();
  formData.append("file", file);

  setStatus("Analyzing... this may take a moment depending on file size.");
  analyzeButton.disabled = true;

  try {
    const response = await fetch(`${apiBaseUrl}/analyze/`, {
      method: "POST",
      body: formData,
    });

    const payload = await parseResponse(response);

    if (!response.ok) {
      const detail = payload.detail || "Unknown server error.";
      throw new Error(detail);
    }

    const scenes = Array.isArray(payload) ? payload : [];
    markers = scenes.map((scene) => ({
      frame: Number(scene.start_frame) || 0,
    }));

    selectedMarkerIndex = null;
    selectedMarkerLockedToPlayhead = false;
    renderMarkers();
    applyChanges();

    setStatus(`Analysis complete. Detected ${scenes.length} scenes.`, "success");
  } catch (error) {
    setStatus(`Analysis failed: ${error.message}`, "error");
    markers = [];
    selectedMarkerIndex = null;
    selectedMarkerLockedToPlayhead = false;
    renderMarkers();
    applyChanges();
  } finally {
    analyzeButton.disabled = false;
  }
}

zoomInButton.onclick = () => {
  zoomLevel = Math.min(ZOOM_MAX, zoomLevel + 1);
  updateTimeline();
};

zoomOutButton.onclick = () => {
  zoomLevel = Math.max(ZOOM_MIN, zoomLevel - 1);
  updateTimeline();
};

deleteMarkerButton.onclick = () => {
  if (selectedMarkerIndex === null) {
    return;
  }

  commitMarkerChange(() => {
    markers.splice(selectedMarkerIndex, 1);
    selectedMarkerIndex = null;
    selectedMarkerLockedToPlayhead = false;
  });
};

addMarkerButton.onclick = () => {
  if (!videoPlayer.duration || !Number.isFinite(videoPlayer.duration)) {
    return;
  }

  const frame = Math.max(0, Math.min(timeToFrame(videoPlayer.currentTime), getVideoLastFrame()));
  commitMarkerChange(() => {
    markers.push({ frame });
    selectedMarkerIndex = markers.length - 1;
    selectedMarkerLockedToPlayhead = true;
  });
};

saveChangesButton.onclick = () => {
  applyChanges();
};

undoChangeButton.onclick = () => {
  restoreHistorySnapshot(historyIndex - 1);
};

redoChangeButton.onclick = () => {
  restoreHistorySnapshot(historyIndex + 1);
};

playheadBackButton.onclick = () => {
  const frame = timeToFrame(videoPlayer.currentTime);
  setVideoTimeByFrame(frame - 1);
};

playheadForwardButton.onclick = () => {
  const frame = timeToFrame(videoPlayer.currentTime);
  setVideoTimeByFrame(frame + 1);
};

document.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
    return;
  }

  if (event.key === "ArrowLeft") {
    event.preventDefault();
    const frame = timeToFrame(videoPlayer.currentTime);
    setVideoTimeByFrame(frame - 1);
  }

  if (event.key === "ArrowRight") {
    event.preventDefault();
    const frame = timeToFrame(videoPlayer.currentTime);
    setVideoTimeByFrame(frame + 1);
  }
});

analyzeButton.addEventListener("click", analyzeAnimatic);
updateTimeline();
updateFrameDisplays();
pushHistorySnapshot();
