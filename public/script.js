const cameraInput = document.getElementById("cameraInput");
const galleryInput = document.getElementById("galleryInput");
const captureButton = document.getElementById("captureButton");
const uploadButton = document.getElementById("uploadButton");
const copyButton = document.getElementById("copyButton");
const previewGrid = document.getElementById("previewGrid");
const resultText = document.getElementById("resultText");
const defaultButtonLabel = "Scan";
const defaultCopyLabel = "Copy Result";
const COOLDOWN_MS = 3000;
let cooldownTimeoutId = null;
let isCooldownActive = false;
captureButton.textContent = defaultButtonLabel;
copyButton.textContent = defaultCopyLabel;

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

async function handleImageSelection(event) {
  const files = Array.from(event.target.files || []);
  if (files.length === 0) return;

  try {
    const dataUrls = await Promise.all(files.map((file) => fileToDataUrl(file)));
    renderPreviews(dataUrls);

    setButtonsDisabled(true);
    resultText.textContent = "Identifying...";

    const response = await fetch("/identify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ imagesBase64: dataUrls }),
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Identification failed.");
    }

    resultText.textContent = payload.result || "No result returned.";
  } catch (error) {
    resultText.textContent = `Error: ${error.message}`;
  } finally {
    startCooldown();
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

function startCooldown() {
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
  }, COOLDOWN_MS);
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
