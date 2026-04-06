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
let detectedVideoFps = FPS;
let fpsProbeActive = false;
let fpsProbeRequestId = null;

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

function formatFps(fpsValue) {
  if (!Number.isFinite(fpsValue) || fpsValue <= 0) {
    return FPS.toFixed(2);
  }

  return fpsValue.toFixed(2);
}

function updateFrameDisplays() {
  const currentFrame = Math.max(0, timeToFrame(videoPlayer.currentTime));
  const lastFrame = getVideoLastFrame();

  currentFrameDisplay.textContent = String(Math.min(currentFrame, lastFrame));
  totalFramesDisplay.textContent = String(lastFrame + 1);
  fpsDisplay.textContent = formatFps(detectedVideoFps);
}

function enforceFirstMarkerStartFrame() {
  if (!markers.length) {
    return;
  }

  const lastFrame = getVideoLastFrame();
  if (lastFrame >= 1) {
    markers[0].frame = Math.max(1, Math.min(markers[0].frame, lastFrame));
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

  if (!videoPlayer.duration || !Number.isFinite(videoPlayer.duration) || markers.length < 1) {
    resultsTable.hidden = true;
    exportControls.hidden = true;
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
      <td>${formatFrameAsTimecode(start)}</td>
      <td>${formatFrameAsTimecode(end)}</td>
      <td>${formatFrameAsTimecode(duration)}</td>
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
  const rows = [];
  const headers = Array.from(resultsTable.querySelectorAll("thead th")).map((header) =>
    header.textContent.trim(),
  );

  if (headers.length) {
    rows.push(headers);
  }

  Array.from(tableBody.querySelectorAll("tr")).forEach((row) => {
    const values = Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent.trim());
    rows.push(values);
  });

  return rows;
}

function buildWorkbookFromVisibleTable() {
  const rows = getRenderedTableRows();
  if (rows.length <= 1) {
    setStatus("There is no table data to export.", "info");
    return null;
  }

  if (!window.XLSX) {
    setStatus("Spreadsheet exporter could not be loaded. Please refresh and try again.", "error");
    return null;
  }

  const worksheet = window.XLSX.utils.aoa_to_sheet(rows);
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, worksheet, "Detected Scenes");
  return workbook;
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
  const workbook = buildWorkbookFromVisibleTable();
  exportWorkbook(workbook, "detected-scenes.csv", "csv");
}

function exportVisibleTableToXls() {
  const workbook = buildWorkbookFromVisibleTable();
  exportWorkbook(workbook, "detected-scenes.xls", "xls");
}

function exportVisibleTableToXlsx() {
  const workbook = buildWorkbookFromVisibleTable();
  exportWorkbook(workbook, "detected-scenes.xlsx", "xlsx");
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
  zoomLevel = Math.min(ZOOM_MAX, zoomLevel + 1);
  updateTimeline();
  centerPlayheadInTimeline();
};

zoomOutButton.onclick = () => {
  zoomLevel = Math.max(ZOOM_MIN, zoomLevel - 1);
  updateTimeline();
  centerPlayheadInTimeline();
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
  exportVisibleTableToXls();
};

exportXlsxButton.onclick = () => {
  exportVisibleTableToXlsx();
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
resetHistoryWithCurrentState();
