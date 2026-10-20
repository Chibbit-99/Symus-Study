/**
 * Symus Study — processing pipeline.
 *
 * One job runs at a time, in a queue:
 *
 *   PDF   read text layer -> AI gap check -> OCR flagged pages
 *         -> AI study document -> save document to localStorage
 *   text  AI study document -> save document to localStorage
 *   quiz  AI practice questions from the saved document
 *
 * Uploaded files and extracted source text stay in memory only. What is
 * persisted is the generated study document and the questions.
 */
(function (Symus) {
  "use strict";

  const listeners = new Set();
  const queue = [];
  const sessionFiles = new Map(); // resourceId -> File, for re-runs in this tab
  let current = null;
  let lastJob = null;
  let counter = 0;

  /* ------------------------------------------------------------------ *
   * Public surface
   * ------------------------------------------------------------------ */

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function emit() {
    for (const listener of listeners) {
      try {
        listener(current, queue);
      } catch (error) {
        console.error("[Symus Study] Job listener failed:", error);
      }
    }
  }

  const getCurrent = () => current;
  const getLast = () => lastJob;
  const getQueue = () => queue.slice();
  const isBusy = () => Boolean(current);
  const getSessionFile = (resourceId) => sessionFiles.get(resourceId) || null;

  function enqueue(job) {
    const item = {
      id: `job_${++counter}`,
      status: "queued",
      step: "Waiting…",
      progress: 0,
      ...job,
    };
    queue.push(item);
    emit();
    pump();
    return item.id;
  }

  function cancelCurrent() {
    if (!current) return false;
    current.cancelled = true;
    current.controller.abort();
    current.step = "Cancelling…";
    emit();
    return true;
  }

  function cancelAll() {
    for (const item of queue.splice(0)) {
      const resource = Symus.store.getResource(item.resourceId);
      if (resource) {
        Symus.store.updateResource(resource.id, {
          status: "queued",
          statusMessage: "Cancelled before it started.",
        });
      }
    }
    cancelCurrent();
    emit();
    return true;
  }

  async function pump() {
    if (current || !queue.length) return;
    current = queue.shift();
    current.controller = new AbortController();
    current.status = "running";
    emit();

    try {
      await runJob(current);
      if (current.cancelled) {
        finishCancelled(current);
      } else {
        current.status = "done";
        current.progress = 100;
      }
    } catch (error) {
      if (error && error.name === "AbortError") {
        finishCancelled(current);
      } else {
        const message = Symus.ai.describeError(error);
        console.error("[Symus Study] Job failed:", error);
        current.status = "error";
        current.error = message;
        const resource = Symus.store.getResource(current.resourceId);
        if (resource) {
          Symus.store.updateResource(resource.id, {
            status: "error",
            statusMessage: "",
            error: message,
          });
        }
      }
    } finally {
      const finished = current;
      lastJob = finished;
      current = null;
      emit();
      // Keep the finished job visible for a moment, then clear it.
      if (finished && finished.kind !== "quiz") setTimeout(emit, 4000);
      pump();
    }
  }

  function finishCancelled(job) {
    job.status = "cancelled";
    job.step = "Cancelled";
    const resource = Symus.store.getResource(job.resourceId);
    if (resource && resource.status === "processing") {
      Symus.store.updateResource(resource.id, {
        status: resource.document ? "ready" : "queued",
        statusMessage: "Cancelled.",
      });
    }
  }

  function progress(job, patch) {
    if (job.cancelled) return;
    Object.assign(job, patch);
    emit();
  }

  /* ------------------------------------------------------------------ *
   * Jobs
   * ------------------------------------------------------------------ */

  async function runJob(job) {
    switch (job.kind) {
      case "pdf":
        return runPdfJob(job);
      case "text":
        return runTextJob(job);
      case "quiz":
        return runQuizJob(job);
      default:
        throw new Error("Unknown job type: " + job.kind);
    }
  }

  function requireKey() {
    const key = Symus.store.getApiKey();
    if (!key) {
      throw new Error("Add your NVIDIA NIM API key in Settings before processing resources.");
    }
    return key;
  }

  async function runPdfJob(job) {
    const store = Symus.store;
    const ai = Symus.ai;
    const ocr = Symus.ocr;
    const settings = store.getSettings();
    const apiKey = requireKey();
    const file = job.file || sessionFiles.get(job.resourceId);

    if (!file) {
      throw new Error("The PDF is no longer available in this tab. Re-upload it to process this resource.");
    }
    sessionFiles.set(job.resourceId, file);

    store.updateResource(job.resourceId, {
      status: "processing",
      statusMessage: "Reading the PDF…",
      error: "",
    });

    let pdf = null;
    try {
      pdf = await ocr.openPdf(file);
      const total = pdf.numPages;

      progress(job, { step: `Reading the text layer of ${total} page(s)…`, progress: 3 });
      const extracted = await ocr.extractTextPages(pdf, {
        signal: job.controller.signal,
        onProgress: ({ page }) => {
          progress(job, {
            step: `Reading the text layer — page ${page} of ${total}…`,
            progress: 3 + (page / total) * 12,
          });
        },
      });

      const textPages = extracted.pages.filter((page) => page.chars > 0).length;
      store.updateResource(job.resourceId, {
        statusMessage: "Checking for missing content…",
        pages: { total, textPages, ocrPages: [], gapNotes: "" },
      });

      progress(job, { step: "Checking whether any pages are missing text…", progress: 16 });
      const gap = await ai.analyseGaps({
        apiKey,
        pages: extracted.pages,
        total,
        signal: job.controller.signal,
        onProgress: (message) => progress(job, { step: message, progress: 20 }),
      });

      const ocrText = new Map();
      if (gap.pages.length) {
        progress(job, {
          step: `Running OCR on ${gap.pages.length} page(s)…`,
          progress: 30,
        });
        const ocrResults = await ocr.ocrPages(pdf, gap.pages, {
          scale: settings.ocrScale,
          language: settings.ocrLanguage,
          signal: job.controller.signal,
          onStatus: (message) => progress(job, { step: message, progress: 30 }),
          onProgress: ({ page, progress: pageProgress, status }) => {
            const index = gap.pages.indexOf(page);
            const done = index + (status === "recognizing" ? pageProgress : 0);
            progress(job, {
              step:
                status === "recognizing"
                  ? `OCR — page ${page} (${Math.round(done)}/${gap.pages.length})`
                  : `OCR engine: ${status}`,
              progress: 30 + (done / gap.pages.length) * 45,
            });
          },
        });
        for (const [page, text] of ocrResults) ocrText.set(page, text);
      }

      store.updateResource(job.resourceId, {
        statusMessage: "Writing the study document…",
        pages: {
          total,
          textPages,
          ocrPages: Array.from(ocrText.keys()).sort((a, b) => a - b),
          pendingOcr: gap.remaining || [],
          gapNotes: gap.notes,
          analysedAt: new Date().toISOString(),
        },
      });

      // Merge: OCR text wins on pages that were OCR'd.
      const merged = extracted.pages
        .map((page) => {
          const text = ocrText.has(page.page) ? ocrText.get(page.page) : page.text;
          return text ? text : "";
        })
        .filter((text) => text.trim())
        .join("\n\n");

      if (!merged.trim()) {
        throw new Error(
          "No text could be extracted from this PDF, even with OCR. It may be an empty document or a scan too low quality to read.",
        );
      }

      progress(job, { step: "Writing the study document…", progress: 78 });
      const document = await ai.generateDocument({
        apiKey,
        text: merged,
        meta: {
          title: job.resourceName,
          subject: job.subject,
          sourceType: "pdf",
        },
        signal: job.controller.signal,
        onProgress: ({ message }) => progress(job, { step: message, progress: 80 }),
      });

      let statusMessage = `Document ready — ${total} page(s), ${ocrText.size} OCR'd.`;
      if (document.truncatedParts.length) {
        statusMessage += ` Part(s) ${document.truncatedParts.join(", ")} hit the output limit and may be short.`;
      }
      if (gap.remaining && gap.remaining.length) {
        statusMessage += ` ${gap.remaining.length} flagged page(s) were skipped (${ai.MAX_OCR_PAGES}-page OCR limit).`;
      }

      store.updateResource(job.resourceId, {
        status: "ready",
        statusMessage,
        error: "",
        document: document.markdown,
        documentUpdatedAt: new Date().toISOString(),
      });

      progress(job, { step: "Study document ready.", progress: 100 });
    } finally {
      if (pdf) {
        try {
          await pdf.destroy();
        } catch (error) {
          /* ignore */
        }
      }
    }
  }

  async function runTextJob(job) {
    const store = Symus.store;
    const apiKey = requireKey();
    const text = job.text || "";

    if (!text.trim()) throw new Error("There is no text to process.");

    store.updateResource(job.resourceId, {
      status: "processing",
      statusMessage: "Writing the study document…",
      error: "",
    });
    progress(job, { step: "Writing the study document…", progress: 10 });

    const document = await Symus.ai.generateDocument({
      apiKey,
      text,
      meta: {
        title: job.resourceName,
        subject: job.subject,
        sourceType: "text",
      },
      signal: job.controller.signal,
      onProgress: ({ message, part, total }) => {
        progress(job, {
          step: message,
          progress: total > 1 ? 10 + (part / total) * 85 : 50,
        });
      },
    });

    let statusMessage = "Document ready.";
    if (document.truncatedParts.length) {
      statusMessage += ` Part(s) ${document.truncatedParts.join(", ")} hit the output limit and may be short.`;
    }

    store.updateResource(job.resourceId, {
      status: "ready",
      statusMessage,
      error: "",
      pages: { total: 0, textPages: 0, ocrPages: [], gapNotes: "Restructured from pasted text." },
      document: document.markdown,
      documentUpdatedAt: new Date().toISOString(),
    });

    progress(job, { step: "Study document ready.", progress: 100 });
  }

  async function runQuizJob(job) {
    const apiKey = requireKey();
    const resource = Symus.store.getResource(job.resourceId);
    if (!resource) throw new Error("That resource no longer exists.");
    if (!resource.document) throw new Error("Generate the study document before making questions.");

    progress(job, { step: "Writing practice questions…", progress: 15 });

    const questions = await Symus.ai.generateQuestions({
      apiKey,
      document: resource.document,
      count: job.count || 10,
      difficulty: job.difficulty || "",
      signal: job.controller.signal,
      onProgress: (message) => progress(job, { step: message, progress: 40 }),
    });

    Symus.store.updateResource(job.resourceId, {
      quiz: { generatedAt: new Date().toISOString(), items: questions },
    });
    progress(job, { step: `${questions.length} practice questions ready.`, progress: 100 });
  }

  /* ------------------------------------------------------------------ *
   * Convenience launchers used by the UI
   * ------------------------------------------------------------------ */

  function uploadPdf(resource, file) {
    return enqueue({
      kind: "pdf",
      resourceId: resource.id,
      resourceName: resource.name,
      subject: (Symus.store.getKit(resource.kitId) || {}).subject || "",
      file,
      label: `Processing ${resource.name}`,
    });
  }

  function uploadText(resource, text) {
    return enqueue({
      kind: "text",
      resourceId: resource.id,
      resourceName: resource.name,
      subject: (Symus.store.getKit(resource.kitId) || {}).subject || "",
      text,
      label: `Processing ${resource.name}`,
    });
  }

  function makeQuiz(resource, count) {
    return enqueue({
      kind: "quiz",
      resourceId: resource.id,
      resourceName: resource.name,
      count,
      label: `Practice questions for ${resource.name}`,
    });
  }

  Symus.jobs = {
    subscribe,
    enqueue,
    uploadPdf,
    uploadText,
    makeQuiz,
    cancelCurrent,
    cancelAll,
    getCurrent,
    getLast,
    getQueue,
    isBusy,
    getSessionFile,
  };
})((window.Symus = window.Symus || {}));
