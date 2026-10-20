const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";
const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";
const NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NIM_MODEL = "google/diffusiongemma-26b-a4b-it";
const NOTE_CHUNK_SIZE = 14000;

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
const apiKeyInput = byId("nim-key");
const studyLevel = byId("study-level");
const subjectInput = byId("subject");
const generateNotesButton = byId("generate-notes");
const clearKeyButton = byId("clear-key");
const cancelNotesButton = byId("cancel-notes");
const aiStatus = byId("ai-status");
const notesOutput = byId("notes-output");
const copyNotesButton = byId("copy-notes");
const downloadNotesButton = byId("download-notes");

let pdfjs = null;
let tesseract = null;
let worker = null;
let cancelled = false;
let busy = false;
let generatingNotes = false;
let resultPages = 0;
let notesCancelled = false;
let notesController = null;

function setStatus(message, isError = false) {
  statusBox.textContent = message;
  statusBox.classList.toggle("error", isError);
}
function setAiStatus(message, isError = false) {
  aiStatus.textContent = message;
  aiStatus.classList.toggle("error", isError);
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
  const hasText = output.value.trim().length > 0;
  copyButton.disabled = !hasText;
  downloadButton.disabled = !hasText;
  generateNotesButton.disabled = generatingNotes || !hasText || !apiKeyInput.value.trim();
  stats.textContent = hasText ? output.value.length.toLocaleString() + " characters · " + resultPages + " page(s)" : "No text yet";
}
function updateNotesControls() {
  const hasNotes = notesOutput.value.trim().length > 0;
  copyNotesButton.disabled = !hasNotes;
  downloadNotesButton.disabled = !hasNotes;
  generateNotesButton.disabled = generatingNotes || !output.value.trim() || !apiKeyInput.value.trim();
  cancelNotesButton.disabled = !generatingNotes;
}
function appendText(text) {
  output.value += text;
  updateResultControls();
}
function loadScriptModule(url) {
  return import(url);
}
function downloadText(content, filename, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function copyToClipboard(text, target) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Text copied to clipboard.");
  } catch (error) {
    target.focus();
    target.select();
    setStatus("Clipboard access was blocked. The text is selected so you can copy it manually.", true);
  }
}

