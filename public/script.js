const cameraInput = document.getElementById("cameraInput");
const galleryInput = document.getElementById("galleryInput");
const captureButton = document.getElementById("captureButton");
const uploadButton = document.getElementById("uploadButton");
const copyButton = document.getElementById("copyButton");
const clearButton = document.getElementById("clearButton");
const previewGrid = document.getElementById("previewGrid");
const resultText = document.getElementById("resultText");
const detectorState = document.getElementById("detectorState");
const detectorMessage = document.getElementById("detectorMessage");
const defaultButtonLabel = "Scan";
const defaultCopyLabel = "Copy Result";
const COOLDOWN_MS = 3000;
let cooldownTimeoutId = null;
let isCooldownActive = false;
let lastQuotaUntilMs = 0;
captureButton.textContent = defaultButtonLabel;
copyButton.textContent = defaultCopyLabel;
pollDetectorStatus();
setInterval(pollDetectorStatus, 5000);

captureButton.addEventListener("click", () => {
  if (isCooldownActive) return;
  cameraInput.click();
});
uploadButton.addEventListener("click", () => {
  if (isCooldownActive) return;
  galleryInput.click();
});

cameraInput.addEventListener("change", handleImageSelection);
galleryInput.addEventListener("change", handleImageSelection);
copyButton.addEventListener("click", handleCopyResult);
clearButton.addEventListener("click", handleClearResult);

async function handleImageSelection(event) {
  const files = Array.from(event.target.files || []);
  if (files.length === 0) return;
  let cooldownMs = COOLDOWN_MS;

  try {
    const dataUrls = await Promise.all(files.map((file) => processFileToUploadDataUrl(file)));
    renderPreviews(dataUrls);

    setButtonsDisabled(true);
    const previousResult = getCurrentResultLines();
    resultText.textContent = "Identifying...";
    setDetectorStatusUi("scanning", "Scanning in progress...");

    const response = await fetch("/identify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ imagesBase64: dataUrls }),
    });

    const payload = await response.json();

    if (!response.ok) {
      if (response.status === 429 && Number.isFinite(payload.retryAfterSec)) {
        cooldownMs = Math.max(COOLDOWN_MS, payload.retryAfterSec * 1000);
      }
      const base = payload.error || "Identification failed.";
      const extra = payload.details ? ` ${payload.details}` : "";
      throw new Error(`${base}${extra}`);
    }

    const incomingResult = payload.result || "No result returned.";
    const mergedResult = mergeUniqueResultLines(previousResult, incomingResult);
    resultText.textContent = mergedResult || "No result yet.";
  } catch (error) {
    resultText.textContent = `Error: ${error.message}`;
    if (String(error.message || "").toLowerCase().includes("quota")) {
      lastQuotaUntilMs = Date.now() + 60000;
    }
  } finally {
    startCooldown(cooldownMs);
    cameraInput.value = "";
    galleryInput.value = "";
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Unable to read image."));
    reader.readAsDataURL(file);
  });
}

function isHeicFile(file) {
  const type = String(file?.type || "").toLowerCase();
  const name = String(file?.name || "").toLowerCase();
  return type.includes("heic") || type.includes("heif") || name.endsWith(".heic") || name.endsWith(".heif");
}

async function processFileToUploadDataUrl(file) {
  if (!isHeicFile(file)) return fileToDataUrl(file);
  try {
    return await convertImageFileToJpegDataUrl(file);
  } catch (_error) {
    return fileToDataUrl(file);
  }
}

function convertImageFileToJpegDataUrl(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas unavailable");
        ctx.drawImage(img, 0, 0);
        const jpegDataUrl = canvas.toDataURL("image/jpeg", 0.92);
        URL.revokeObjectURL(objectUrl);
        resolve(jpegDataUrl);
      } catch (err) {
        URL.revokeObjectURL(objectUrl);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("HEIC conversion failed"));
    };
    img.src = objectUrl;
  });
}

function setButtonsDisabled(disabled) {
  captureButton.disabled = disabled;
  uploadButton.disabled = disabled;
}

async function handleCopyResult() {
  const text = resultText.textContent ? resultText.textContent.trim() : "";
  if (!text || text === "No result yet." || text === "Identifying...") {
    copyButton.textContent = "Nothing to copy";
    setTimeout(() => {
      copyButton.textContent = defaultCopyLabel;
    }, 1200);
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    copyButton.textContent = "Copied!";
  } catch (_error) {
    copyButton.textContent = "Copy failed";
  }

  setTimeout(() => {
    copyButton.textContent = defaultCopyLabel;
  }, 1200);
}

function startCooldown(durationMs = COOLDOWN_MS) {
  if (cooldownTimeoutId) {
    clearTimeout(cooldownTimeoutId);
    cooldownTimeoutId = null;
  }

  isCooldownActive = true;
  setButtonsDisabled(true);
  captureButton.textContent = "Wait...";

  cooldownTimeoutId = setTimeout(() => {
    cooldownTimeoutId = null;
    isCooldownActive = false;
    setButtonsDisabled(false);
    captureButton.textContent = defaultButtonLabel;
  }, durationMs);
}

function handleClearResult() {
  resultText.textContent = "No result yet.";
}

function getCurrentResultLines() {
  const text = resultText.textContent ? resultText.textContent.trim() : "";
  if (!text || text === "No result yet.") return "";
  if (text.startsWith("Error:")) return "";
  return text;
}

function mergeUniqueResultLines(existingText, incomingText) {
  const combinedLines = `${existingText}\n${incomingText}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const seen = new Set();
  const uniqueLines = [];
  for (const line of combinedLines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueLines.push(line);
  }
  return uniqueLines.join("\n");
}

async function pollDetectorStatus() {
  try {
    const response = await fetch("/detector-status", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    const state = payload?.state || "ready";
    let message = payload?.message || "";

    if (state === "quota_limited") {
      const now = Date.now();
      if (lastQuotaUntilMs <= now) {
        lastQuotaUntilMs = now + (Number(payload?.retryAfterSec) || 60) * 1000;
      }
      const secondsLeft = Math.max(0, Math.ceil((lastQuotaUntilMs - now) / 1000));
      message = `Quota exceeded. Retry in about ${secondsLeft}s.`;
      if (secondsLeft === 0) {
        message = "Quota window likely reset. You can try scanning now.";
      }
    } else if (state === "ready") {
      lastQuotaUntilMs = 0;
    }

    setDetectorStatusUi(state, message);
  } catch (_error) {
    setDetectorStatusUi("error", "Status unavailable (server unreachable).");
  }
}

function setDetectorStatusUi(state, message) {
  detectorState.className = `status-pill status-${state}`;
  detectorState.textContent = formatStateLabel(state);
  detectorMessage.textContent = message || "";
}

function formatStateLabel(state) {
  if (state === "ready") return "Ready";
  if (state === "scanning") return "Scanning";
  if (state === "quota_limited") return "Quota Limited";
  if (state === "error") return "Error";
  return "Unknown";
}

function renderPreviews(dataUrls) {
  previewGrid.innerHTML = "";
  dataUrls.forEach((dataUrl, index) => {
    const img = document.createElement("img");
    img.src = dataUrl;
    img.className = "preview-item";
    img.alt = `Selected product preview ${index + 1}`;
    previewGrid.appendChild(img);
  });
}
