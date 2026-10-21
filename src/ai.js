/**
 * StudyForge — NVIDIA NIM client.
 *
 * All requests go through the StudyForge Cloudflare Worker
 * (https://symus-backend.chibbit99.workers.dev/api/notes), which forwards them
 * to integrate.api.nvidia.com with the user's own API key.
 *
 * Model: nvidia/nemotron-3.5-lightning-30b-a3b
 *
 * Three capabilities:
 *   analyseGaps()        — does the PDF text layer miss content? which pages?
 *   generateDocument()   — turn source text into a complete study document
 *   generateQuestions()  — practice questions from that document
 */
(function (StudyForge) {
  "use strict";

  // arch/init.js exports STUDYFORGE_CONFIG, which ARCH.js places on globalThis.
  const CONFIG = globalThis.STUDYFORGE_CONFIG || {};
  const WORKER_URL = CONFIG.workerUrl || "https://symus-backend.chibbit99.workers.dev";
  const DEFAULT_MODEL = CONFIG.model || "nvidia/nemotron-3.5-lightning-30b-a3b";

  // Model families the app offers. The Worker is the source of truth (it returns
  // the filtered catalogue from /api/models); this list filters defensively in
  // case the Worker is configured differently. Keep in sync with
  // DEFAULT_MODEL_FILTER in worker.js.
  const MODEL_FILTER = ["deepseek", "step", "nemotron", "mistral", "gemma", "glm", "muse"];

  /** The model chosen in Settings, falling back to the configured default. */
  function currentModel() {
    const stored = StudyForge.store && StudyForge.store.getSettings ? StudyForge.store.getSettings().model : "";
    return (stored || DEFAULT_MODEL).trim();
  }

  function matchesModelFilter(id) {
    const key = String(id || "").toLowerCase();
    return MODEL_FILTER.some((part) => key.includes(part));
  }

  const CHUNK_SIZE = 24000; // characters per model request
  const MAX_TOKENS = 4096;
  const MAX_RETRIES = 3;
  const RETRY_BASE_MS = 1200;
  const MAX_OCR_PAGES = 60;
  // Total study-document text sent when writing practice questions for a kit.
  const MAX_QUIZ_SOURCE_CHARS = 60000;

  /* ------------------------------------------------------------------ *
   * Transport
   * ------------------------------------------------------------------ */

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      }
    });
  }

  async function requestOnce({ apiKey, prompt, maxTokens, temperature, signal }) {
    const response = await fetch(WORKER_URL + "/api/notes", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal,
      body: JSON.stringify({
        model: currentModel(),
        messages: [{ role: "user", content: prompt }],
        chat_template_kwargs: { enable_thinking: false },
        max_tokens: maxTokens,
        temperature,
        top_p: 0.9,
        stream: false,
      }),
    });

    const raw = await response.text();
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      /* handled below */
    }

    if (!response.ok) {
      const detail =
        data && data.error && (data.error.message || data.error)
          ? String(data.error.message || data.error)
          : "HTTP " + response.status;
      const error = new Error(detail);
      error.status = response.status;
      error.retryable = response.status === 429 || response.status >= 500;
      if (data && data.detail) error.detail = String(data.detail);
      throw error;
    }
    if (!data) throw new Error("The note service returned an unexpected, non-JSON response.");

    const choice = data.choices && data.choices[0];
    const content = choice && choice.message ? choice.message.content : "";
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("The model returned an empty response.");
    }
    return { content: content.trim(), truncated: choice.finish_reason === "length" };
  }

  async function chat(options) {
    let attempt = 0;
    for (;;) {
      try {
        return await requestOnce(options);
      } catch (error) {
        if (error && error.name === "AbortError") throw error;
        if (!error || !error.retryable || attempt >= MAX_RETRIES) throw error;
        attempt++;
        if (options.onRetry) options.onRetry(error, attempt);
        await sleep(RETRY_BASE_MS * attempt, options.signal);
      }
    }
  }

  function describeError(error) {
    if (!error) return "Unknown error.";
    if (error.name === "AbortError") return "Cancelled.";
    if (error.status === 401) return "NVIDIA rejected the API key (401). Check the key in Settings.";
    if (error.status === 402) return "NVIDIA reported a billing/quota problem (402).";
    if (error.status === 403) {
      return "The request was refused (403). If the app is served from a new origin, update the worker origin allowlist.";
    }
    if (error.status === 404) return "The model is not available to this key (404).";
    if (error.status === 429) return "Rate limited by NVIDIA (429). Wait a moment and retry.";
    const base = error.message || String(error);
    return error.detail ? `${base} ${error.detail}` : base;
  }

  /**
   * Fetch the model catalogue from the StudyForge Worker.
   *
   * The Worker proxies NVIDIA's /v1/models with the caller's key and keeps only
   * models whose id contains one of MODEL_FILTER. The response is filtered again
   * here and sorted for display.
   *
   * @returns {Promise<{models: Array<{id: string, ownedBy: string}>, filter: string[]}>}
   */
  async function listModels({ apiKey, signal } = {}) {
    const response = await fetch(WORKER_URL + "/api/models", {
      method: "GET",
      headers: { Authorization: "Bearer " + apiKey, Accept: "application/json" },
      signal,
    });

    const raw = await response.text();
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      /* handled below */
    }

    if (!response.ok) {
      const detail =
        data && data.error && (data.error.message || data.error)
          ? String(data.error.message || data.error) + (data.detail ? " " + data.detail : "")
          : "HTTP " + response.status;
      const error = new Error(detail);
      error.status = response.status;
      throw error;
    }
    if (!data || !Array.isArray(data.models)) {
      throw new Error("The model service returned an unexpected response.");
    }

    const models = data.models
      .filter((entry) => entry && typeof entry.id === "string" && matchesModelFilter(entry.id))
      .map((entry) => ({ id: entry.id, ownedBy: typeof entry.ownedBy === "string" ? entry.ownedBy : "" }));

    return { models, filter: MODEL_FILTER };
  }

  /* ------------------------------------------------------------------ *
   * Text helpers
   * ------------------------------------------------------------------ */

  function splitIntoChunks(text, maxLength) {
    const paragraphs = String(text).split(/\n\s*\n/);
    const chunks = [];
    let current = "";

    for (const paragraph of paragraphs) {
      const pieces =
        paragraph.length > maxLength
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
    return chunks.filter((chunk) => chunk.trim());
  }

  /** Parse JSON that may be wrapped in prose or code fences. */
  function parseJsonLoose(text) {
    if (!text) return null;
    const cleaned = String(text)
      .replace(/^\s*```(?:json)?/i, "")
      .replace(/```\s*$/, "")
      .trim();
    try {
      return JSON.parse(cleaned);
    } catch (error) {
      /* fall through to bracket extraction */
    }
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch (error) {
        return null;
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Gap analysis
   * ------------------------------------------------------------------ */

  /**
   * Pages that almost certainly lost their text: far below the document's
   * median page length (or empty in a text-bearing document).
   */
  function heuristicOcrPages(pages) {
    const counts = pages.map((page) => page.chars).sort((a, b) => a - b);
    const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
    if (median === 0) return pages.map((page) => page.page);
    // Zero-text pages are always suspicious; otherwise only flag pages that are
    // far shorter than the document's median so short-but-complete pages (cover
    // pages, section dividers) are left alone.
    const threshold = Math.max(10, median * 0.15);
    return pages.filter((page) => page.chars < threshold).map((page) => page.page);
  }

  function buildGapPrompt(pages, total) {
    const suspicious = new Set(heuristicOcrPages(pages));
    const previewLimit = 160;
    const rows = [];
    let budget = 26000;

    for (const page of pages) {
      if (budget <= 0) break;
      const preview = page.text.replace(/\s+/g, " ").slice(0, previewLimit);
      const showPreview = suspicious.has(page.page) || page.page <= 40 || page.page % 25 === 0;
      const row = showPreview
        ? `p${page.page}: ${page.chars} chars | ${preview}`
        : `p${page.page}: ${page.chars} chars`;
      rows.push(row);
      budget -= row.length + 1;
    }

    return [
      "You are auditing the text layer extracted from a PDF before it becomes a study document.",
      `The document has ${total} page(s). Below is one line per page: page number, characters extracted, and (for some pages) the start of the text.`,
      "Decide whether any page's content is missing or too damaged to study:",
      "- 0 or near-0 characters on a page that should have content (scans, images, vector text).",
      "- Text that is only a fragment, a header/footer, page numbers, or gibberish.",
      "- A sharp drop versus neighbouring pages.",
      "Pages in this PDF will be re-processed with OCR only if you list them.",
      "",
      "PAGES:",
      rows.join("\n"),
      "",
      'Reply with ONLY this JSON object: {"needsOcr": true|false, "pages": [page numbers], "notes": "one short sentence"}',
      "Rules: pages must be integers within 1.." + total + "; list at most 200; if everything looks complete, use needsOcr false and an empty pages array.",
    ].join("\n");
  }

  /**
   * @param {{apiKey:string, pages:Array<{page:number,text:string,chars:number}>, total:number, signal?:AbortSignal, onProgress?:Function}} options
   * @returns {Promise<{pages:number[], notes:string, usedAi:boolean, capped:boolean}>}
   */
  async function analyseGaps({ apiKey, pages, total, signal, onProgress }) {
    const heuristic = heuristicOcrPages(pages);
    const allEmpty = pages.every((page) => page.chars === 0);

    if (allEmpty) {
      return {
        pages: pages.map((page) => page.page),
        notes: "No page in this PDF has an embedded text layer, so the whole document needs OCR.",
        usedAi: false,
        capped: false,
        remaining: [],
      };
    }

    if (!apiKey) {
      return {
        pages: heuristic,
        notes: heuristic.length
          ? "No API key set, so only pages with suspiciously little text were scheduled for OCR."
          : "No API key set. The text layer looks usable, so no OCR was scheduled.",
        usedAi: false,
        capped: false,
        remaining: [],
      };
    }

    if (onProgress) onProgress("Asking NVIDIA NIM whether any pages are missing content…");

    let chosen = heuristic;
    let notes = "";
    let usedAi = true;

    try {
      const { content } = await chat({
        apiKey,
        prompt: buildGapPrompt(pages, total),
        maxTokens: 700,
        temperature: 0.1,
        signal,
        onRetry: (error, attempt) => {
          if (onProgress) onProgress(`NIM busy (${error.status || "network"}); retry ${attempt}/${MAX_RETRIES}…`);
        },
      });

      const parsed = parseJsonLoose(content);
      if (parsed && Array.isArray(parsed.pages)) {
        const aiPages = parsed.pages
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value >= 1 && value <= total);
        // The model decides which damaged pages need OCR, but a page with no
        // text at all is always OCR'd: no text layer means no content, whatever
        // the model says.
        const emptyPages = pages.filter((page) => page.chars === 0).map((page) => page.page);
        chosen = Array.from(new Set([...aiPages, ...emptyPages])).sort((a, b) => a - b);
        notes = typeof parsed.notes === "string" ? parsed.notes.trim() : "";
      } else {
        usedAi = false;
        notes = "The model's page report could not be read; only pages with little text were scheduled for OCR.";
      }
    } catch (error) {
      if (error && error.name === "AbortError") throw error;
      usedAi = false;
      notes = `Gap check failed (${describeError(error)}). Only pages with little text were scheduled for OCR.`;
    }

    const capped = chosen.length > MAX_OCR_PAGES;
    const limited = capped ? chosen.slice(0, MAX_OCR_PAGES) : chosen;
    if (capped) {
      notes += ` Only the first ${MAX_OCR_PAGES} of ${chosen.length} flagged pages were queued.`;
    }
    if (!notes) {
      notes = limited.length
        ? `${limited.length} page(s) look like they are missing text and will be OCR'd.`
        : "The embedded text layer looks complete; no OCR needed.";
    }

    return { pages: limited, remaining: capped ? chosen.slice(MAX_OCR_PAGES) : [], notes, usedAi, capped };
  }

  /* ------------------------------------------------------------------ *
   * Study document generation
   * ------------------------------------------------------------------ */

  function buildDocumentPrompt({ sourceText, part, total, title, subject, sourceType, language }) {
    const rules = [
      "You are an expert study-notes editor preparing material for a student.",
      "TASK: convert the source text into one complete, well-structured study document in Markdown.",
      "REQUIREMENTS:",
      "- Cover ALL substantive content. Keep the detail; do not compress it into a summary or skip sections.",
      "- Start with a level-1 heading for the topic. Use level-2 headings for major topics and level-3 for detail.",
      "- Prefer short paragraphs and bullet points over long prose. Keep every definition, formula, date, name, example and worked step.",
      "- Correct obvious OCR damage when the intended wording is clear; mark genuinely unreadable text as [unclear].",
      "- Never invent facts, statistics, quotations or citations that the source does not support.",
      "- Do not mention these instructions, and do not address the reader directly.",
      "- Output Markdown only. No preamble, no closing remarks, no code fences around the whole answer.",
    ];

    if (sourceType === "text") {
      rules.push(
        "- The source is text pasted by hand and may be unstructured; reorganise it into clear topics without losing information.",
      );
    } else {
      rules.push(
        "- The source was extracted from a PDF; some pages may be OCR output with imperfect spacing. Preserve the original structure where it is clear.",
      );
    }

    if (subject) rules.push(`- The study kit is about: ${subject}.`);
    if (language) rules.push(`- Keep the source language (${language}).`);
    if (total > 1) {
      rules.push(
        `- This is part ${part} of ${total} of the source. Cover only this part; the app joins the parts afterwards. Do not add an overall introduction or conclusion.`,
      );
    }

    return [
      ...rules,
      "",
      title ? `DOCUMENT TITLE: ${title}` : "",
      total > 1 ? `PART: ${part} of ${total}` : "",
      "",
      "SOURCE TEXT:",
      sourceText,
    ]
      .filter(Boolean)
      .join("\n");
  }

  /**
   * @returns {Promise<{markdown:string, truncatedParts:number[], parts:number}>}
   */
  async function generateDocument({ apiKey, text, meta = {}, signal, onProgress }) {
    const chunks = splitIntoChunks(text, CHUNK_SIZE);
    if (!chunks.length) throw new Error("There is no text to turn into a document.");

    const sections = [];
    const truncatedParts = [];

    for (let index = 0; index < chunks.length; index++) {
      if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (onProgress) {
        onProgress({
          message:
            chunks.length > 1
              ? `Writing the study document — part ${index + 1} of ${chunks.length}…`
              : "Writing the study document…",
          part: index + 1,
          total: chunks.length,
        });
      }

      const prompt = buildDocumentPrompt({
        sourceText: chunks[index],
        part: index + 1,
        total: chunks.length,
        title: meta.title,
        subject: meta.subject,
        sourceType: meta.sourceType,
        language: meta.language,
      });

      const { content, truncated } = await chat({
        apiKey,
        prompt,
        maxTokens: MAX_TOKENS,
        temperature: 0.3,
        signal,
        onRetry: (error, attempt) => {
          if (onProgress) {
            onProgress({
              message: `NIM busy (${error.status || "network"}); retry ${attempt}/${MAX_RETRIES}…`,
              part: index + 1,
              total: chunks.length,
            });
          }
        },
      });

      if (truncated) truncatedParts.push(index + 1);
      sections.push(
        chunks.length > 1 && !/^#\s/m.test(content) && !/^##\s/m.test(content)
          ? `## Part ${index + 1}\n\n${content}`
          : content,
      );
    }

    return {
      markdown: sections.join("\n\n").trim(),
      truncatedParts,
      parts: chunks.length,
    };
  }

  /* ------------------------------------------------------------------ *
   * Practice questions
   * ------------------------------------------------------------------ */

  function buildQuestionsPrompt(document, count, difficulty, options = {}) {
    const single = Boolean(options.sourceName);
    const exam = options.style === "exam";
    const lines = [
      single
        ? `You are writing practice questions for a student, based only on the study document for one resource of a study kit: "${options.sourceName}".`
        : "You are writing practice questions for a student, based only on the study document below.",
      single
        ? `Write exactly ${count} question(s) about THIS resource. Another pass covers the kit's other resources, so do not stray from this material.`
        : `Create ${count} questions that spread evenly across the material, starting with foundational recall and ending with applied reasoning.`,
      single && options.sourceCount > 1
        ? `This is one of ${options.sourceCount} resources in the kit; questions must be answerable from this document alone.`
        : "",
      exam
        ? "This is a TIMED PRACTICE EXAM. Every question must be multiple choice with exactly 4 options and one correct answer — no short-answer questions."
        : "Mix the formats:",
      exam
        ? "Write exam-style questions: applied reasoning, comparisons and multi-step problems rather than simple definitions. Difficulty should be uniform and representative of a real exam."
        : "- about 60% multiple choice with exactly 4 options and one correct answer;",
      exam ? "" : "- about 40% short answer with a model answer of 1–3 sentences.",
      count === 1 ? "- One question only: pick the single most important idea in the material." : "",
      "Rules:",
      "- Every question must be answerable from the document alone.",
      "- Do not copy sentences verbatim; test understanding.",
      "- Distractors must be plausible and clearly wrong to someone who knows the material.",
      "- No duplicate questions, no trick questions, no 'all of the above'.",
      difficulty ? `- Target difficulty: ${difficulty}.` : "",
      "",
      "Reply with ONLY this JSON object:",
      exam
        ? '{"questions":[{"type":"mcq","question":"...","options":["A","B","C","D"],"answerIndex":0,"explanation":"..."}]}'
        : '{"questions":[{"type":"mcq","question":"...","options":["A","B","C","D"],"answerIndex":0,"explanation":"..."},{"type":"short","question":"...","answer":"...","explanation":"..."}]}',
      "",
      "STUDY DOCUMENT:",
      document,
    ];
    return lines.filter(Boolean).join("\n");
  }

  function normaliseQuestions(raw, count) {
    if (!raw || !Array.isArray(raw.questions)) return [];
    const questions = [];

    for (const item of raw.questions) {
      if (!item || typeof item !== "object" || typeof item.question !== "string") continue;
      const question = item.question.trim();
      if (!question) continue;

      if (item.type === "mcq" && Array.isArray(item.options)) {
        const options = item.options
          .filter((option) => typeof option === "string" && option.trim())
          .map((option) => option.trim())
          .slice(0, 4);
        if (options.length < 2) continue;
        const answerIndex = Number.isInteger(item.answerIndex) ? item.answerIndex : 0;
        questions.push({
          type: "mcq",
          question,
          options,
          answerIndex: answerIndex >= 0 && answerIndex < options.length ? answerIndex : 0,
          answer: "",
          explanation: typeof item.explanation === "string" ? item.explanation.trim() : "",
        });
      } else {
        const answer = typeof item.answer === "string" ? item.answer.trim() : "";
        if (!answer) continue;
        questions.push({
          type: "short",
          question,
          options: [],
          answerIndex: 0,
          answer,
          explanation: typeof item.explanation === "string" ? item.explanation.trim() : "",
        });
      }
      if (questions.length >= count) break;
    }

    return questions;
  }

  /**
   * @returns {Promise<Array<object>>}
   */
  async function generateQuestions({ apiKey, document, count = 10, difficulty = "", signal, onProgress, sourceName, sourceCount, partLabel, style = "" }) {
    const trimmed = String(document).slice(0, MAX_QUIZ_SOURCE_CHARS + 2000);
    // Quotas can legitimately be small (one resource of a large kit), so only
    // clamp to the API's sane range instead of forcing a minimum of four.
    const askCount = Math.max(1, Math.min(Math.floor(count) || 1, 25));

    if (onProgress) {
      onProgress(
        partLabel
          ? `Writing ${askCount} question(s) for ${partLabel}…`
          : `Writing ${askCount} practice questions…`,
      );
    }

    const { content } = await chat({
      apiKey,
      prompt: buildQuestionsPrompt(trimmed, askCount, difficulty, { sourceName, sourceCount, style }),
      maxTokens: MAX_TOKENS,
      temperature: 0.5,
      signal,
      onRetry: (error, attempt) => {
        if (onProgress) onProgress(`NIM busy (${error.status || "network"}); retry ${attempt}/${MAX_RETRIES}…`);
      },
    });

    const parsed = parseJsonLoose(content);
    let questions = normaliseQuestions(parsed, askCount);
    if (style === "exam") {
      // A timed exam is marked automatically, so only keep choice questions.
      questions = questions.filter((question) => question.type === "mcq" && question.options.length >= 2);
    }
    if (!questions.length) {
      throw new Error("The model did not return usable questions for this material.");
    }
    return questions;
  }

  /* ------------------------------------------------------------------ *
   * Marking short answers
   * ------------------------------------------------------------------ */

  const MARK_STOPWORDS = new Set([
    "the","a","an","of","to","in","is","are","was","were","be","been","and","or","for","on","with",
    "that","this","it","as","at","by","from","which","its","their","they","them","has","have","had",
    "can","will","would","should","may","might","into","than","then","so","such","also","when","where",
    "what","who","why","how","not","no","but","if","because","about","between","using","use","used",
  ]);

  /** Content words of an answer, used for the offline fallback marker. */
  function keywords(text) {
    return new Set(
      String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s'-]/g, " ")
        .split(/\s+/)
        .filter((word) => word.length > 2 && !MARK_STOPWORDS.has(word))
        .map((word) => word.replace(/(ing|ed|es|s)$/, "")),
    );
  }

  /**
   * Mark a short answer without the model, so a quiz can still be completed
   * offline or when the AI call fails. Approximate by design: it rewards
   * overlap with the key ideas of the model answer.
   */
  function localGradeShortAnswer({ answer, response }) {
    const expected = keywords(answer);
    const given = keywords(response);
    const cleaned = (value) =>
      String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

    if (cleaned(response) && cleaned(response) === cleaned(answer)) {
      return { score: 1, correct: true, feedback: "Exact match with the model answer.", markedBy: "offline" };
    }
    if (!expected.size) {
      return {
        score: 0,
        correct: false,
        feedback: "There is no model answer to compare against, so this could not be marked.",
        markedBy: "offline",
      };
    }
    let hits = 0;
    for (const word of expected) if (given.has(word)) hits += 1;
    const score = hits / expected.size;
    const correct = score >= 0.55;
    return {
      score,
      correct,
      feedback: correct
        ? `Covers the key idea (${Math.round(score * 100)}% of the key terms). Add your AI key for a fuller review.`
        : `Missing key ideas from the model answer (${Math.round(score * 100)}% of key terms matched). Add your AI key for a fuller review.`,
      markedBy: "offline",
    };
  }

  function buildMarkPrompt({ question, answer, response }) {
    return [
      "You are marking one short-answer question for a student.",
      "Mark on MEANING, not exact wording. Accept paraphrases, synonyms, abbreviations, different",
      "ordering, extra correct detail, and equivalent terminology. Reject answers that contradict",
      "the model answer or leave out its key idea.",
      "",
      `Question: ${question}`,
      `Model answer: ${answer}`,
      `Student answer: ${response}`,
      "",
      "Reply with ONLY this JSON object:",
      '{"score":0,"correct":false,"feedback":"..."}',
      "- score is 0-100, the share of the model answer's meaning the student got.",
      "- correct is true when score is at least 60.",
      "- feedback is 1-2 sentences: what was right, and what is missing if anything.",
    ].join("\n");
  }

  /**
   * Mark a short-answer response with the model, falling back to the offline
   * marker when no key is set or the request fails.
   *
   * @returns {Promise<{score:number, correct:boolean, feedback:string, markedBy:string}>}
   */
  async function gradeShortAnswer({ apiKey, question, answer, response, signal }) {
    const text = String(response || "").trim();
    if (!text) {
      return {
        score: 0,
        correct: false,
        feedback: "No answer was entered.",
        markedBy: "offline",
      };
    }
    if (!apiKey) return localGradeShortAnswer({ answer, response: text });

    try {
      const { content } = await chat({
        apiKey,
        prompt: buildMarkPrompt({ question, answer, response: text }),
        maxTokens: 512,
        temperature: 0,
        signal,
      });
      const parsed = parseJsonLoose(content) || {};
      let score = Number(parsed.score);
      if (!Number.isFinite(score)) score = parsed.correct === true ? 100 : 0;
      if (score > 1 && score <= 100) score = score / 100;
      score = Math.max(0, Math.min(1, score));
      // Respect an explicit pass/fail verdict from the model, but keep them
      // consistent with the score.
      const correct = typeof parsed.correct === "boolean" ? parsed.correct : score >= 0.6;
      const feedback =
        typeof parsed.feedback === "string" && parsed.feedback.trim()
          ? parsed.feedback.trim()
          : correct
            ? "Accepted — this matches the model answer."
            : "Not quite — compare with the model answer.";
      return { score, correct: correct && score > 0, feedback, markedBy: "ai" };
    } catch (error) {
      if (error && error.name === "AbortError") throw error;
      console.warn("[StudyForge] AI marking failed; using the offline marker.", error);
      const fallback = localGradeShortAnswer({ answer, response: text });
      fallback.feedback = `AI marking was unavailable (${describeError(error)}). ${fallback.feedback}`;
      return fallback;
    }
  }

  /* ------------------------------------------------------------------ *
   * Flashcards
   * ------------------------------------------------------------------ */

  /**
   * Flashcard prompt in one of two styles:
   *   "vocab"    — front is a term/concept, back is its definition or explanation.
   *   "question" — front is a question, back is the answer.
   */
  function buildFlashcardsPrompt(document, count, options = {}) {
    const single = Boolean(options.sourceName);
    const vocab = options.style !== "question";
    const common = [
      single
        ? `You are writing revision flashcards for one resource of a study kit: "${options.sourceName}".`
        : "You are writing revision flashcards for a student, based only on the study document below.",
      `Write exactly ${count} flashcard(s) from this material.`,
      "- One fact, definition, process or relationship per card — no compound cards.",
      "- No yes/no cards, no trivia, no duplicates, no 'all of the above'.",
      "- Prefer the ideas a student must be able to recall under exam pressure.",
      count === 1 ? "- One card only: choose the single most important idea." : "",
    ];

    const style = vocab
      ? [
          "DECK STYLE: vocabulary and concepts.",
          "The FRONT is the term, name or concept to recall — a short label, not a question and not a full sentence. Do not end the front with a question mark.",
          'Example front: "Osmosis". Example back: "Net movement of water across a semi-permeable membrane from low to high solute concentration."',
          "The BACK is a precise definition or one-or-two-sentence explanation of that term.",
          "- Never put the answer inside the front, and never use fill-in-the-blank with a blanked-out word.",
        ]
      : [
          "DECK STYLE: exam-style questions.",
          "The FRONT is an actual question a student could be asked — it must end with a question mark and be answerable without extra context.",
          'Example front: "Why does water move into a cell placed in a hypotonic solution?".',
          "The BACK is the model answer, one or two sentences, complete enough to mark against.",
          "- Never give the answer away in the question, and never ask two questions in one card.",
        ];

    return [
      ...common.slice(0, 2),
      ...style,
      "Each card is a single JSON object with a front and a back.",
      "",
      ...common.slice(2),
      "",
      "Reply with ONLY this JSON object:",
      '{"cards":[{"front":"...","back":"..."}]}',
      "",
      "STUDY DOCUMENT:",
      document,
    ]
      .filter(Boolean)
      .join("\n");
  }

  function normaliseFlashcards(raw, count) {
    if (!raw || !Array.isArray(raw.cards)) return [];
    const cards = [];
    for (const item of raw.cards) {
      if (!item || typeof item !== "object") continue;
      const front = typeof item.front === "string" ? item.front.trim() : "";
      const back = typeof item.back === "string" ? item.back.trim() : "";
      if (!front || !back) continue;
      cards.push({ front, back });
      if (cards.length >= count) break;
    }
    return cards;
  }

  async function generateFlashcards({ apiKey, document, count = 10, style = "vocab", signal, onProgress, sourceName, sourceCount, partLabel }) {
    const trimmed = String(document).slice(0, MAX_QUIZ_SOURCE_CHARS + 2000);
    const askCount = Math.max(1, Math.min(Math.floor(count) || 1, 40));

    if (onProgress) {
      onProgress(
        partLabel ? `Writing ${askCount} flashcard(s) for ${partLabel}…` : `Writing ${askCount} flashcards…`,
      );
    }

    const { content } = await chat({
      apiKey,
      prompt: buildFlashcardsPrompt(trimmed, askCount, { sourceName, sourceCount, style }),
      maxTokens: MAX_TOKENS,
      temperature: 0.4,
      signal,
      onRetry: (error, attempt) => {
        if (onProgress) onProgress(`NIM busy (${error.status || "network"}); retry ${attempt}/${MAX_RETRIES}…`);
      },
    });

    const cards = normaliseFlashcards(parseJsonLoose(content), askCount);
    if (!cards.length) {
      throw new Error("The model did not return usable flashcards for this material.");
    }
    return cards;
  }

  /* ------------------------------------------------------------------ *
   * Quiz planning
   *
   * A single prompt containing every document makes models drift towards one
   * resource. Instead the kit's questions are allocated per resource, each is
   * generated in its own request, and the results are merged.
   * ------------------------------------------------------------------ */

  /**
   * Split `count` questions across `sources` ({ id, name, length }).
   *
   * Every resource gets at least one question when there are enough to go
   * round; the rest are shared in proportion to document length using the
   * largest-remainder method, so quotas always add up to `count`.
   */
  function planQuizAllocation(sources, count) {
    const list = (sources || [])
      .filter((source) => source && source.id)
      .map((source) => ({
        id: source.id,
        name: source.name || "Untitled resource",
        weight: Math.max(1, Number(source.length) || 0),
      }));

    // Callers clamp to their own maximum (25 questions, 40 cards or exam
    // questions); this is only a safety ceiling.
    const total = Math.max(1, Math.min(Math.floor(count) || 1, 60));
    if (!list.length) return [];

    // Fewer questions than resources: give them to the largest documents.
    if (total < list.length) {
      return [...list]
        .sort((a, b) => b.weight - a.weight)
        .slice(0, total)
        .map((source) => ({ id: source.id, name: source.name, quota: 1 }));
    }

    const entries = list.map((source) => ({ ...source, quota: 1 }));
    let remaining = total - entries.length;
    const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);

    if (remaining > 0) {
      const shares = entries.map((entry) => {
        const exact = (entry.weight / totalWeight) * remaining;
        return { entry, base: Math.floor(exact), rest: exact - Math.floor(exact) };
      });

      for (const share of shares) share.entry.quota += share.base;
      remaining -= shares.reduce((sum, share) => sum + share.base, 0);

      // Hand out any rounding leftovers to the largest fractional parts.
      for (const share of [...shares].sort((a, b) => b.rest - a.rest)) {
        if (remaining <= 0) break;
        share.entry.quota += 1;
        remaining -= 1;
      }
    }

    return entries
      .sort((a, b) => b.quota - a.quota)
      .map((entry) => ({ id: entry.id, name: entry.name, quota: entry.quota }));
  }

  /** Normalised key used to spot near-identical questions across resources. */
  function questionKey(question) {
    return String(question || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Drop items whose key repeats one already kept (per resource, then merged). */
  function dedupeBy(items, keyOf) {
    const seen = new Set();
    const kept = [];
    for (const item of items || []) {
      const key = questionKey(keyOf(item));
      if (!key || seen.has(key)) continue;
      seen.add(key);
      kept.push(item);
    }
    return kept;
  }

  function dedupeQuestions(items) {
    return dedupeBy(items, (item) => item && item.question);
  }

  function dedupeFlashcards(cards) {
    return dedupeBy(cards, (card) => card && card.front);
  }

  /** Round-robin merge so the set is not ordered by resource. */
  function interleaveQuestionGroups(groups) {
    const buckets = (groups || []).map((group) => [...(group || [])]);
    const merged = [];
    let added = true;
    while (added) {
      added = false;
      for (const bucket of buckets) {
        if (bucket.length) {
          merged.push(bucket.shift());
          added = true;
        }
      }
    }
    return merged;
  }

  StudyForge.ai = {
    WORKER_URL,
    DEFAULT_MODEL,
    MODEL_FILTER,
    currentModel,
    listModels,
    matchesModelFilter,
    CHUNK_SIZE,
    MAX_OCR_PAGES,
    MAX_QUIZ_SOURCE_CHARS,
    chat,
    describeError,
    splitIntoChunks,
    parseJsonLoose,
    heuristicOcrPages,
    analyseGaps,
    generateDocument,
    generateQuestions,
    normaliseQuestions,
    gradeShortAnswer,
    localGradeShortAnswer,
    generateFlashcards,
    normaliseFlashcards,
    buildFlashcardsPrompt,
    dedupeFlashcards,
    planQuizAllocation,
    dedupeQuestions,
    interleaveQuestionGroups,
    questionKey,
  };
})((window.StudyForge = window.StudyForge || {}));
