const DEFAULT_API_BASE = window.ANIMATIC_API_BASE || "http://127.0.0.1:8000";
const FPS = 24;

const apiBaseInput = document.getElementById("apiBaseUrl");
const videoInput = document.getElementById("videoFile");
const videoPlayer = document.getElementById("videoPlayer");
const timelineContainer = document.getElementById("timelineContainer");
const timeline = document.getElementById("timeline");
const frameTicks = document.getElementById("frameTicks");
const markersContainer = document.getElementById("markers");
const playhead = document.getElementById("playhead");
const currentFrameDisplay = document.getElementById("currentFrameDisplay");
const totalFramesDisplay = document.getElementById("totalFramesDisplay");
const fpsDisplay = document.getElementById("fpsDisplay");
const sequenceStartTimecodeInput = document.getElementById("sequenceStartTimecodeInput");
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
const exportControls = document.getElementById("exportControls");
const exportPdfButton = document.getElementById("exportPdfButton");
const exportCsvButton = document.getElementById("exportCsvButton");
const exportXlsButton = document.getElementById("exportXlsButton");
const exportXlsxButton = document.getElementById("exportXlsxButton");
const userEmailEl = document.getElementById("userEmail");
const logoutButton = document.getElementById("logoutButton");
const saveProjectButton = document.getElementById("saveProjectButton");
const loadProjectButton = document.getElementById("loadProjectButton");
const projectModal = document.getElementById("projectModal");
const projectList = document.getElementById("projectList");
const closeProjectModal = document.getElementById("closeProjectModal");

const ZOOM_MIN = 1;
const ZOOM_MAX = 20;
const baseWidth = 1000;
const FRAME_THUMB_WIDTH = 192;
const FRAME_THUMB_HEIGHT = 108;
const KEY_SCRUB_HOLD_DELAY_MS = 500;

let markers = [];
let sceneRows = [];
let currentVideoUrl = null;
let selectedMarkerIndex = null;
let isDirty = false;
let zoomLevel = 1;
let selectedMarkerLockedToPlayhead = false;
let history = [];
let historyIndex = -1;
let savedMarkersSnapshot = "[]";
let detectedVideoFps = FPS;
let fpsProbeActive = false;
let fpsProbeRequestId = null;
let sequenceStartTimecode = "00:00:00:00";
const frameImageCache = new Map();
let timelineScrubState = null;
let keyScrubAnimationFrame = null;
const keyScrubDirections = new Set();
const keyScrubHoldTimeouts = new Map();

const storedApiBase = localStorage.getItem("animaticApiBase");
apiBaseInput.value = storedApiBase || DEFAULT_API_BASE;

apiBaseInput.addEventListener("change", () => {
  localStorage.setItem("animaticApiBase", apiBaseInput.value.trim());
});

sequenceStartTimecodeInput.value = sequenceStartTimecode;

sequenceStartTimecodeInput.addEventListener("input", () => {
  sequenceStartTimecode = sequenceStartTimecodeInput.value.trim();
  updateTable();
});