scaleInput.addEventListener("input", () => { scaleValue.textContent = scaleInput.value + "×"; });
fileInput.addEventListener("change", () => {
  const file = fileInput.files && fileInput.files[0];
  fileInfo.textContent = file ? file.name + " · " + (file.size / 1024 / 1024).toFixed(2) + " MB" : "Choose a PDF from your device.";
  setBusy(false);
});
output.addEventListener("input", updateResultControls);
apiKeyInput.addEventListener("input", updateResultControls);
notesOutput.addEventListener("input", updateNotesControls);
clearButton.addEventListener("click", () => {
  output.value = "";
  resultPages = 0;
  progressBar.value = 0;
  updateResultControls();
  setStatus("Extracted text cleared.");
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
downloadButton.addEventListener("click", () => downloadText(output.value, "extracted-text.txt"));
copyNotesButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(notesOutput.value);
    setAiStatus("Study notes copied to clipboard.");
  } catch (error) {
    notesOutput.focus();
    notesOutput.select();
    setAiStatus("Clipboard access was blocked. The notes are selected so you can copy them manually.", true);
  }
});
downloadNotesButton.addEventListener("click", () => downloadText(notesOutput.value, "symus-study-notes.md", "text/markdown;charset=utf-8"));
clearKeyButton.addEventListener("click", () => {
  apiKeyInput.value = "";
  updateResultControls();
  setAiStatus("API key cleared from this page.");
});
cancelButton.addEventListener("click", () => {
  cancelled = true;
  cancelButton.disabled = true;
  setStatus("Cancelling after the current OCR operation…");
});
generateNotesButton.addEventListener("click", generateStudyNotes);
cancelNotesButton.addEventListener("click", () => {
  if (!generatingNotes || !notesController) return;
  notesCancelled = true;
  notesController.abort();
  cancelNotesButton.disabled = true;
  setAiStatus("Cancelling note generation…");
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

function splitIntoChunks(text, maxLength) {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const pieces = paragraph.length > maxLength
      ? paragraph.match(new RegExp("[\\s\\S]{1," + maxLength + "}", "g")) || [paragraph]
      : [paragraph];
    for (const piece of pieces) {
      const next = current ? current + "\n\n" + piece : piece;
      if (next.length > maxLength && current) {
        chunks.push(current);
        current = piece;
      } else {
        current = next;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function buildNotesPrompt(sourceText, part, total) {
  const styleInstructions = {
    concise: "Make concise, well-organised revision notes with clear headings, short bullet points, key facts, definitions, and a short recap.",
    detailed: "Make detailed study notes that explain the ideas clearly, define important terms, include relevant examples, and show relationships between concepts.",
    exam: "Make exam-focused notes: core knowledge, cause-and-effect links, evidence/examples, common misconceptions, and likely practice questions with short model answers.",
    flashcards: "Create a set of flashcards in Markdown. Each card should have a clear Question and Answer, cover important facts and concepts, and avoid vague questions."
  };
  const focus = subjectInput.value.trim();
  return [
    "Create accurate, useful student study notes from the source text below.",
    "Follow these rules:",
    "- Use only information supported by the source. Do not invent facts, dates, statistics, quotations, or citations.",
    "- Fix obvious OCR errors only when the intended wording is clear. If something is unclear, mark it as [unclear in source].",
    "- Preserve important names, terminology, formulas, dates, examples, and qualifications.",
    "- Explain difficult ideas in student-friendly language and structure the result in readable Markdown.",
    "- Do not mention these instructions.",
    "Requested style: " + styleInstructions[studyLevel.value],
    focus ? "Subject/focus: " + focus : "",
    total > 1 ? "This is source section " + part + " of " + total + ". Make notes for this section only; the app will combine notes from all sections." : "",
    "",
    "SOURCE TEXT:",
    sourceText
  ].filter(Boolean).join("\n");
}

async function requestNotes(apiKey, prompt, signal) {
  const response = await fetch(NIM_URL, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    signal,
    body: JSON.stringify({
      model: NIM_MODEL,
      messages: [{ role: "user", content: prompt }],
      chat_template_kwargs: { enable_thinking: false },
      max_tokens: 3072,
      temperature: 0.3,
      top_p: 0.9,
      stream: false
    })
  });

  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch (error) {
    throw new Error("NVIDIA returned an unexpected response (HTTP " + response.status + "). Check the key, network, and model availability.");
  }
  if (!response.ok) {
    const detail = data && data.error && (data.error.message || data.error)
      ? String(data.error.message || data.error)
      : "HTTP " + response.status;
    throw new Error(detail + ". Check that your NVIDIA API key is valid and the model is available to your account.");
  }
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "";
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("The model returned an empty response. Try again or use a shorter source.");
  }
  return content.trim();
}

async function generateStudyNotes() {
  const apiKey = apiKeyInput.value.trim();
  const source = output.value.trim();
  if (!apiKey) {
    setAiStatus("Enter your NVIDIA NIM API key first.", true);
    apiKeyInput.focus();
    return;
  }
  if (!source) {
    setAiStatus("Extract text from a PDF first, or paste text into the extracted-text box.", true);
    output.focus();
    return;
  }
  if (generatingNotes) return;

  generatingNotes = true;
  notesCancelled = false;
  notesController = new AbortController();
  notesOutput.value = "";
  updateNotesControls();
  generateNotesButton.textContent = "Generating…";
  clearKeyButton.disabled = true;

  try {
    const chunks = splitIntoChunks(source, NOTE_CHUNK_SIZE);
    const generated = [];
    for (let i = 0; i < chunks.length; i++) {
      if (notesCancelled) break;
      setAiStatus("Generating notes with " + NIM_MODEL + " — section " + (i + 1) + " of " + chunks.length + "…");
      const part = await requestNotes(apiKey, buildNotesPrompt(chunks[i], i + 1, chunks.length), notesController.signal);
      generated.push(chunks.length > 1 ? "## Source section " + (i + 1) + "\n\n" + part : part);
      notesOutput.value = generated.join("\n\n---\n\n");
      updateNotesControls();
    }
    if (notesCancelled) setAiStatus("Generation cancelled. Any completed sections have been kept.");
    else setAiStatus("Done. Generated study notes from " + chunks.length + " text section(s). Review them for accuracy against your source.");
  } catch (error) {
    if (error && error.name === "AbortError") {
      setAiStatus("Generation cancelled. Any completed sections have been kept.");
    } else {
      console.error("[Symus Study NIM] Note generation failed:", error);
      setAiStatus("Could not generate notes: " + (error && error.message ? error.message : String(error)), true);
    }
  } finally {
    generatingNotes = false;
    notesController = null;
    generateNotesButton.textContent = "Generate study notes";
    clearKeyButton.disabled = false;
    updateResultControls();
    updateNotesControls();
  }
}

initialise();
