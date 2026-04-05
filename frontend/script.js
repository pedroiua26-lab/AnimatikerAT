const DEFAULT_API_BASE = window.ANIMATIC_API_BASE || "http://127.0.0.1:8000";

const apiBaseInput = document.getElementById("apiBaseUrl");
const videoInput = document.getElementById("videoFile");
const videoPreview = document.getElementById("videoPreview");
const videoThumbnail = document.getElementById("videoThumbnail");
const analyzeButton = document.getElementById("analyzeButton");
const statusEl = document.getElementById("status");
const resultsTable = document.getElementById("resultsTable");
const tableBody = resultsTable.querySelector("tbody");

const storedApiBase = localStorage.getItem("animaticApiBase");
apiBaseInput.value = storedApiBase || DEFAULT_API_BASE;

apiBaseInput.addEventListener("change", () => {
  localStorage.setItem("animaticApiBase", apiBaseInput.value.trim());
});

function setStatus(message, type = "info") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

function renderScenes(scenes) {
  tableBody.innerHTML = "";

  scenes.forEach((sceneData) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${sceneData.scene}</td>
      <td>${sceneData.start_frame}</td>
      <td>${sceneData.end_frame}</td>
      <td>${sceneData.duration_frames}</td>
    `;
    tableBody.appendChild(row);
  });

  resultsTable.hidden = scenes.length === 0;
}

async function parseResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text || "Unexpected server response." };
  }
}

function resetThumbnail() {
  videoThumbnail.removeAttribute("src");
  videoPreview.hidden = true;
}

function generateVideoThumbnail(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;

    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
      video.removeAttribute("src");
      video.load();
    };

    video.onloadeddata = () => {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/png");
      cleanup();
      resolve(dataUrl);
    };

    video.onerror = () => {
      cleanup();
      reject(new Error("Could not read video preview."));
    };

    video.src = objectUrl;
  });
}

videoInput.addEventListener("change", async () => {
  const file = videoInput.files[0];

  if (!file) {
    resetThumbnail();
    return;
  }

  try {
    const thumbnailDataUrl = await generateVideoThumbnail(file);
    videoThumbnail.src = thumbnailDataUrl;
    videoPreview.hidden = false;
  } catch {
    resetThumbnail();
    setStatus("Video selected, but preview thumbnail could not be generated.", "info");
  }
});

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
    renderScenes(scenes);
    setStatus(`Analysis complete. Detected ${scenes.length} scenes.`, "success");
  } catch (error) {
    setStatus(`Analysis failed: ${error.message}`, "error");
    resultsTable.hidden = true;
  } finally {
    analyzeButton.disabled = false;
  }
}

analyzeButton.addEventListener("click", analyzeAnimatic);
