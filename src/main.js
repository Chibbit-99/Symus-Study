const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";
const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";

const byId = (id) => document.getElementById(id);
const fileInput = byId("pdf-file");
const fileInfo = byId("file-info");
const languageSelect = byId("language");
const scaleInput = byId("scale");
const scaleValue = byId("scale-value");
const pagesSelect = byId("pages");
const preserveLayout = byId("preserve-layout");
const startButton = byId("start");
const cancelButton = byId("cancel");
const statusBox = byId("status");
const progressBar = byId("progress");
const output = byId("output");
const stats = byId("stats");
const copyButton = byId("copy");
const downloadButton = byId("download");
const clearButton = byId("clear");

let pdfjs = null;
let tesseract = null;
let worker = null;
let cancelled = false;
let busy = false;
let resultPages = 0;

function setStatus(message, isError = false) {
  statusBox.textContent = message;
  statusBox.classList.toggle("error", isError);
}
function setBusy(value) {
  busy = value;
  startButton.disabled = value || !fileInput.files || !fileInput.files[0] || !pdfjs || !tesseract;
  cancelButton.disabled = !value;
  fileInput.disabled = value;
  languageSelect.disabled = value;
  scaleInput.disabled = value;
  pagesSelect.disabled = value;
}
function updateResultControls() {
  const hasText = output.value.length > 0;
  copyButton.disabled = !hasText;
  downloadButton.disabled = !hasText;
  stats.textContent = hasText ? output.value.length.toLocaleString() + " characters · " + resultPages + " page(s)" : "No text yet";
}
function appendText(text) {
  output.value += text;
  updateResultControls();
}
function loadScriptModule(url) {
  return import(url);
}

scaleInput.addEventListener("input", () => { scaleValue.textContent = scaleInput.value + "×"; });
fileInput.addEventListener("change", () => {
  const file = fileInput.files && fileInput.files[0];
  fileInfo.textContent = file ? file.name + " · " + (file.size / 1024 / 1024).toFixed(2) + " MB" : "Choose a PDF from your device.";
  setBusy(false);
});
output.addEventListener("input", updateResultControls);
clearButton.addEventListener("click", () => {
  output.value = "";
  resultPages = 0;
  progressBar.value = 0;
  updateResultControls();
  setStatus("Output cleared.");
});
copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(output.value);
    setStatus("Text copied to clipboard.");
  } catch (error) {
    output.focus();
    output.select();
    setStatus("Clipboard access was blocked. The text is selected so you can copy it manually.", true);
  }
});
downloadButton.addEventListener("click", () => {
  const blob = new Blob([output.value], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "extracted-text.txt";
  anchor.click();
  URL.revokeObjectURL(url);
});
cancelButton.addEventListener("click", () => {
  cancelled = true;
  cancelButton.disabled = true;
  setStatus("Cancelling after the current OCR operation…");
});

async function initialise() {
  try {
    if (typeof importPackage !== "function") {
      throw new Error("ARCH.js package loader was not found. Open this app through a static web server and check that ARCH.js loaded successfully.");
    }
    setStatus("Loading PDF.js and Tesseract.js…");
    [pdfjs, tesseract] = await Promise.all([
      loadScriptModule(PDFJS_URL),
      importPackage("tesseract.js@6.0.1")
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    setStatus("Ready. Select a PDF to begin.");
    setBusy(false);
  } catch (error) {
    console.error("[Symus Study OCR] Initialisation failed:", error);
    setStatus("Could not load OCR dependencies: " + (error && error.message ? error.message : String(error)), true);
  }
}

async function runOcr() {
  const file = fileInput.files && fileInput.files[0];
  if (!file || busy) return;
  cancelled = false;
  output.value = "";
  resultPages = 0;
  progressBar.value = 0;
  updateResultControls();
  setBusy(true);
  let pdf = null;

  try {
    if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      throw new Error("Please choose a PDF file.");
    }
    setStatus("Opening PDF…");
    const bytes = new Uint8Array(await file.arrayBuffer());
    pdf = await pdfjs.getDocument({ data: bytes }).promise;
    const pageCount = pagesSelect.value === "first" ? 1 : pdf.numPages;
    setStatus("Preparing OCR worker for " + languageSelect.value + "…");

    worker = await tesseract.createWorker(languageSelect.value, 1, {
      logger: (event) => {
        if (event.status === "recognizing text") {
          const percent = Math.round((event.progress || 0) * 100);
          setStatus("Recognising page " + Math.min(resultPages + 1, pageCount) + " of " + pageCount + "… " + percent + "%");
        } else if (event.status) {
          setStatus("OCR engine: " + event.status + "…");
        }
      }
    });

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      if (cancelled) break;
      setStatus("Rendering page " + pageNumber + " of " + pageCount + "…");
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: Number(scaleInput.value) });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { alpha: false });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: context, viewport: viewport }).promise;
      if (cancelled) {
        canvas.width = 0;
        canvas.height = 0;
        break;
      }
      setStatus("Recognising text on page " + pageNumber + " of " + pageCount + "…");
      const result = await worker.recognize(canvas);
      const pageText = result.data && result.data.text ? result.data.text.trim() : "";
      if (preserveLayout.checked) {
        appendText((output.value ? "\n\n" : "") + "----- Page " + pageNumber + " -----\n" + pageText);
      } else {
        appendText((output.value ? "\n\n" : "") + pageText);
      }
      resultPages++;
      progressBar.value = Math.round((pageNumber / pageCount) * 100);
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
    }
    if (cancelled) setStatus("Cancelled. Text from completed pages has been kept.");
    else {
      progressBar.value = 100;
      setStatus("Finished. Extracted text from " + resultPages + " page(s).");
    }
  } catch (error) {
    console.error("[Symus Study OCR] OCR failed:", error);
    setStatus("OCR failed: " + (error && error.message ? error.message : String(error)), true);
  } finally {
    if (worker) {
      try { await worker.terminate(); } catch (error) { console.warn("Could not stop OCR worker cleanly:", error); }
      worker = null;
    }
    if (pdf) {
      try { await pdf.destroy(); } catch (error) { /* no-op */ }
    }
    setBusy(false);
    updateResultControls();
  }
}

startButton.addEventListener("click", runOcr);
initialise();