sequenceStartTimecodeInput.addEventListener("blur", () => {
  const normalizedValue = normalizeTimecodeInputValue(sequenceStartTimecodeInput.value);
  if (normalizedValue === null) {
    sequenceStartTimecode = "00:00:00:00";
    sequenceStartTimecodeInput.value = sequenceStartTimecode;
    setStatus("Timecode inválido. Valor redefinido para 00:00:00:00.", "info");
  } else {
    sequenceStartTimecode = normalizedValue;
    sequenceStartTimecodeInput.value = normalizedValue;
  }
  updateTable();
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

function formatFps(fpsValue) {
  if (!Number.isFinite(fpsValue) || fpsValue <= 0) {
    return FPS.toFixed(2);
  }

  return fpsValue.toFixed(2);
}

function updateFrameDisplays() {
  const currentFrame = Math.max(0, timeToFrame(videoPlayer.currentTime));
  const lastFrame = getVideoLastFrame();
  const hasFrames = lastFrame >= 0;
  const displayedCurrentFrame = hasFrames ? Math.min(currentFrame, lastFrame) + 1 : 0;
  const displayedTotalFrames = hasFrames ? lastFrame + 1 : 0;

  currentFrameDisplay.textContent = String(displayedCurrentFrame);
  totalFramesDisplay.textContent = String(displayedTotalFrames);
  fpsDisplay.textContent = formatFps(detectedVideoFps);
}

function enforceFirstMarkerStartFrame() {
  if (!markers.length) {
    return;
  }

  markers[0].frame = 0;
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
  enforceFirstMarkerStartFrame();
}

function setDirtyState(dirty) {
  isDirty = dirty;
  saveChangesButton.disabled = !dirty;
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

function updateVideoFrameFromPointer(clientX, rect) {
  if (!videoPlayer.duration || !Number.isFinite(videoPlayer.duration)) {
    return;
  }

  const timelineWidth = rect.width;
  if (!timelineWidth) {
    return;
  }

  const x = clientX - rect.left;
  const safeX = Math.min(Math.max(x, 0), timelineWidth);
  const totalFrames = Math.max(1, getVideoLastFrame());
  const frame = Math.round((safeX / timelineWidth) * totalFrames);
  setVideoTimeByFrame(frame);
}

function stopTimelineScrub() {
  if (!timelineScrubState) {
    return;
  }

  if (timelineScrubState.pointerId !== null) {
    timeline.releasePointerCapture(timelineScrubState.pointerId);
  }
  timelineScrubState = null;
}

function startTimelineScrub(event) {
  if (!videoPlayer.duration || !Number.isFinite(videoPlayer.duration)) {
    return;
  }

  timelineScrubState = {
    pointerId: event.pointerId ?? null,
  };

  if (timelineScrubState.pointerId !== null) {
    timeline.setPointerCapture(timelineScrubState.pointerId);
  }

  updateVideoFrameFromPointer(event.clientX, timeline.getBoundingClientRect());
}

function animateKeyScrub() {
  if (!keyScrubDirections.size) {
    keyScrubAnimationFrame = null;
    return;
  }

  if (videoPlayer.duration && Number.isFinite(videoPlayer.duration)) {
    let stepDirection = 0;
    if (keyScrubDirections.has("ArrowRight")) {
      stepDirection += 1;
    }
    if (keyScrubDirections.has("ArrowLeft")) {
      stepDirection -= 1;
    }

    if (stepDirection !== 0) {
      const frame = timeToFrame(videoPlayer.currentTime);
      setVideoTimeByFrame(frame + stepDirection);
    }
  }

  keyScrubAnimationFrame = requestAnimationFrame(animateKeyScrub);
}

function startKeyScrub(key) {
  keyScrubDirections.add(key);
  if (keyScrubAnimationFrame === null) {
    keyScrubAnimationFrame = requestAnimationFrame(animateKeyScrub);
  }
}

function stopKeyScrub(key) {
  const holdTimeout = keyScrubHoldTimeouts.get(key);
  if (holdTimeout !== undefined) {
    clearTimeout(holdTimeout);
    keyScrubHoldTimeouts.delete(key);
  }

  keyScrubDirections.delete(key);
  if (!keyScrubDirections.size && keyScrubAnimationFrame !== null) {
    cancelAnimationFrame(keyScrubAnimationFrame);
    keyScrubAnimationFrame = null;
  }
}

function nudgeByArrowKey(key) {
  if (!videoPlayer.duration || !Number.isFinite(videoPlayer.duration)) {
    return;
  }

  const frame = timeToFrame(videoPlayer.currentTime);
  const direction = key === "ArrowRight" ? 1 : -1;
  setVideoTimeByFrame(frame + direction);
}

function beginArrowKeyHold(key) {
  if (keyScrubHoldTimeouts.has(key)) {
    return;
  }

  nudgeByArrowKey(key);
  const timeoutId = setTimeout(() => {
    keyScrubHoldTimeouts.delete(key);
    startKeyScrub(key);
  }, KEY_SCRUB_HOLD_DELAY_MS);
  keyScrubHoldTimeouts.set(key, timeoutId);
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

function resetHistoryWithCurrentState() {
  history = [];
  historyIndex = -1;
  pushHistorySnapshot();
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

function resetVideoSource() {
  if (currentVideoUrl) {
    URL.revokeObjectURL(currentVideoUrl);
    currentVideoUrl = null;
  }
  videoPlayer.removeAttribute("src");
  videoPlayer.load();
  detectedVideoFps = FPS;
  fpsProbeActive = false;
  if (fpsProbeRequestId !== null && typeof videoPlayer.cancelVideoFrameCallback === "function") {
    videoPlayer.cancelVideoFrameCallback(fpsProbeRequestId);
  }
  fpsProbeRequestId = null;
  playhead.style.left = "0px";
  frameImageCache.clear();
  updateFrameDisplays();
}

function probeVideoFps() {
  if (fpsProbeActive || typeof videoPlayer.requestVideoFrameCallback !== "function") {
    return;
  }

  fpsProbeActive = true;
  let firstMetadata = null;
  let lastMetadata = null;

  const onFrame = (_, metadata) => {
    if (!firstMetadata) {
      firstMetadata = metadata;
      lastMetadata = metadata;
    } else {
      lastMetadata = metadata;
    }

    const frameDelta = lastMetadata.presentedFrames - firstMetadata.presentedFrames;
    const timeDelta = lastMetadata.mediaTime - firstMetadata.mediaTime;

    if (frameDelta >= 12 && timeDelta > 0) {
      detectedVideoFps = frameDelta / timeDelta;
      fpsProbeActive = false;
      fpsProbeRequestId = null;
      updateFrameDisplays();
      return;
    }

    fpsProbeRequestId = videoPlayer.requestVideoFrameCallback(onFrame);
  };

  fpsProbeRequestId = videoPlayer.requestVideoFrameCallback(onFrame);
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
  sceneRows = [];

  if (!videoPlayer.duration || !Number.isFinite(videoPlayer.duration) || markers.length < 1) {
    resultsTable.hidden = true;
    exportControls.hidden = true;
    return;
  }

  const lastVideoFrame = getVideoLastFrame();
  const sequenceStartOffset = getSequenceStartTimecodeFrameOffset();

  for (let i = 0; i < markers.length; i += 1) {
    const start = markers[i].frame;
    const nextStart = i < markers.length - 1 ? markers[i + 1].frame : lastVideoFrame + 1;
    const end = Math.min(lastVideoFrame, nextStart - 1);
    const duration = Math.max(0, end - start + 1);
    const displayedStartFrame = start + 1;
    const displayedEndFrame = end + 1;
    const sceneData = {
      scene: i + 1,
      startFrame: displayedStartFrame,
      endFrame: displayedEndFrame,
      sourceStartFrame: start,
      sourceEndFrame: end,
      durationFrames: duration,
      startTimecode: formatFrameAsTimecode(sequenceStartOffset + start),
      endTimecode: formatFrameAsTimecode(sequenceStartOffset + end),
      durationTimecode: formatFrameAsTimecode(duration),
    };
    sceneRows.push(sceneData);

    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${sceneData.scene}</td>
      <td>${sceneData.startFrame}</td>
      <td>${sceneData.endFrame}</td>
      <td>${sceneData.startFrame}</td>
      <td>${sceneData.endFrame}</td>
      <td>${sceneData.durationFrames}</td>
      <td>${sceneData.startTimecode}</td>
      <td>${sceneData.endTimecode}</td>
      <td>${sceneData.durationTimecode}</td>
    `;
    tableBody.appendChild(row);
  }

  resultsTable.hidden = false;
  exportControls.hidden = false;
}

function formatFrameAsTimecode(frameValue) {
  const safeFrame = Math.max(0, Math.round(Number(frameValue) || 0));
  const timecodeFps = Math.max(1, Math.round(detectedVideoFps || FPS));
  const totalSeconds = Math.floor(safeFrame / timecodeFps);
  const framesRemainder = safeFrame % timecodeFps;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [hours, minutes, seconds, framesRemainder]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

function parseTimecodeToFrame(timecodeValue) {
  const normalizedValue = String(timecodeValue || "").trim();
  const match = normalizedValue.match(/^(\d+):([0-5]\d):([0-5]\d):(\d{2})$/);
  if (!match) {
    return null;
  }

  const [, hoursText, minutesText, secondsText, framesText] = match;
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);
  const frames = Number(framesText);
  const timecodeFps = Math.max(1, Math.round(detectedVideoFps || FPS));

  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    !Number.isInteger(seconds) ||
    !Number.isInteger(frames) ||
    frames >= timecodeFps
  ) {
    return null;
  }

  return ((hours * 3600 + minutes * 60 + seconds) * timecodeFps) + frames;
}

function getSequenceStartTimecodeFrameOffset() {
  const parsedFrame = parseTimecodeToFrame(sequenceStartTimecode);
  return parsedFrame === null ? 0 : parsedFrame;
}

function normalizeTimecodeInputValue(rawValue) {
  const parsedFrame = parseTimecodeToFrame(rawValue);
  if (parsedFrame === null) {
    return null;
  }
  return formatFrameAsTimecode(parsedFrame);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function getRenderedTableRows() {
  const headers = [
    "Scene #",
    "Start Frame",
    "End Frame",
    "Start Frame Image",
    "End Frame Image",
    "Duration (Frames)",
    "Start Timecode",
    "End Timecode",
    "Duration Timecode",
  ];
  const rows = [headers];

  sceneRows.forEach((sceneData) => {
    rows.push([
      String(sceneData.scene),
      String(sceneData.startFrame),
      String(sceneData.endFrame),
      String(sceneData.startFrame),
      String(sceneData.endFrame),
      String(sceneData.durationFrames),
      sceneData.startTimecode,
      sceneData.endTimecode,
      sceneData.durationTimecode,
    ]);
  });

  return rows;
}

function exportWorkbook(workbook, fileName, bookType) {
  if (!workbook) {
    return;
  }

  window.XLSX.writeFile(workbook, fileName, {
    bookType,
    compression: true,
  });
}

function exportVisibleTableToCsv() {
  const rows = [["Scene #", "Start Frame", "End Frame", "Duration (Frames)", "Start Timecode", "End Timecode", "Duration Timecode"]];
  sceneRows.forEach((sceneData) => {
    rows.push([
      String(sceneData.scene),
      String(sceneData.startFrame),
      String(sceneData.endFrame),
      String(sceneData.durationFrames),
      sceneData.startTimecode,
      sceneData.endTimecode,
      sceneData.durationTimecode,
    ]);
  });

  if (rows.length <= 1) {
    setStatus("There is no table data to export.", "info");
    return;
  }

  if (!window.XLSX) {
    setStatus("Spreadsheet exporter could not be loaded. Please refresh and try again.", "error");
    return;
  }

  const worksheet = window.XLSX.utils.aoa_to_sheet(rows);
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, worksheet, "Detected Scenes");
  exportWorkbook(workbook, "detected-scenes.csv", "csv");
}

function seekVideoForCapture(targetTime) {
  const safeTargetTime = Math.max(0, Math.min(targetTime, videoPlayer.duration || 0));

  return new Promise((resolve) => {
    if (Math.abs(videoPlayer.currentTime - safeTargetTime) < 0.0005) {
      requestAnimationFrame(() => resolve());
      return;
    }

    const onSeeked = () => {
      videoPlayer.removeEventListener("seeked", onSeeked);
      resolve();
    };

    videoPlayer.addEventListener("seeked", onSeeked, { once: true });
    videoPlayer.currentTime = safeTargetTime;
  });
}

async function captureFrameImageAtFrame(frame) {
  const cacheKey = String(frame);
  if (frameImageCache.has(cacheKey)) {
    return frameImageCache.get(cacheKey);
  }

  if (!videoPlayer.videoWidth || !videoPlayer.videoHeight) {
    return "";
  }

  await seekVideoForCapture(frameToTime(frame));

  const canvas = document.createElement("canvas");
  canvas.width = FRAME_THUMB_WIDTH;
  canvas.height = FRAME_THUMB_HEIGHT;

  const context = canvas.getContext("2d");
  if (!context) {
    return "";
  }

  context.drawImage(videoPlayer, 0, 0, FRAME_THUMB_WIDTH, FRAME_THUMB_HEIGHT);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
  frameImageCache.set(cacheKey, dataUrl);
  return dataUrl;
}

async function withVideoStateRestored(callback) {
  const startTime = videoPlayer.currentTime;
  const wasPaused = videoPlayer.paused;
  videoPlayer.pause();

  try {
    return await callback();
  } finally {
    await seekVideoForCapture(startTime);
    if (!wasPaused) {
      videoPlayer.play().catch(() => {});
    }
  }
}

async function collectSceneFrameImages() {
  if (!sceneRows.length) {
    return [];
  }

  return withVideoStateRestored(async () => {
    const rowsWithImages = [];
    for (const sceneData of sceneRows) {
      const startImage = await captureFrameImageAtFrame(sceneData.sourceStartFrame);
      const endImage = await captureFrameImageAtFrame(sceneData.sourceEndFrame);
      rowsWithImages.push({
        ...sceneData,
        startImage,
        endImage,
      });
    }
    return rowsWithImages;
  });
}

async function exportVisibleTableToXlsx() {
  if (!sceneRows.length) {
    setStatus("There is no table data to export.", "info");
    return;
  }

  if (!window.ExcelJS) {
    setStatus("XLSX exporter could not be loaded. Please refresh and try again.", "error");
    return;
  }

  setStatus("Generating XLSX with frame thumbnails...");

  const rowsWithImages = await collectSceneFrameImages();
  const workbook = new window.ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Detected Scenes");

  worksheet.columns = [
    { header: "Scene #", key: "scene", width: 10 },
    { header: "Start Frame", key: "startFrame", width: 12 },
    { header: "End Frame", key: "endFrame", width: 12 },
    { header: "Start Frame Image", key: "startImage", width: 30 },
    { header: "End Frame Image", key: "endImage", width: 30 },
    { header: "Duration (Frames)", key: "durationFrames", width: 18 },
    { header: "Start Timecode", key: "startTimecode", width: 16 },
    { header: "End Timecode", key: "endTimecode", width: 16 },
    { header: "Duration Timecode", key: "durationTimecode", width: 18 },
  ];

  rowsWithImages.forEach((sceneData, index) => {
    const rowNumber = index + 2;
    worksheet.addRow({
      scene: sceneData.scene,
      startFrame: sceneData.startFrame,
      endFrame: sceneData.endFrame,
      durationFrames: sceneData.durationFrames,
      startTimecode: sceneData.startTimecode,
      endTimecode: sceneData.endTimecode,
      durationTimecode: sceneData.durationTimecode,
    });
    worksheet.getRow(rowNumber).height = 82;

    if (sceneData.startImage) {
      const startImageId = workbook.addImage({
        base64: sceneData.startImage,
        extension: "jpeg",
      });
      worksheet.addImage(startImageId, {
        tl: { col: 3, row: rowNumber - 1 },
        ext: { width: FRAME_THUMB_WIDTH, height: FRAME_THUMB_HEIGHT },
      });
    }

    if (sceneData.endImage) {
      const endImageId = workbook.addImage({
        base64: sceneData.endImage,
        extension: "jpeg",
      });
      worksheet.addImage(endImageId, {
        tl: { col: 4, row: rowNumber - 1 },
        ext: { width: FRAME_THUMB_WIDTH, height: FRAME_THUMB_HEIGHT },
      });
    }
  });

  const xlsxBuffer = await workbook.xlsx.writeBuffer();
  downloadBlob(
    new Blob([xlsxBuffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    "detected-scenes.xlsx",
  );

  setStatus("XLSX exported with embedded frame thumbnails.", "success");
}

async function exportVisibleTableToXls() {
  if (!sceneRows.length) {
    setStatus("There is no table data to export.", "info");
    return;
  }

  setStatus("Generating XLS with frame thumbnails...");
  const rowsWithImages = await collectSceneFrameImages();

  const htmlRows = rowsWithImages
    .map(
      (sceneData) => `
        <tr>
          <td>${sceneData.scene}</td>
          <td>${sceneData.startFrame}</td>
          <td>${sceneData.endFrame}</td>
          <td><img width="${FRAME_THUMB_WIDTH}" height="${FRAME_THUMB_HEIGHT}" src="${sceneData.startImage}" /></td>
          <td><img width="${FRAME_THUMB_WIDTH}" height="${FRAME_THUMB_HEIGHT}" src="${sceneData.endImage}" /></td>
          <td>${sceneData.durationFrames}</td>
          <td>${sceneData.startTimecode}</td>
          <td>${sceneData.endTimecode}</td>
          <td>${sceneData.durationTimecode}</td>
        </tr>`,
    )
    .join("");

  const workbookHtml = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:x="urn:schemas-microsoft-com:office:excel"
      xmlns="http://www.w3.org/TR/REC-html40">
      <head>
        <meta charset="UTF-8">
        <!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Detected Scenes</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
        <style>
          table, th, td { border: 1px solid #333; border-collapse: collapse; }
          th, td { padding: 4px; vertical-align: top; }
          img { display: block; width: ${FRAME_THUMB_WIDTH}px; height: ${FRAME_THUMB_HEIGHT}px; }
        </style>
      </head>
      <body>
        <table>
          <thead>
            <tr>
              <th>Scene #</th>
              <th>Start Frame</th>
              <th>End Frame</th>
              <th>Start Frame Image</th>
              <th>End Frame Image</th>
              <th>Duration (Frames)</th>
              <th>Start Timecode</th>
              <th>End Timecode</th>
              <th>Duration Timecode</th>
            </tr>
          </thead>
          <tbody>${htmlRows}</tbody>
        </table>
      </body>
    </html>
  `;

  downloadBlob(new Blob([workbookHtml], { type: "application/vnd.ms-excel;charset=utf-8;" }), "detected-scenes.xls");
  setStatus("XLS exported with embedded frame thumbnails.", "success");
}

function escapePdfText(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function exportVisibleTableToPdf() {
  const rows = getRenderedTableRows();
  if (rows.length <= 1) {
    setStatus("There is no table data to export.", "info");
    return;
  }

  const lines = rows.map((row) => row.join(" | "));
  const maxLinesPerPage = 50;
  const chunks = [];

  for (let index = 0; index < lines.length; index += maxLinesPerPage) {
    chunks.push(lines.slice(index, index + maxLinesPerPage));
  }

  const pdfParts = [];
  const objectOffsets = [];
  const writeObject = (id, content) => {
    objectOffsets[id] = pdfParts.join("").length;
    pdfParts.push(`${id} 0 obj\n${content}\nendobj\n`);
  };

  pdfParts.push("%PDF-1.4\n");

  const pageObjectIds = [];
  const firstPageObjectId = 3;
  const objectsPerPage = 2;

  chunks.forEach((_, pageIndex) => {
    const pageId = firstPageObjectId + pageIndex * objectsPerPage;
    pageObjectIds.push(pageId);
  });

  writeObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
  writeObject(
    2,
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${
      pageObjectIds.length
    } >>`,
  );

  chunks.forEach((pageLines, pageIndex) => {
    const pageId = pageObjectIds[pageIndex];
    const contentId = pageId + 1;
    const textCommands = pageLines
      .map((line, index) => {
        const y = 800 - index * 14;
        return `BT /F1 10 Tf 40 ${y} Td (${escapePdfText(line)}) Tj ET`;
      })
      .join("\n");
    const stream = `${textCommands}\n`;

    writeObject(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${
        pageObjectIds[pageObjectIds.length - 1] + 2
      } 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    writeObject(contentId, `<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
  });

  const fontObjectId = pageObjectIds[pageObjectIds.length - 1] + 2;
  writeObject(fontObjectId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  const xrefOffset = pdfParts.join("").length;
  const totalObjects = fontObjectId;
  let xref = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= totalObjects; id += 1) {
    const offset = objectOffsets[id] || 0;
    xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }

  pdfParts.push(xref);
  pdfParts.push(`trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\n`);
  pdfParts.push(`startxref\n${xrefOffset}\n%%EOF`);

  downloadBlob(new Blob([pdfParts.join("")], { type: "application/pdf" }), "detected-scenes.pdf");
}

async function parseResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text || "Unexpected server response." };
  }
}


function getAuthToken() {
  return localStorage.getItem("token") || "";
}

async function authorizedFetch(path, options = {}) {
  const token = getAuthToken();
  if (!token) {
    throw new Error("You must login first.");
  }

  const apiBaseUrl = apiBaseInput.value.trim().replace(/\/$/, "");
  const headers = {
    ...(options.headers || {}),
    Authorization: `Bearer ${token}`,
  };

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers,
  });

  const payload = await parseResponse(response);
  if (!response.ok) {
    throw new Error(payload.detail || "Request failed.");
  }
  return payload;
}

async function refreshCurrentUser() {
  if (!userEmailEl) {
    return;
  }

  const token = getAuthToken();
  if (!token) {
    userEmailEl.textContent = "Not logged in";
    return;
  }

  try {
    const me = await authorizedFetch("/me");
    userEmailEl.textContent = me.email || "Logged in";
  } catch {
    userEmailEl.textContent = "Session expired";
    localStorage.removeItem("token");
  }
}

async function saveProject() {
  const projectName = window.prompt("Project name:");
  if (!projectName) {
    return;
  }

  const file = videoInput.files[0];
  const payload = {
    name: projectName.trim(),
    video_name: file ? file.name : "(re-upload required)",
    markers,
    duration: Number(videoPlayer.duration) || 0,
  };

  saveProjectButton.disabled = true;
  setStatus("Saving project...");
  try {
    await authorizedFetch("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setStatus("Project saved.", "success");
  } catch (error) {
    setStatus(`Save failed: ${error.message}`, "error");
    alert(error.message);
  } finally {
    saveProjectButton.disabled = false;
  }
}

function closeModal() {
  if (projectModal) {
    projectModal.hidden = true;
  }
}

async function openLoadProjectsModal() {
  if (!projectModal || !projectList) {
    return;
  }

  projectModal.hidden = false;
  projectList.innerHTML = "<div>Loading projects...</div>";

  try {
    const projects = await authorizedFetch("/projects");
    if (!projects.length) {
      projectList.innerHTML = "<div>No projects found.</div>";
      return;
    }

    projectList.innerHTML = "";
    projects.forEach((project) => {
      const item = document.createElement("div");
      item.className = "project-item";
      const meta = document.createElement("div");
      meta.innerHTML = `<strong>${project.name}</strong><br><small>${project.video_name}</small>`;
      const loadBtn = document.createElement("button");
      loadBtn.type = "button";
      loadBtn.textContent = "Load";
      loadBtn.onclick = async () => {
        try {
          const detail = await authorizedFetch(`/projects/${project.id}`);
          markers = Array.isArray(detail.markers) ? detail.markers : [];
          normalizeMarkers();
          selectedMarkerIndex = null;
          selectedMarkerLockedToPlayhead = false;
          renderMarkers();
          applyChanges();
          resetHistoryWithCurrentState();
          updateTable();
          closeModal();
          setStatus(`Project loaded: ${detail.name}. Re-upload video: ${detail.video_name}`, "success");
          alert(`Project loaded. Please re-upload video file: ${detail.video_name}`);
        } catch (error) {
          setStatus(`Load failed: ${error.message}`, "error");
        }
      };

      item.appendChild(meta);
      item.appendChild(loadBtn);
      projectList.appendChild(item);
    });
  } catch (error) {
    projectList.innerHTML = `<div>Error: ${error.message}</div>`;
  }
}

videoInput.addEventListener("change", () => {
  const file = videoInput.files[0];

  if (!file) {
    resetVideoSource();
    markers = [];
    selectedMarkerIndex = null;
    renderMarkers();
    applyChanges();
    resetHistoryWithCurrentState();
    return;
  }

  resetVideoSource();
  currentVideoUrl = URL.createObjectURL(file);
  videoPlayer.src = currentVideoUrl;
  videoPlayer.load();

  markers = [];
  frameImageCache.clear();
  selectedMarkerIndex = null;
  renderMarkers();
  applyChanges();
  resetHistoryWithCurrentState();
});

videoPlayer.addEventListener("loadedmetadata", () => {
  detectedVideoFps = FPS;
  fpsProbeActive = false;
  fpsProbeRequestId = null;
  updateTimeline();
  renderMarkers();
  updatePlayhead();
});

videoPlayer.addEventListener("play", () => {
  probeVideoFps();
});

videoPlayer.addEventListener("timeupdate", () => {
  updatePlayhead();
});

timeline.addEventListener("pointerdown", (event) => {
  if (event.target.closest(".marker")) {
    return;
  }

  event.preventDefault();

  selectedMarkerIndex = null;
  selectedMarkerLockedToPlayhead = false;
  renderMarkers();
  startTimelineScrub(event);
});

timeline.addEventListener("pointermove", (event) => {
  if (!timelineScrubState) {
    return;
  }

  updateVideoFrameFromPointer(event.clientX, timeline.getBoundingClientRect());
});

timeline.addEventListener("pointerup", () => {
  stopTimelineScrub();
});

timeline.addEventListener("pointercancel", () => {
  stopTimelineScrub();
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
  if (!event.target.closest("#timelineContainer")) {
    return;
  }

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

function centerPlayheadInTimeline() {
  if (!videoPlayer.duration || !Number.isFinite(videoPlayer.duration)) {
    return;
  }

  const playheadPosition = parseFloat(playhead.style.left) || 0;
  const targetScroll = playheadPosition - timelineContainer.clientWidth / 2;
  const maxScroll = Math.max(0, timeline.scrollWidth - timelineContainer.clientWidth);
  timelineContainer.scrollLeft = Math.max(0, Math.min(targetScroll, maxScroll));
}

function adjustTimelineZoom(direction) {
  const nextZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomLevel + direction));
  if (nextZoom === zoomLevel) {
    return;
  }

  zoomLevel = nextZoom;
  updateTimeline();
  centerPlayheadInTimeline();
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
    enforceFirstMarkerStartFrame();

    selectedMarkerIndex = null;
    selectedMarkerLockedToPlayhead = false;
    renderMarkers();
    applyChanges();
    resetHistoryWithCurrentState();

    setStatus(`Analysis complete. Detected ${scenes.length} scenes.`, "success");
  } catch (error) {
    setStatus(`Analysis failed: ${error.message}`, "error");
    markers = [];
    selectedMarkerIndex = null;
    selectedMarkerLockedToPlayhead = false;
    renderMarkers();
    applyChanges();
    resetHistoryWithCurrentState();
  } finally {
    analyzeButton.disabled = false;
  }
}

zoomInButton.onclick = () => {
  adjustTimelineZoom(1);
};

zoomOutButton.onclick = () => {
  adjustTimelineZoom(-1);
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

exportPdfButton.onclick = () => {
  exportVisibleTableToPdf();
};

exportCsvButton.onclick = () => {
  exportVisibleTableToCsv();
};

exportXlsButton.onclick = () => {
  exportVisibleTableToXls().catch((error) => {
    setStatus(`XLS export failed: ${error.message}`, "error");
  });
};

exportXlsxButton.onclick = () => {
  exportVisibleTableToXlsx().catch((error) => {
    setStatus(`XLSX export failed: ${error.message}`, "error");
  });
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

  if (event.ctrlKey && (event.key === "z" || event.key === "Z")) {
    event.preventDefault();
    if (event.shiftKey) {
      restoreHistorySnapshot(historyIndex + 1);
      return;
    }

    restoreHistorySnapshot(historyIndex - 1);
    return;
  }

  if (!event.ctrlKey && !event.metaKey) {
    if (event.key === "a" || event.key === "A") {
      event.preventDefault();
      addMarkerButton.onclick();
      return;
    }

    if (event.key === "d" || event.key === "D") {
      event.preventDefault();
      deleteMarkerButton.onclick();
      return;
    }
  }

  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    if (event.repeat) {
      return;
    }
    beginArrowKeyHold(event.key);
  }
});

