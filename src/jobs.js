/**
 * StudyForge — processing pipeline.
 *
 * One job runs at a time, in a queue:
 *
 *   PDF   read text layer -> AI gap check -> OCR flagged pages
 *         -> AI study document -> save document to localStorage
 *   text  AI study document -> save document to localStorage
 *   quiz / flashcards / exam
 *         AI study material from every saved document in a study kit,
 *         allocated per resource so each one is actually covered
 *
 * Uploaded files and extracted source text stay in memory only. What is
 * persisted is the generated study document and the questions.
 */
(function (StudyForge) {
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
        console.error("[StudyForge] Job listener failed:", error);
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
      const resource = StudyForge.store.getResource(item.resourceId);
      if (resource) {
        StudyForge.store.updateResource(resource.id, {
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
        const message = StudyForge.ai.describeError(error);
        console.error("[StudyForge] Job failed:", error);
        current.status = "error";
        current.error = message;
        const resource = StudyForge.store.getResource(current.resourceId);
        if (resource) {
          StudyForge.store.updateResource(resource.id, {
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
    const resource = StudyForge.store.getResource(job.resourceId);
    if (resource && resource.status === "processing") {
      StudyForge.store.updateResource(resource.id, {
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
      case "flashcards":
        return runFlashcardJob(job);
      case "exam":
        return runExamJob(job);
      default:
        throw new Error("Unknown job type: " + job.kind);
    }
  }

  function requireKey() {
    const key = StudyForge.store.getApiKey();
    if (!key) {
      throw new Error("Add your NVIDIA NIM API key in Settings before processing resources.");
    }
    return key;
  }

  async function runPdfJob(job) {
    const store = StudyForge.store;
    const ai = StudyForge.ai;
    const ocr = StudyForge.ocr;
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
    const store = StudyForge.store;
    const apiKey = requireKey();
    const text = job.text || "";

    if (!text.trim()) throw new Error("There is no text to process.");

    store.updateResource(job.resourceId, {
      status: "processing",
      statusMessage: "Writing the study document…",
      error: "",
    });
    progress(job, { step: "Writing the study document…", progress: 10 });

    const document = await StudyForge.ai.generateDocument({
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

  /**
   * Ask every resource in a kit for its own share of a study set.
   *
   * One prompt containing every document makes the model concentrate on a single
   * resource, so each resource gets a quota (see ai.planQuizAllocation), is
   * requested separately, and the results are returned as per-resource groups
   * for the caller to merge. A failed pass is recorded and skipped rather than
   * losing the whole set.
   *
   * @returns {Promise<{kit: object, ready: object[], groups: object[][],
   *                    coverage: object[], failures: object[]}>}
   */
  async function collectAcrossResources(job, { target, generate }) {
    const ai = StudyForge.ai;
    const apiKey = requireKey();
    const kit = StudyForge.store.getKit(job.kitId);
    if (!kit) throw new Error("That study kit no longer exists.");

    const ready = StudyForge.store
      .resourcesInKit(kit.id)
      .filter((resource) => resource.document && resource.document.trim());

    if (!ready.length) {
      throw new Error(
        "This study kit has no study documents yet. Process at least one resource before making questions.",
      );
    }

    const allocation = ai.planQuizAllocation(
      ready.map((resource) => ({ id: resource.id, name: resource.name, length: resource.document.length })),
      target,
    );
    const byId = new Map(ready.map((resource) => [resource.id, resource]));
    const coverage = allocation.map((entry) => ({
      id: entry.id,
      name: entry.name,
      requested: entry.quota,
      produced: 0,
    }));
    const failures = [];
    const groups = [];

    const ask = async (resourceId, quota, label) => {
      const resource = byId.get(resourceId);
      if (!resource) return [];
      const entry = coverage.find((item) => item.id === resourceId);

      try {
        const items = await generate({
          apiKey,
          resource,
          quota,
          sourceCount: allocation.length,
          partLabel: `“${resource.name}” (${label})`,
          signal: job.controller.signal,
          onProgress: (message) => progress(job, { step: message }),
        });
        if (entry) entry.produced += items.length;
        return items;
      } catch (error) {
        if (error && error.name === "AbortError") throw error;
        failures.push({ name: resource.name, message: ai.describeError(error) });
        console.warn("[StudyForge] Pass failed for", resource.name, error);
        return [];
      }
    };

    for (let index = 0; index < allocation.length; index++) {
      const entry = allocation[index];
      progress(job, {
        step: `Writing ${entry.quota} for “${entry.name}” (${index + 1}/${allocation.length})…`,
        progress: 10 + (index / allocation.length) * 70,
      });
      const items = await ask(entry.id, entry.quota, `${index + 1}/${allocation.length}`);
      if (items.length) groups.push(items);
    }

    // If the model came back short (or a pass failed), top up once using the
    // resources that did produce something, so the requested count is met.
    let produced = coverage.reduce((sum, item) => sum + item.produced, 0);
    const donors = coverage.filter((item) => item.produced > 0);
    if (produced < target && donors.length && !job.controller.signal.aborted) {
      const shortfall = Math.min(target - produced, 10);
      progress(job, {
        step: `Requesting ${shortfall} more to reach ${target}…`,
        progress: 85,
      });
      const topUp = ai.planQuizAllocation(
        donors.map((item) => ({
          id: item.id,
          name: item.name,
          length: (byId.get(item.id) || { document: "" }).document.length,
        })),
        shortfall,
      );
      for (const entry of topUp) {
        const extra = await ask(entry.id, entry.quota, "top-up");
        if (extra.length) groups.push(extra);
      }
    }

    return { kit, ready, groups, coverage, failures };
  }

  /** Merge per-resource groups, keeping de-duplication and interleaving. */
  function mergeGroups(groups, { dedupe }) {
    return dedupe(StudyForge.ai.interleaveQuestionGroups(groups));
  }

  function quizFailure(failures, what) {
    return failures.length
      ? `Could not write ${what}: ${failures[0].message}`
      : `The model did not return usable ${what}. Try again or add more content to this kit.`;
  }

  /**
   * Practice questions for a whole kit: allocated per resource, merged,
   * de-duplicated and interleaved.
   */
  async function runQuizJob(job) {
    const ai = StudyForge.ai;
    const target = Math.max(1, Math.min(job.count || 10, 25));

    progress(job, { step: `Planning ${target} question(s)…`, progress: 5 });

    const { kit, ready, groups, coverage, failures } = await collectAcrossResources(job, {
      target,
      generate: ({ apiKey, resource, quota, sourceCount, partLabel, signal, onProgress }) =>
        ai.generateQuestions({
          apiKey,
          document: resource.document,
          count: quota,
          difficulty: job.difficulty || "",
          sourceName: resource.name,
          sourceCount,
          partLabel,
          signal,
          onProgress,
        }),
    });

    const questions = mergeGroups(groups, { dedupe: ai.dedupeQuestions });
    if (!questions.length) throw new Error(quizFailure(failures, "questions"));

    const missing = coverage.filter((item) => item.produced === 0);
    StudyForge.store.setKitQuiz(kit.id, {
      generatedAt: new Date().toISOString(),
      items: questions,
      sourceCount: ready.length,
      sourceNames: ready.map((resource) => resource.name),
      coverage,
      failures,
      truncated: ready.some((resource) => resource.document.length > ai.MAX_QUIZ_SOURCE_CHARS),
    });

    progress(job, {
      step: missing.length
        ? `${questions.length} question(s) ready; none for ${missing.length} resource(s).`
        : `${questions.length} question(s) ready across ${coverage.length} resource(s).`,
      progress: 100,
    });
  }

  /** Flashcards for a whole kit, allocated per resource like the questions. */
  async function runFlashcardJob(job) {
    const ai = StudyForge.ai;
    const target = Math.max(1, Math.min(job.count || 20, 40));
    // Deck style: vocab/concept cards or exam-style questions.
    const style =
      job.style === "question" || job.style === "vocab"
        ? job.style
        : StudyForge.store.getSettings().flashcardStyle || "vocab";

    progress(job, { step: `Planning ${target} flashcard(s)…`, progress: 5 });

    const { kit, ready, groups, coverage, failures } = await collectAcrossResources(job, {
      target,
      generate: async ({ apiKey, resource, quota, sourceCount, partLabel, signal, onProgress }) => {
        const cards = await ai.generateFlashcards({
          apiKey,
          document: resource.document,
          count: quota,
          style,
          sourceName: resource.name,
          sourceCount,
          partLabel,
          signal,
          onProgress,
        });
        // Remember which resource each card came from, for the deck's footer.
        return cards.map((card) => ({ ...card, source: resource.name }));
      },
    });

    const cards = mergeGroups(groups, { dedupe: ai.dedupeFlashcards });
    if (!cards.length) throw new Error(quizFailure(failures, "flashcards"));

    const missing = coverage.filter((item) => item.produced === 0);
    StudyForge.store.setKitFlashcards(kit.id, {
      generatedAt: new Date().toISOString(),
      items: cards,
      style,
      sourceCount: ready.length,
      sourceNames: ready.map((resource) => resource.name),
      coverage,
      failures,
    });

    progress(job, {
      step: missing.length
        ? `${cards.length} flashcard(s) ready; none for ${missing.length} resource(s).`
        : `${cards.length} flashcard(s) ready across ${coverage.length} resource(s).`,
      progress: 100,
    });
  }

  /** A timed practice exam: multiple choice, allocated per resource. */
  async function runExamJob(job) {
    const ai = StudyForge.ai;
    const target = Math.max(1, Math.min(job.count || 20, 40));

    progress(job, { step: `Planning a ${target}-question exam…`, progress: 5 });

    const { kit, ready, groups, coverage, failures } = await collectAcrossResources(job, {
      target,
      generate: ({ apiKey, resource, quota, sourceCount, partLabel, signal, onProgress }) =>
        ai.generateQuestions({
          apiKey,
          document: resource.document,
          count: quota,
          difficulty: "exam",
          style: "exam",
          sourceName: resource.name,
          sourceCount,
          partLabel,
          signal,
          onProgress,
        }),
    });

    const questions = mergeGroups(groups, { dedupe: ai.dedupeQuestions }).slice(0, target);
    if (!questions.length) throw new Error(quizFailure(failures, "exam questions"));

    // Default timing: a little over a minute per question, rounded to 5 minutes.
    const minutes = job.durationMinutes
      ? Math.min(180, Math.max(1, Math.round(job.durationMinutes)))
      : Math.max(5, Math.round((questions.length * 1.2) / 5) * 5);

    StudyForge.store.setKitExam(kit.id, {
      generatedAt: new Date().toISOString(),
      items: questions,
      durationMinutes: minutes,
      sourceCount: ready.length,
      sourceNames: ready.map((resource) => resource.name),
      coverage,
      failures,
    });

    progress(job, {
      step: `${questions.length}-question exam ready · ${minutes} minutes.`,
      progress: 100,
    });
  }

  /* ------------------------------------------------------------------ *
   * Convenience launchers used by the UI
   * ------------------------------------------------------------------ */

  function uploadPdf(resource, file) {
    return enqueue({
      kind: "pdf",
      resourceId: resource.id,
      resourceName: resource.name,
      subject: (StudyForge.store.getKit(resource.kitId) || {}).subject || "",
      file,
      label: `Processing ${resource.name}`,
    });
  }

  function uploadText(resource, text) {
    return enqueue({
      kind: "text",
      resourceId: resource.id,
      resourceName: resource.name,
      subject: (StudyForge.store.getKit(resource.kitId) || {}).subject || "",
      text,
      label: `Processing ${resource.name}`,
    });
  }

  function makeQuiz(kit, count, difficulty = "") {
    return enqueue({
      kind: "quiz",
      kitId: kit.id,
      count,
      difficulty,
      label: `Practice questions for ${kit.name}`,
    });
  }

  function makeFlashcards(kit, count, style) {
    return enqueue({
      kind: "flashcards",
      kitId: kit.id,
      count,
      style,
      label: `Flashcards for ${kit.name}`,
    });
  }

  function makeExam(kit, count, durationMinutes) {
    return enqueue({
      kind: "exam",
      kitId: kit.id,
      count,
      durationMinutes,
      label: `Practice exam for ${kit.name}`,
    });
  }

  StudyForge.jobs = {
    subscribe,
    enqueue,
    uploadPdf,
    uploadText,
    makeQuiz,
    makeFlashcards,
    makeExam,
    cancelCurrent,
    cancelAll,
    getCurrent,
    getLast,
    getQueue,
    isBusy,
    getSessionFile,
  };
})((window.StudyForge = window.StudyForge || {}));
