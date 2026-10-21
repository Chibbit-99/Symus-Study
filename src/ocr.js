/**
 * StudyForge — PDF text extraction and OCR.
 *
 * Two jobs:
 *   extractTextPages() — read each page's embedded text layer with PDF.js.
 *   ocrPages()         — render selected pages to a canvas and recognise them
 *                        with Tesseract.js.
 *
 * Tesseract.js is loaded on demand through ARCH.js `importPackage()`, with the
 * jsDelivr ESM build as a fallback, so the dashboard never waits for it.
 */
(function (StudyForge) {
  "use strict";

  const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";
  const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";
  const TESSERACT_ESM_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/+esm";

  const CJK_CHAR = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

  let pdfjsPromise = null;
  let tesseractPromise = null;
  let ocrWorker = null;
  let ocrWorkerLanguage = null;

  function ensurePdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(PDFJS_URL)
        .then((module) => {
          module.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
          return module;
        })
        .catch((error) => {
          pdfjsPromise = null;
          throw new Error(
            "Could not load PDF.js. Check your internet connection and CDN access. " +
              (error && error.message ? error.message : String(error)),
          );
        });
    }
    return pdfjsPromise;
  }

  const isTesseract = (module) => Boolean(module && typeof module.createWorker === "function");

  /**
   * Tesseract.js is only needed when a page actually has to be OCR'd, so it is
   * loaded on demand: first through ARCH.js `importPackage()` (the documented
   * package API), then the jsDelivr ESM build as a fallback.
   */
  function ensureTesseract(onStatus) {
    const loaded = globalThis.Tesseract;
    if (isTesseract(loaded)) return Promise.resolve(loaded);
    if (tesseractPromise) return tesseractPromise;

    tesseractPromise = (async () => {
      if (typeof globalThis.importPackage === "function") {
        try {
          if (onStatus) onStatus("Loading the OCR engine through ARCH.js…");
          const pkg = await globalThis.importPackage(
            (globalThis.STUDYFORGE_CONFIG && globalThis.STUDYFORGE_CONFIG.tesseractPackage) || "tesseract.js",
          );
          if (isTesseract(pkg)) return pkg;
          console.warn("[StudyForge OCR] importPackage returned no createWorker; using the CDN build.");
        } catch (error) {
          console.warn("[StudyForge OCR] importPackage failed; using the CDN build.", error);
        }
      }
      if (onStatus) onStatus("Loading the OCR engine…");
      return import(TESSERACT_ESM_URL);
    })()
      .then((module) => {
        if (!isTesseract(module)) throw new Error("The OCR engine did not expose createWorker().");
        return module;
      })
      .catch((error) => {
        tesseractPromise = null;
        throw new Error(
          "Could not load Tesseract.js. Check your internet connection and CDN access. " +
            (error && error.message ? error.message : String(error)),
        );
      });

    return tesseractPromise;
  }

  async function openPdf(file) {
    const pdfjs = await ensurePdfjs();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data: bytes }).promise;
    return pdf;
  }

  /**
   * Rebuild readable text from a PDF.js text layer.
   *
   * PDF.js returns positioned text runs rather than lines, so newlines are
   * inferred from each run's vertical position and word spaces from horizontal
   * gaps. Adjacent CJK runs are joined without spaces.
   */
  function textContentToText(textContent) {
    const items = (textContent && textContent.items) || [];
    const parts = [];
    let lastY = null;
    let lastXEnd = null;

    for (const item of items) {
      if (!item || typeof item.str !== "string") continue;

      const x = item.transform ? item.transform[4] : 0;
      const y = item.transform ? item.transform[5] : 0;
      const height = Math.abs(item.height) || 10;

      if (lastY !== null && Math.abs(y - lastY) > Math.max(2, height * 0.5)) {
        parts.push("\n");
        lastXEnd = null;
      } else if (lastXEnd !== null && x - lastXEnd > Math.max(2, height * 0.2)) {
        const previous = parts.length ? parts[parts.length - 1] : "";
        const lastChar = previous.slice(-1);
        const firstChar = item.str.charAt(0);
        if (!(CJK_CHAR.test(lastChar) && CJK_CHAR.test(firstChar))) parts.push(" ");
      }

      parts.push(item.str);
      lastY = y;
      lastXEnd = x + (item.width || 0);

      if (item.hasEOL) {
        parts.push("\n");
        lastY = null;
        lastXEnd = null;
      }
    }

    return parts
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * Read every page's text layer.
   * @returns {{total:number, pages:Array<{page:number,text:string,chars:number}>}}
   */
  async function extractTextPages(pdf, { signal, onProgress } = {}) {
    const total = pdf.numPages;
    const pages = [];

    for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
      if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");

      const page = await pdf.getPage(pageNumber);
      let text = "";
      try {
        text = textContentToText(await page.getTextContent());
      } finally {
        page.cleanup();
      }

      pages.push({ page: pageNumber, text, chars: text.length });
      if (onProgress) onProgress({ page: pageNumber, total, chars: text.length });
    }

    return { total, pages };
  }

  /* ------------------------------------------------------------------ *
   * OCR
   * ------------------------------------------------------------------ */

  async function getWorker(language, logger, onStatus) {
    if (ocrWorker && ocrWorkerLanguage === language) return ocrWorker;
    await stopWorker();
    const tesseract = await ensureTesseract(onStatus);
    const worker = await tesseract.createWorker(language, 1, { logger });
    ocrWorker = worker;
    ocrWorkerLanguage = language;
    return worker;
  }

  async function stopWorker() {
    if (!ocrWorker) return;
    const worker = ocrWorker;
    ocrWorker = null;
    ocrWorkerLanguage = null;
    try {
      await worker.terminate();
    } catch (error) {
      console.warn("[StudyForge OCR] Could not stop the OCR worker cleanly:", error);
    }
  }

  /**
   * OCR specific pages of an open PDF.
   * @param {Array<number>} pageNumbers 1-based page numbers
   * @returns {Promise<Map<number,string>>}
   */
  async function ocrPages(pdf, pageNumbers, { scale = 2, language = "eng", signal, onProgress, onStatus } = {}) {
    const results = new Map();
    if (!pageNumbers.length) return results;

    let current = pageNumbers[0];
    const logger = (event) => {
      if (!onProgress || !event) return;
      if (event.status === "recognizing text") {
        onProgress({ page: current, progress: event.progress || 0, status: "recognizing" });
      } else if (event.status) {
        onProgress({ page: current, progress: 0, status: event.status });
      }
    };

    const worker = await getWorker(language, logger, onStatus);

    for (let index = 0; index < pageNumbers.length; index++) {
      if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
      current = pageNumbers[index];

      const page = await pdf.getPage(current);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { alpha: false });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);

      try {
        await page.render({ canvasContext: context, viewport }).promise;
        if (onProgress) onProgress({ page: current, progress: 0, status: "recognizing" });
        const result = await worker.recognize(canvas);
        results.set(current, result && result.data && result.data.text ? result.data.text.trim() : "");
      } finally {
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
      }
    }

    return results;
  }

  StudyForge.ocr = {
    ensurePdfjs,
    ensureTesseract,
    openPdf,
    extractTextPages,
    ocrPages,
    stopWorker,
    textContentToText,
  };
})((window.StudyForge = window.StudyForge || {}));
