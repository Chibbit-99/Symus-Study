/**
 * Symus Study — NVIDIA NIM client.
 *
 * All requests go through the Symus Cloudflare Worker
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
(function (Symus) {
  "use strict";

  // arch/init.js exports SYMUS_CONFIG, which ARCH.js places on globalThis.
  const CONFIG = globalThis.SYMUS_CONFIG || {};
  const WORKER_URL = CONFIG.workerUrl || "https://symus-backend.chibbit99.workers.dev";
  const MODEL = CONFIG.model || "nvidia/nemotron-3.5-lightning-30b-a3b";

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
        model: MODEL,
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
      return "The request was refused (403). If the app is served from a new origin, update SYMUS_ORIGIN on the Worker.";
    }
    if (error.status === 404) return "The model is not available to this key (404).";
    if (error.status === 429) return "Rate limited by NVIDIA (429). Wait a moment and retry.";
    const base = error.message || String(error);
    return error.detail ? `${base} ${error.detail}` : base;
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

  function buildQuestionsPrompt(document, count, difficulty) {
    return [
      "You are writing practice questions for a student, based only on the study document below.",
      `Create ${count} questions that spread evenly across ALL of the material below, starting with foundational recall and ending with applied reasoning.`,
      "The material may combine several resources from one study kit, each introduced by a '## Resource:' heading.",
      "Cover every resource that has enough content to question, in proportion to its size. Never ask about a single resource only.",
      "Mix the formats:",
      "- about 60% multiple choice with exactly 4 options and one correct answer;",
      "- about 40% short answer with a model answer of 1–3 sentences.",
      "Rules:",
      "- Every question must be answerable from the document alone.",
      "- Do not copy sentences verbatim; test understanding.",
      "- Distractors must be plausible and clearly wrong to someone who knows the material.",
      "- No duplicate questions, no trick questions, no 'all of the above'.",
      difficulty ? `- Target difficulty: ${difficulty}.` : "",
      "",
      'Reply with ONLY this JSON object:',
      '{"questions":[{"type":"mcq","question":"...","options":["A","B","C","D"],"answerIndex":0,"explanation":"..."},{"type":"short","question":"...","answer":"...","explanation":"..."}]}',
      "",
      "STUDY DOCUMENT:",
      document,
    ]
      .filter(Boolean)
      .join("\n");
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
  async function generateQuestions({ apiKey, document, count = 10, difficulty = "", signal, onProgress }) {
    const trimmed = String(document).slice(0, MAX_QUIZ_SOURCE_CHARS + 2000);
    const askCount = Math.min(Math.max(count, 4), 25);

    if (onProgress) onProgress(`Writing ${askCount} practice questions…`);

    const { content } = await chat({
      apiKey,
      prompt: buildQuestionsPrompt(trimmed, askCount, difficulty),
      maxTokens: MAX_TOKENS,
      temperature: 0.5,
      signal,
      onRetry: (error, attempt) => {
        if (onProgress) onProgress(`NIM busy (${error.status || "network"}); retry ${attempt}/${MAX_RETRIES}…`);
      },
    });

    const parsed = parseJsonLoose(content);
    const questions = normaliseQuestions(parsed, askCount);
    if (!questions.length) {
      throw new Error("The model did not return usable questions. Try again or rephrase the source.");
    }
    return questions;
  }

  Symus.ai = {
    WORKER_URL,
    MODEL,
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
  };
})((window.Symus = window.Symus || {}));