document.addEventListener("keyup", (event) => {
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    stopKeyScrub(event.key);
  }
});

window.addEventListener("blur", () => {
  stopKeyScrub("ArrowLeft");
  stopKeyScrub("ArrowRight");
  stopTimelineScrub();
});

timelineContainer.addEventListener("wheel", (event) => {
  if (!event.altKey) {
    return;
  }

  event.preventDefault();
  const zoomDirection = event.deltaY < 0 ? 1 : -1;
  adjustTimelineZoom(zoomDirection);
}, { passive: false });

analyzeButton.addEventListener("click", analyzeAnimatic);
updateTimeline();
updateFrameDisplays();
resetHistoryWithCurrentState();


if (logoutButton) {
  logoutButton.addEventListener("click", () => {
    localStorage.removeItem("token");
    window.location.href = "login.html";
  });
}

if (saveProjectButton) {
  saveProjectButton.addEventListener("click", () => {
    saveProject().catch((error) => setStatus(`Save failed: ${error.message}`, "error"));
  });
}

if (loadProjectButton) {
  loadProjectButton.addEventListener("click", () => {
    openLoadProjectsModal().catch((error) => setStatus(`Load failed: ${error.message}`, "error"));
  });
}

if (closeProjectModal) {
  closeProjectModal.addEventListener("click", closeModal);
}

if (projectModal) {
  projectModal.addEventListener("click", (event) => {
    if (event.target === projectModal) {
      closeModal();
    }
  });
}

refreshCurrentUser();
