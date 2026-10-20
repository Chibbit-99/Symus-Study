/**
 * Symus Study — interface
 *
 * Hash routes:
 *   #/                 dashboard (classes + study kits)
 *   #/kit/<id>         a study kit: add PDFs / pasted text, see resources
 *   #/resource/<id>    one resource: study document + practice questions
 *
 * Rendering is a full rebuild of #view on store changes; user drafts in
 * textareas are captured and restored around it so typing is never lost.
 */
(function (Symus) {
  "use strict";

  const store = Symus.store;
  const md = Symus.md;
  const jobs = Symus.jobs;
  const esc = md.escapeHtml;

  const STATUS_LABEL = {
    queued: "Queued",
    processing: "Processing",
    ready: "Ready",
    error: "Failed",
  };

  let els = {};
  let route = { name: "dashboard", id: null };
  let filterClassId = null;
  let query = "";
  let editingDocId = null;
  let docViewId = null;
  let quizState = { selected: {}, revealed: {} };
  let renderQueued = false;
  let pendingReprocessId = null;
  let lastQuizKey = null;

  const $ = (id) => document.getElementById(id);

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  function relativeTime(iso) {
    if (!iso) return "never";
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return "unknown";
    const diff = Math.round((then - Date.now()) / 1000);
    const units = [
      ["year", 31536000],
      ["month", 2592000],
      ["week", 604800],
      ["day", 86400],
      ["hour", 3600],
      ["minute", 60],
    ];
    for (const [unit, seconds] of units) {
      if (Math.abs(diff) >= seconds) {
        const value = Math.round(diff / seconds);
        const formatted = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(value, unit);
        return formatted;
      }
    }
    return "just now";
  }

  const plural = (count, singular, pluralForm = singular + "s") =>
    `${count} ${count === 1 ? singular : pluralForm}`;

  function firstLine(text, fallback = "Pasted text") {
    const line = String(text).split("\n").map((part) => part.trim()).find(Boolean);
    if (!line) return fallback;
    return line.length > 70 ? line.slice(0, 67).trimEnd() + "…" : line;
  }

  function fileTitle(name) {
    return name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim() || name;
  }

  function navigate(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  function parseRoute() {
    const hash = location.hash.replace(/^#\/?/, "");
    const parts = hash.split("/").filter(Boolean);
    if (parts[0] === "kit" && parts[1]) {
      const tab = parts[2] === "documents" || parts[2] === "questions" ? parts[2] : "resources";
      route = { name: "kit", id: parts[1], tab };
    } else if (parts[0] === "resource" && parts[1]) {
      route = { name: "resource", id: parts[1] };
    } else {
      route = { name: "dashboard", id: null };
    }
  }

  function requireKey() {
    if (store.getApiKey()) return true;
    openSettings("Add your NVIDIA NIM API key first — it is used for every AI step.");
    return false;
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function captureDrafts() {
    const drafts = {};
    let focusKey = null;
    for (const el of els.view.querySelectorAll("[data-draft]")) {
      drafts[el.dataset.draft] = el.value;
      if (document.activeElement === el) focusKey = el.dataset.draft;
    }
    return { drafts, focusKey };
  }

  function restoreDrafts(snapshot) {
    if (!snapshot) return;
    for (const [key, value] of Object.entries(snapshot.drafts)) {
      const el = els.view.querySelector(`[data-draft="${key}"]`);
      if (el) el.value = value;
    }
    if (snapshot.focusKey) {
      const el = els.view.querySelector(`[data-draft="${snapshot.focusKey}"]`);
      if (el) {
        el.focus();
        el.setSelectionRange?.(el.value.length, el.value.length);
      }
    }
  }

  function render() {
    parseRoute();
    const snapshot = captureDrafts();
    els.view.innerHTML = "";

    if (route.name === "kit") {
      const kit = store.getKit(route.id);
      if (kit && route.id !== lastQuizKey) {
        // Fresh kit: reset in-page interactions so answers and the document
        // picker do not leak between kits.
        lastQuizKey = route.id;
        quizState = { selected: {}, revealed: {} };
        docViewId = null;
      }
      els.view.appendChild(
        kit ? renderKit(kit, route.tab) : renderMissing("That study kit no longer exists."),
      );
    } else if (route.name === "resource") {
      const resource = store.getResource(route.id);
      els.view.appendChild(resource ? renderResource(resource) : renderMissing("That resource no longer exists."));
    } else {
      els.view.appendChild(renderDashboard());
    }

    restoreDrafts(snapshot);
    renderSidebar();
    renderStorage();
  }

  function renderMissing(message) {
    const wrap = document.createElement("div");
    wrap.className = "page";
    wrap.innerHTML = `
      <div class="empty">
        <h2>Not found</h2>
        <p class="muted">${esc(message)}</p>
        <a class="btn primary" href="#/">Back to dashboard</a>
      </div>`;
    return wrap;
  }

  function renderSidebar() {
    const state = store.get();
    const totalKits = state.kits.length;
    const rows = [
      `<button class="nav-item ${filterClassId ? "" : "active"}" data-action="filter-class" data-id="">
        <span>All study kits</span><span class="count">${totalKits}</span>
      </button>`,
      ...state.classes.map((cls) => {
        const count = state.kits.filter((kit) => kit.classId === cls.id).length;
        return `<button class="nav-item ${filterClassId === cls.id ? "active" : ""}" data-action="filter-class" data-id="${esc(cls.id)}">
          <span>${esc(cls.name)}</span><span class="count">${count}</span>
        </button>`;
      }),
      `<button class="nav-item nav-add" data-action="new-class"><span>+ New class</span></button>`,
    ];
    els.nav.innerHTML = rows.join("");
  }

  function renderStorage() {
    const bytes = store.storageBytes();
    const limit = 5 * 1024 * 1024;
    const percent = Math.min(100, Math.round((bytes / limit) * 100));
    const error = store.getStorageError();
    els.storage.innerHTML = `
      <div class="storage-row"><span>Local storage</span><strong>${(bytes / 1024).toFixed(0)} KB</strong></div>
      <div class="meter"><span style="width:${percent}%"></span></div>
      ${error ? '<p class="tiny danger">Storage is full — export a backup and delete old resources.</p>' : ""}`;
  }

  /* ------------------------------ dashboard ------------------------ */

  function renderDashboard() {
    const state = store.get();
    const page = document.createElement("div");
    page.className = "page";

    const matches = (kit) => {
      if (!query) return true;
      const needle = query.toLowerCase();
      if (kit.name.toLowerCase().includes(needle)) return true;
      if (kit.subject.toLowerCase().includes(needle)) return true;
      return state.resources.some(
        (resource) => resource.kitId === kit.id && resource.name.toLowerCase().includes(needle),
      );
    };

    const visibleKits = state.kits.filter(matches);
    const classes = filterClassId ? state.classes.filter((cls) => cls.id === filterClassId) : state.classes;
    const uncategorised = visibleKits.filter((kit) => !kit.classId);

    page.innerHTML = `
      <header class="page-head">
        <div>
          <p class="eyebrow">${filterClassId ? "Class" : "Dashboard"}</p>
          <h1>${esc(filterClassId ? (store.getClass(filterClassId) || {}).name || "Study kits" : "Study kits")}</h1>
          <p class="muted">${plural(state.kits.length, "kit")} across ${plural(state.classes.length, "class", "classes")} · ${plural(state.resources.length, "resource")}</p>
        </div>
        <div class="row">
          <button class="btn" data-action="new-class">New class</button>
          <button class="btn primary" data-action="new-kit">New study kit</button>
        </div>
      </header>
      ${state.kits.length === 0 ? renderEmptyDashboard() : ""}
      <div class="stack">
        ${classes
          .map((cls) => {
            const kits = visibleKits.filter((kit) => kit.classId === cls.id);
            if (!kits.length && query) return "";
            return `
              <section class="class-group">
                <header class="class-head">
                  <div class="row tight">
                    <h2>${esc(cls.name)}</h2>
                    <span class="count">${state.kits.filter((kit) => kit.classId === cls.id).length}</span>
                  </div>
                  <div class="row tight">
                    <button class="btn ghost small" data-action="rename-class" data-id="${esc(cls.id)}">Rename</button>
                    <button class="btn ghost small danger" data-action="delete-class" data-id="${esc(cls.id)}">Delete</button>
                  </div>
                </header>
                ${
                  kits.length
                    ? `<div class="grid">${kits.map(renderKitCard).join("")}</div>`
                    : `<p class="muted small">No kits in this class yet.</p>`
                }
              </section>`;
          })
          .join("")}
        ${
          uncategorised.length
            ? `<section class="class-group">
                <header class="class-head"><div class="row tight"><h2>Uncategorised</h2><span class="count">${uncategorised.length}</span></div></header>
                <div class="grid">${uncategorised.map(renderKitCard).join("")}</div>
              </section>`
            : ""
        }
        ${
          state.kits.length && !visibleKits.length
            ? `<div class="empty"><h2>No matches</h2><p class="muted">Nothing matches “${esc(query)}”.</p></div>`
            : ""
        }
      </div>`;
    return page;
  }

  function renderEmptyDashboard() {
    return `
      <div class="empty hero">
        <h2>Create your first study kit</h2>
        <p class="muted">A study kit holds resources — PDFs or pasted text. Symus Study turns each resource into a complete study document, then writes practice questions from it.</p>
        <div class="row center">
          <button class="btn primary" data-action="new-kit">New study kit</button>
          <button class="btn" data-action="new-class">New class</button>
        </div>
      </div>`;
  }

  function renderKitCard(kit) {
    const resources = store.resourcesInKit(kit.id);
    const ready = resources.filter((resource) => resource.status === "ready").length;
    const cls = kit.classId ? store.getClass(kit.classId) : null;
    return `
      <article class="card kit-card">
        <header class="card-head">
          <h3><a href="#/kit/${esc(kit.id)}">${esc(kit.name)}</a></h3>
          ${cls ? `<span class="chip">${esc(cls.name)}</span>` : ""}
        </header>
        ${kit.subject ? `<p class="muted small subject">${esc(kit.subject)}</p>` : ""}
        <p class="muted small">${plural(resources.length, "resource")} · ${ready} ready${
          kit.quiz ? ` · ${plural(kit.quiz.items.length, "question")}` : ""
        }<br>updated ${esc(relativeTime(kit.updatedAt))}</p>
        <footer class="card-foot">
          <a class="btn small primary" href="#/kit/${esc(kit.id)}">Open</a>
          <button class="btn ghost small" data-action="rename-kit" data-id="${esc(kit.id)}">Rename</button>
          <button class="btn ghost small" data-action="move-kit" data-id="${esc(kit.id)}">Move</button>
          <button class="btn ghost small danger" data-action="delete-kit" data-id="${esc(kit.id)}">Delete</button>
        </footer>
      </article>`;
  }

  /* -------------------------------- kit ---------------------------- */

  function kitTabs(kit, resources, activeTab) {
    const withDocs = resources.filter((resource) => resource.document);
    const tabs = [
      { id: "resources", label: "Resources", count: resources.length, href: `#/kit/${kit.id}` },
      { id: "documents", label: "Study documents", count: withDocs.length, href: `#/kit/${kit.id}/documents` },
      {
        id: "questions",
        label: "Practice questions",
        count: kit.quiz ? kit.quiz.items.length : 0,
        href: `#/kit/${kit.id}/questions`,
      },
    ];
    return `<nav class="tabs" role="tablist" aria-label="Study kit sections">${tabs
      .map(
        (tab) => `<a role="tab" aria-selected="${tab.id === activeTab}" class="tab ${
          tab.id === activeTab ? "active" : ""
        }" href="${tab.href}">${esc(tab.label)}<span class="count">${tab.count}</span></a>`,
      )
      .join("")}</nav>`;
  }

  function renderKit(kit, tab = "resources") {
    const resources = store.resourcesInKit(kit.id);
    const cls = kit.classId ? store.getClass(kit.classId) : null;
    const page = document.createElement("div");
    page.className = "page";

    page.innerHTML = `
      <nav class="crumbs"><a href="#/">Dashboard</a><span>/</span>${cls ? `<a href="#/">${esc(cls.name)}</a><span>/</span>` : ""}<span>${esc(kit.name)}</span></nav>
      <header class="page-head">
        <div>
          <h1>${esc(kit.name)}</h1>
          <p class="muted">${plural(resources.length, "resource")}${kit.subject ? " · " + esc(kit.subject) : ""}</p>
        </div>
        <div class="row">
          <button class="btn" data-action="edit-kit" data-id="${esc(kit.id)}">Edit details</button>
          <button class="btn danger" data-action="delete-kit" data-id="${esc(kit.id)}">Delete kit</button>
        </div>
      </header>
      ${kitTabs(kit, resources, tab)}
      ${
        tab === "documents"
          ? renderKitDocuments(kit, resources)
          : tab === "questions"
            ? renderKitQuestions(kit, resources)
            : renderKitResources(kit, resources)
      }`;
    return page;
  }

  function renderKitResources(kit, resources) {
    const settings = store.getSettings();
    return `
      <div class="kit-layout">
        <section class="panel">
          <h2>Add resources</h2>
          <div class="dropzone" data-dropzone>
            <p><strong>Drop PDFs here</strong></p>
            <p class="muted small">or</p>
            <button class="btn primary" data-action="pick-pdf">Choose PDF files</button>
            <p class="muted tiny">The text layer is read first; OCR is only used on pages that are missing text.</p>
          </div>

          <div class="divider"><span>or paste text</span></div>

          <div class="field">
            <label for="paste-title">Title (optional)</label>
            <input id="paste-title" data-draft="paste-title" type="text" placeholder="e.g. Lecture 4 — Photosynthesis">
          </div>
          <div class="field">
            <label for="paste-text">Text to turn into a study document</label>
            <textarea id="paste-text" data-draft="paste-text" rows="7" placeholder="Paste notes, an article, a transcript…"></textarea>
          </div>
          <div class="row">
            <button class="btn" data-action="add-text">Add pasted text</button>
          </div>
          <p class="muted tiny">AI settings: ${esc(settings.ocrLanguage)} OCR · ${settings.ocrScale}× render. ${store.getApiKey() ? "NIM key saved." : '<span class="danger">No NIM key yet.</span>'}</p>
        </section>

        <section class="panel">
          <div class="panel-head">
            <h2>Resources</h2>
            <span class="count">${resources.length}</span>
          </div>
          ${
            resources.length
              ? `<div class="res-list">${resources.map(renderResourceRow).join("")}</div>`
              : `<p class="muted small">No resources yet. Add a PDF or pasted text to get started.</p>`
          }
        </section>
      </div>`;
  }

  function renderKitDocuments(kit, resources) {
    const withDocs = resources.filter((resource) => resource.document);
    if (!withDocs.length) {
      return `
        <section class="panel">
          <div class="empty">
            <h3>No study documents yet</h3>
            <p class="muted">Every processed resource gets its own study document. Add a PDF or pasted text, or check a resource that failed.</p>
            <a class="btn primary" href="#/kit/${esc(kit.id)}">Add a resource</a>
          </div>
        </section>`;
    }

    const selected = withDocs.find((resource) => resource.id === docViewId) || withDocs[0];
    return `
      <div class="doc-layout">
        <section class="panel doc-side">
          <div class="panel-head"><h2>Documents</h2><span class="count">${withDocs.length}</span></div>
          <div class="doc-list">
            ${withDocs
              .map(
                (resource) => `
              <button class="doc-item ${resource.id === selected.id ? "active" : ""}" data-action="select-doc" data-id="${esc(resource.id)}">
                <span class="res-icon ${resource.type}">${resource.type === "pdf" ? "PDF" : "TXT"}</span>
                <span class="doc-item-main">
                  <span class="doc-item-name">${esc(resource.name)}</span>
                  <span class="muted tiny">${(resource.document.length / 1000).toFixed(1)}k chars · ${esc(relativeTime(resource.documentUpdatedAt))}</span>
                </span>
              </button>`,
              )
              .join("")}
          </div>
        </section>
        <section class="panel">
          <div class="panel-head">
            <h2>${esc(selected.name)}</h2>
            <div class="row tight">
              <a class="btn small" href="#/resource/${esc(selected.id)}">Open resource</a>
              <button class="btn small" data-action="copy-doc" data-id="${esc(selected.id)}">Copy</button>
              <button class="btn small" data-action="download-doc" data-id="${esc(selected.id)}">Download .md</button>
            </div>
          </div>
          <article class="md">${md.render(selected.document)}</article>
        </section>
      </div>`;
  }

  function renderKitQuestions(kit, resources) {
    const withDocs = resources.filter((resource) => resource.document);
    if (!withDocs.length) {
      return `
        <section class="panel">
          <div class="empty">
            <h3>No study documents yet</h3>
            <p class="muted">Questions are written from every study document in this kit, so at least one resource needs a document first.</p>
            <a class="btn primary" href="#/kit/${esc(kit.id)}">Add a resource</a>
          </div>
        </section>`;
    }

    const quiz = kit.quiz;
    const sources = quiz && quiz.sourceNames && quiz.sourceNames.length ? quiz.sourceNames : withDocs.map((r) => r.name);
    const missing = withDocs.length - (quiz && quiz.sourceCount ? quiz.sourceCount : 0);

    return `
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Practice questions</h2>
            <p class="muted tiny">Written from all ${plural(withDocs.length, "study document")} in this kit: ${esc(
              sources.join(", "),
            )}.</p>
          </div>
          <div class="row tight">
            <button class="btn small ${quiz ? "" : "primary"}" data-action="make-quiz" data-id="${esc(kit.id)}">${
              quiz ? "Regenerate" : "Generate questions"
            }</button>
            ${
              quiz
                ? `<button class="btn small" data-action="download-quiz" data-id="${esc(kit.id)}">Download .md</button>`
                : ""
            }
          </div>
        </div>
        ${quiz && missing > 0 ? `<div class="notice subtle">${plural(missing, "newer document")} not covered yet — regenerate to include them.</div>` : ""}
        ${quiz && quiz.truncated ? `<div class="notice subtle">The combined documents were long, so a proportional slice of each resource was used.</div>` : ""}
        ${renderKitQuiz(kit)}
      </section>`;
  }

  function renderKitQuiz(kit) {
    const quiz = kit.quiz;
    if (!quiz) {
      return `<p class="muted small">No questions yet. Generate a set and they will be saved with this study kit.</p>`;
    }

    const state = quizState;
    const items = quiz.items;
    const answered = Object.keys(state.selected).length + Object.keys(state.revealed).length;

    return `
      <div class="quiz-meta">
        <span class="muted tiny">${plural(items.length, "question")} · generated ${esc(relativeTime(quiz.generatedAt))} · ${answered} answered</span>
      </div>
      <ol class="quiz">
        ${items
          .map((item, index) => {
            if (item.type === "mcq") {
              const selected = state.selected[index];
              return `
                <li class="q">
                  <p class="q-text">${esc(item.question)}</p>
                  <div class="options">
                    ${item.options
                      .map((option, optionIndex) => {
                        let cls = "option";
                        if (selected !== undefined) {
                          if (optionIndex === item.answerIndex) cls += " correct";
                          else if (optionIndex === selected) cls += " wrong";
                        }
                        return `<button class="${cls}" data-action="answer-mcq" data-q="${index}" data-opt="${optionIndex}">
                          <span class="opt-letter">${String.fromCharCode(65 + optionIndex)}</span>
                          <span>${esc(option)}</span>
                        </button>`;
                      })
                      .join("")}
                  </div>
                  ${
                    selected !== undefined && item.explanation
                      ? `<p class="explanation">${esc(item.explanation)}</p>`
                      : ""
                  }
                </li>`;
            }
            const revealed = state.revealed[index];
            return `
              <li class="q">
                <p class="q-text">${esc(item.question)}</p>
                ${
                  revealed
                    ? `<p class="answer"><strong>Model answer:</strong> ${esc(item.answer)}</p>
                       ${item.explanation ? `<p class="explanation">${esc(item.explanation)}</p>` : ""}`
                    : `<button class="btn small" data-action="reveal" data-q="${index}">Show model answer</button>`
                }
              </li>`;
          })
          .join("")}
      </ol>`;
  }

  function renderResourceRow(resource) {
    const pages = resource.pages || {};
    const meta = [];
    if (resource.type === "pdf" && pages.total) {
      meta.push(`${pages.total} page(s)`);
      if (pages.ocrPages && pages.ocrPages.length) meta.push(`${pages.ocrPages.length} OCR'd`);
    }
    if (resource.document) meta.push(`${(resource.document.length / 1000).toFixed(1)}k chars`);

    return `
      <article class="res-row">
        <span class="res-icon ${resource.type}">${resource.type === "pdf" ? "PDF" : "TXT"}</span>
        <div class="res-main">
          <a class="res-name" href="#/resource/${esc(resource.id)}">${esc(resource.name)}</a>
          <p class="muted tiny">
            ${esc(resource.statusMessage || meta.join(" · ") || "Waiting to process")}
          </p>
        </div>
        <span class="badge ${esc(resource.status)}">${esc(STATUS_LABEL[resource.status] || resource.status)}</span>
        <button class="icon-btn danger" title="Delete" data-action="delete-resource" data-id="${esc(resource.id)}">×</button>
      </article>`;
  }

  /* ------------------------------ resource ------------------------- */

  function renderResource(resource) {
    const kit = store.getKit(resource.kitId);
    const pages = resource.pages || {};
    const processing = resource.status === "processing";
    const editing = editingDocId === resource.id;
    const page = document.createElement("div");
    page.className = "page";

    page.innerHTML = `
      <nav class="crumbs"><a href="#/">Dashboard</a><span>/</span><a href="#/kit/${esc(resource.kitId)}">${esc(kit ? kit.name : "Kit")}</a><span>/</span><span>${esc(resource.name)}</span></nav>
      <header class="page-head">
        <div>
          <h1>${esc(resource.name)}</h1>
          <p class="muted">
            <span class="badge ${esc(resource.status)}">${esc(STATUS_LABEL[resource.status] || resource.status)}</span>
            ${resource.type === "pdf" ? ` · PDF${pages.total ? ` · ${pages.total} page(s)` : ""}` : " · pasted text"}
            ${pages.ocrPages && pages.ocrPages.length ? ` · OCR pages ${pages.ocrPages.join(", ")}` : ""}
            ${resource.document ? ` · updated ${esc(relativeTime(resource.documentUpdatedAt))}` : ""}
          </p>
        </div>
        <div class="row">
          <a class="btn" href="#/kit/${esc(resource.kitId)}/questions">Practice questions</a>
          ${resource.type === "pdf" && !processing ? `<button class="btn" data-action="rerun-resource" data-id="${esc(resource.id)}">Re-run extraction</button>` : ""}
          <button class="btn danger" data-action="delete-resource" data-id="${esc(resource.id)}">Delete</button>
        </div>
      </header>

      ${resource.error ? `<div class="notice error"><strong>Processing failed.</strong> ${esc(resource.error)}</div>` : ""}
      ${processing ? `<div class="notice"><strong>Working…</strong> ${esc(resource.statusMessage || "Processing this resource.")}</div>` : ""}
      ${pages.gapNotes ? `<div class="notice subtle"><strong>Gap check:</strong> ${esc(pages.gapNotes)}</div>` : ""}

      <section class="panel">
        <div class="panel-head">
          <h2>Study document</h2>
          <div class="row tight">
            ${
              resource.document
                ? editing
                  ? `<button class="btn primary small" data-action="save-doc" data-id="${esc(resource.id)}">Save</button>
                     <button class="btn small" data-action="cancel-doc">Cancel</button>`
                  : `<button class="btn small" data-action="edit-doc" data-id="${esc(resource.id)}">Edit</button>
                     <button class="btn small" data-action="copy-doc" data-id="${esc(resource.id)}">Copy</button>
                     <button class="btn small" data-action="download-doc" data-id="${esc(resource.id)}">Download .md</button>`
                : ""
            }
          </div>
        </div>
        ${
          resource.document
            ? editing
              ? `<textarea class="doc-editor" data-draft="doc-${esc(resource.id)}" data-doc-id="${esc(resource.id)}" rows="24">${esc(resource.document)}</textarea>`
              : `<article class="md">${md.render(resource.document)}</article>`
            : `<div class="empty">
                 <h3>No document yet</h3>
                 <p class="muted">${processing ? "This resource is being processed." : "Processing did not finish. Re-run extraction to build the study document."}</p>
               </div>`
        }
      </section>`;

    return page;
  }

  /* ------------------------------------------------------------------ *
   * Job bar
   * ------------------------------------------------------------------ */

  function renderJobBar() {
    const job = jobs.getCurrent();
    const queued = jobs.getQueue();

    if (!job) {
      els.jobBar.hidden = true;
      els.jobBar.innerHTML = "";
      return;
    }

    els.jobBar.hidden = false;
    const percent = Math.max(2, Math.min(100, Math.round(job.progress || 0)));
    els.jobBar.innerHTML = `
      <div class="job-info">
        <div class="job-title">${esc(job.label || "Processing")}${queued.length ? ` <span class="muted tiny">(+${queued.length} queued)</span>` : ""}</div>
        <div class="job-step">${esc(job.step || "Starting…")}</div>
      </div>
      <div class="meter"><span style="width:${percent}%"></span></div>
      <button class="btn small" data-job-action="cancel">Cancel</button>`;

    els.jobBar.querySelector("[data-job-action='cancel']").addEventListener("click", () => jobs.cancelCurrent());
  }

  /* ------------------------------------------------------------------ *
   * Toasts and modals
   * ------------------------------------------------------------------ */

  function toast(message, type = "info") {
    const node = document.createElement("div");
    node.className = `toast ${type}`;
    node.textContent = message;
    els.toasts.appendChild(node);
    setTimeout(() => {
      node.classList.add("leaving");
      setTimeout(() => node.remove(), 250);
    }, 4200);
  }

  function closeModal() {
    els.modalRoot.innerHTML = "";
    els.modalRoot.hidden = true;
  }

  /**
   * @param {{title:string, body:string, confirmLabel?:string, danger?:boolean, onConfirm?:Function, onMount?:Function}} options
   */
  function openModal(options) {
    els.modalRoot.hidden = false;
    els.modalRoot.innerHTML = `
      <div class="modal-backdrop" data-close></div>
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(options.title)}">
        <header class="modal-head">
          <h2>${esc(options.title)}</h2>
          <button class="icon-btn" data-close title="Close">×</button>
        </header>
        <div class="modal-body">${options.body}</div>
        <footer class="modal-foot">
          <button class="btn" data-close>Cancel</button>
          <button class="btn ${options.danger ? "danger-solid" : "primary"}" data-confirm>${esc(options.confirmLabel || "Save")}</button>
        </footer>
      </div>`;

    els.modalRoot.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeModal));
    const confirm = els.modalRoot.querySelector("[data-confirm]");
    confirm.addEventListener("click", async () => {
      const result = options.onConfirm ? await options.onConfirm(els.modalRoot) : true;
      if (result !== false) closeModal();
    });
    if (options.onMount) options.onMount(els.modalRoot);
    const firstField = els.modalRoot.querySelector("input, textarea, select");
    if (firstField) setTimeout(() => firstField.focus(), 30);
  }

  function confirmDialog(title, message, confirmLabel = "Delete") {
    openModal({
      title,
      body: `<p>${esc(message)}</p>`,
      confirmLabel,
      danger: true,
      onConfirm: () => true,
    });
  }

  /* ------------------------------------------------------------------ *
   * Modals: classes, kits, settings
   * ------------------------------------------------------------------ */

  function classOptions(selected) {
    return [
      `<option value="">No class (uncategorised)</option>`,
      ...store.get().classes.map(
        (cls) => `<option value="${esc(cls.id)}" ${cls.id === selected ? "selected" : ""}>${esc(cls.name)}</option>`,
      ),
    ].join("");
  }

  function openNewKit(prefillClassId = null) {
    const classId = prefillClassId || (filterClassId ? filterClassId : "");
    openModal({
      title: "New study kit",
      confirmLabel: "Create",
      body: `
        <div class="field"><label for="kit-name">Name</label>
          <input id="kit-name" type="text" placeholder="e.g. Biology — Cells & Transport"></div>
        <div class="field"><label for="kit-subject">Subject / focus (optional)</label>
          <input id="kit-subject" type="text" placeholder="e.g. Year 11 Biology, Unit 2"></div>
        <div class="field"><label for="kit-class">Class</label>
          <select id="kit-class">${classOptions(classId)}</select></div>`,
      onConfirm: (root) => {
        const name = root.querySelector("#kit-name").value.trim();
        if (!name) return false;
        const kit = store.addKit({
          name,
          subject: root.querySelector("#kit-subject").value,
          classId: root.querySelector("#kit-class").value || null,
        });
        toast("Study kit created.", "success");
        navigate(`#/kit/${kit.id}`);
      },
    });
  }

  function openEditKit(id) {
    const kit = store.getKit(id);
    if (!kit) return;
    openModal({
      title: "Edit study kit",
      confirmLabel: "Save",
      body: `
        <div class="field"><label for="kit-name">Name</label>
          <input id="kit-name" type="text" value="${esc(kit.name)}"></div>
        <div class="field"><label for="kit-subject">Subject / focus</label>
          <input id="kit-subject" type="text" value="${esc(kit.subject)}"></div>
        <div class="field"><label for="kit-class">Class</label>
          <select id="kit-class">${classOptions(kit.classId)}</select></div>`,
      onConfirm: (root) => {
        const name = root.querySelector("#kit-name").value.trim();
        if (!name) return false;
        store.updateKit(id, {
          name,
          subject: root.querySelector("#kit-subject").value,
          classId: root.querySelector("#kit-class").value || null,
        });
        toast("Study kit updated.", "success");
      },
    });
  }

  function openRenameKit(id) {
    const kit = store.getKit(id);
    if (!kit) return;
    openModal({
      title: "Rename study kit",
      confirmLabel: "Rename",
      body: `<div class="field"><label for="kit-name">Name</label>
        <input id="kit-name" type="text" value="${esc(kit.name)}"></div>`,
      onConfirm: (root) => {
        const name = root.querySelector("#kit-name").value.trim();
        if (!name) return false;
        store.updateKit(id, { name });
        toast("Study kit renamed.", "success");
      },
    });
  }

  function openMoveKit(id) {
    const kit = store.getKit(id);
    if (!kit) return;
    openModal({
      title: "Move to class",
      confirmLabel: "Move",
      body: `<div class="field"><label for="kit-class">Class</label>
        <select id="kit-class">${classOptions(kit.classId)}</select></div>`,
      onConfirm: (root) => {
        store.updateKit(id, { classId: root.querySelector("#kit-class").value || null });
        toast("Study kit moved.", "success");
      },
    });
  }

  function openNewClass() {
    openModal({
      title: "New class",
      confirmLabel: "Create",
      body: `<div class="field"><label for="class-name">Class name</label>
        <input id="class-name" type="text" placeholder="e.g. Year 11 Biology"></div>`,
      onConfirm: (root) => {
        const name = root.querySelector("#class-name").value.trim();
        if (!name) return false;
        const cls = store.addClass(name);
        filterClassId = cls.id;
        toast("Class created.", "success");
      },
    });
  }

  function openRenameClass(id) {
    const cls = store.getClass(id);
    if (!cls) return;
    openModal({
      title: "Rename class",
      confirmLabel: "Rename",
      body: `<div class="field"><label for="class-name">Class name</label>
        <input id="class-name" type="text" value="${esc(cls.name)}"></div>`,
      onConfirm: (root) => {
        const name = root.querySelector("#class-name").value.trim();
        if (!name) return false;
        store.renameClass(id, name);
        toast("Class renamed.", "success");
      },
    });
  }

  function openSettings(note) {
    const settings = store.getSettings();
    openModal({
      title: "Settings",
      confirmLabel: "Save settings",
      body: `
        ${note ? `<div class="notice">${esc(note)}</div>` : ""}
        <div class="field">
          <label for="set-key">NVIDIA NIM API key</label>
          <input id="set-key" type="password" autocomplete="off" spellcheck="false" value="${esc(settings.apiKey)}" placeholder="nvapi-…">
          <span class="hint">Saved in this browser's localStorage and sent only to the Symus Worker → NVIDIA NIM.</span>
        </div>
        <div class="field-row">
          <div class="field"><label for="set-lang">OCR language</label>
            <select id="set-lang">
              ${[
                ["eng", "English"],
                ["jpn", "Japanese"],
                ["eng+jpn", "English + Japanese"],
                ["chi_sim", "Chinese (Simplified)"],
                ["fra", "French"],
                ["deu", "German"],
                ["spa", "Spanish"],
              ]
                .map(
                  ([value, label]) =>
                    `<option value="${value}" ${settings.ocrLanguage === value ? "selected" : ""}>${label}</option>`,
                )
                .join("")}
            </select>
          </div>
          <div class="field"><label for="set-scale">OCR render quality</label>
            <select id="set-scale">
              ${[1, 1.5, 2, 2.5, 3]
                .map(
                  (value) =>
                    `<option value="${value}" ${Number(settings.ocrScale) === value ? "selected" : ""}>${value}×</option>`,
                )
                .join("")}
            </select>
          </div>
        </div>
        <div class="notice subtle">
          <strong>Model:</strong> ${esc(Symus.ai.MODEL)}<br>
          <strong>Storage:</strong> ${(store.storageBytes() / 1024).toFixed(0)} KB used in localStorage.
          Study documents and questions are saved locally; uploaded files and their raw text are never stored.
        </div>
        <div class="notice error-soft">
          <strong>Danger zone</strong>
          <p class="tiny">Delete every class, study kit, resource, document and question from this browser.</p>
          <button class="btn small danger-solid" data-clear-all>Delete all data</button>
        </div>`,
      onMount: (root) => {
        const keyInput = root.querySelector("#set-key");
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "btn small";
        toggle.textContent = "Show";
        toggle.style.marginTop = "6px";
        toggle.addEventListener("click", () => {
          const show = keyInput.type === "password";
          keyInput.type = show ? "text" : "password";
          toggle.textContent = show ? "Hide" : "Show";
        });
        keyInput.insertAdjacentElement("afterend", toggle);

        root.querySelector("[data-clear-all]").addEventListener("click", () => {
          closeModal();
          openModal({
            title: "Delete all data?",
            body: `<p>This removes every class, kit, resource, generated document and question from this browser. Export a backup first if you need one.</p>`,
            confirmLabel: "Delete everything",
            danger: true,
            onConfirm: () => {
              try {
                localStorage.removeItem(store.STORAGE_KEY);
              } catch (error) {
                /* ignore */
              }
              filterClassId = null;
              editingDocId = null;
              lastQuizKey = null;
              docViewId = null;
              location.hash = "#/";
              store.load();
              toast("All local data deleted.", "success");
            },
          });
        });
      },
      onConfirm: (root) => {
        store.setSettings({
          apiKey: root.querySelector("#set-key").value,
          ocrLanguage: root.querySelector("#set-lang").value,
          ocrScale: Number(root.querySelector("#set-scale").value),
        });
        toast("Settings saved.", "success");
      },
    });
  }

  function openQuizOptions(kitId) {
    const kit = store.getKit(kitId);
    if (!kit) return;
    const withDocs = store.resourcesInKit(kit.id).filter((resource) => resource.document);

    openModal({
      title: "Practice questions",
      confirmLabel: "Generate",
      body: `
        <div class="notice subtle">
          Questions are written from <strong>all ${plural(withDocs.length, "study document")}</strong> in
          “${esc(kit.name)}”, so they cover the whole kit rather than one resource.
        </div>
        <div class="field-row">
          <div class="field"><label for="quiz-count">How many questions</label>
            <select id="quiz-count">
              ${[5, 10, 15, 20, 25].map((n) => `<option value="${n}" ${n === 10 ? "selected" : ""}>${n}</option>`).join("")}
            </select>
          </div>
          <div class="field"><label for="quiz-level">Difficulty</label>
            <select id="quiz-level">
              <option value="">Balanced</option>
              <option value="foundational">Foundational recall</option>
              <option value="exam">Exam-style, applied</option>
            </select>
          </div>
        </div>`,
      onConfirm: (root) => {
        if (!withDocs.length) {
          toast("Add a resource with a study document first.", "error");
          return false;
        }
        if (!requireKey()) return false;
        const count = Number(root.querySelector("#quiz-count").value);
        const difficulty = root.querySelector("#quiz-level").value;
        quizState = { selected: {}, revealed: {} };
        jobs.makeQuiz(kit, count, difficulty);
        toast("Generating practice questions…");
      },
    });
  }

  /* ------------------------------------------------------------------ *
   * Resource actions
   * ------------------------------------------------------------------ */

  function addPdfFiles(files) {
    const kit = store.getKit(route.id);
    if (!kit) return;
    if (!requireKey()) return;
    const pdfs = Array.from(files).filter((file) => /\.pdf$/i.test(file.name) || file.type === "application/pdf");
    if (!pdfs.length) {
      toast("Those files are not PDFs.", "error");
      return;
    }
    for (const file of pdfs) {
      const resource = store.addResource({ kitId: kit.id, name: fileTitle(file.name), type: "pdf" });
      if (resource) jobs.uploadPdf(resource, file);
    }
    toast(`${pdfs.length} PDF(s) queued for processing.`);
  }

  function addPastedText() {
    const kit = store.getKit(route.id);
    if (!kit) return;
    const textarea = els.view.querySelector('[data-draft="paste-text"]');
    const titleInput = els.view.querySelector('[data-draft="paste-title"]');
    const text = textarea ? textarea.value.trim() : "";
    if (!text) {
      toast("Paste some text first.", "error");
      return;
    }
    if (!requireKey()) return;
    const name = (titleInput && titleInput.value.trim()) || firstLine(text);
    const resource = store.addResource({ kitId: kit.id, name, type: "text" });
    if (!resource) return;
    jobs.uploadText(resource, text);
    if (textarea) textarea.value = "";
    if (titleInput) titleInput.value = "";
    toast("Pasted text queued for processing.");
  }

  function download(filename, content, type = "text/plain;charset=utf-8") {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function safeFileName(name, extension) {
    const base = String(name).replace(/[\\/:*?"<>|]+/g, " ").trim() || "symus";
    return `${base}.${extension}`;
  }

  async function copyText(text, label = "Copied") {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label} to clipboard.`, "success");
    } catch (error) {
      toast("Clipboard was blocked by the browser.", "error");
    }
  }

  function quizToMarkdown(kit) {
    const quiz = kit.quiz;
    const lines = [`# ${kit.name} — practice questions`, ""];
    if (quiz.sourceNames && quiz.sourceNames.length) {
      lines.push(`Sources: ${quiz.sourceNames.join(", ")}`, "");
    }
    quiz.items.forEach((item, index) => {
      lines.push(`**${index + 1}. ${item.question}**`);
      if (item.type === "mcq") {
        item.options.forEach((option, optionIndex) => {
          const marker = optionIndex === item.answerIndex ? "**" : "";
          lines.push(`- ${String.fromCharCode(65 + optionIndex)}. ${marker}${option}${marker}`);
        });
      } else {
        lines.push(`- Answer: ${item.answer}`);
      }
      if (item.explanation) lines.push(`- Why: ${item.explanation}`);
      lines.push("");
    });
    return lines.join("\n");
  }

  /* ------------------------------------------------------------------ *
   * Delegated events
   * ------------------------------------------------------------------ */

  function onClick(event) {
    const actionEl = event.target.closest("[data-action], [data-job-action]");
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    const id = actionEl.dataset.id;
    if (!action) return;
    event.preventDefault();

    switch (action) {
      case "filter-class":
        document.body.classList.remove("nav-open");
        filterClassId = id || null;
        if (route.name !== "dashboard") navigate("#/");
        else render();
        break;
      case "new-kit":
        openNewKit();
        break;
      case "new-class":
        openNewClass();
        break;
      case "rename-kit":
        openRenameKit(id);
        break;
      case "move-kit":
        openMoveKit(id);
        break;
      case "edit-kit":
        openEditKit(id);
        break;
      case "rename-class":
        openRenameClass(id);
        break;
      case "delete-kit": {
        const kit = store.getKit(id);
        if (!kit) break;
        openModal({
          title: "Delete study kit",
          body: `<p>Delete <strong>${esc(kit.name)}</strong> and its ${plural(store.resourcesInKit(id).length, "resource")}? This cannot be undone.</p>`,
          confirmLabel: "Delete kit",
          danger: true,
          onConfirm: () => {
            store.deleteKit(id);
            if (route.name === "kit" && route.id === id) navigate("#/");
            toast("Study kit deleted.", "success");
          },
        });
        break;
      }
      case "delete-class": {
        const cls = store.getClass(id);
        if (!cls) break;
        openModal({
          title: "Delete class",
          body: `<p>Delete the class <strong>${esc(cls.name)}</strong>? Its study kits are kept and become uncategorised.</p>`,
          confirmLabel: "Delete class",
          danger: true,
          onConfirm: () => {
            store.deleteClass(id);
            if (filterClassId === id) filterClassId = null;
            toast("Class deleted.", "success");
          },
        });
        break;
      }
      case "pick-pdf":
        pendingReprocessId = null;
        els.fileInput.multiple = true;
        els.fileInput.click();
        break;
      case "add-text":
        addPastedText();
        break;
      case "delete-resource": {
        const resource = store.getResource(id);
        if (!resource) break;
        openModal({
          title: "Delete resource",
          body: `<p>Delete <strong>${esc(resource.name)}</strong>, its study document and its questions?</p>`,
          confirmLabel: "Delete resource",
          danger: true,
          onConfirm: () => {
            store.deleteResource(id);
            if (route.name === "resource" && route.id === id) navigate(`#/kit/${resource.kitId}`);
            toast("Resource deleted.", "success");
          },
        });
        break;
      }
      case "rerun-resource": {
        const resource = store.getResource(id);
        if (!resource) break;
        const file = jobs.getSessionFile(id);
        if (file) {
          jobs.uploadPdf(resource, file);
          toast("Re-running extraction…");
        } else {
          pendingReprocessId = id;
          els.fileInput.multiple = false;
          toast("Select the same PDF again to re-run extraction.");
          els.fileInput.click();
        }
        break;
      }
      case "edit-doc":
        editingDocId = id;
        render();
        break;
      case "cancel-doc":
        editingDocId = null;
        render();
        break;
      case "save-doc": {
        const textarea = els.view.querySelector(`[data-doc-id="${id}"]`);
        if (!textarea) break;
        store.setResourceDocument(id, textarea.value);
        editingDocId = null;
        toast("Document saved.", "success");
        break;
      }
      case "copy-doc": {
        const resource = store.getResource(id);
        if (resource) copyText(resource.document, "Document copied");
        break;
      }
      case "download-doc": {
        const resource = store.getResource(id);
        if (resource) download(safeFileName(resource.name, "md"), resource.document, "text/markdown;charset=utf-8");
        break;
      }
      case "make-quiz": {
        const kit = store.getKit(id);
        if (kit) openQuizOptions(kit.id);
        break;
      }
      case "download-quiz": {
        const kit = store.getKit(id);
        if (kit && kit.quiz) {
          download(safeFileName(kit.name + " questions", "md"), quizToMarkdown(kit), "text/markdown;charset=utf-8");
        }
        break;
      }
      case "select-doc":
        docViewId = id;
        render();
        break;
      case "answer-mcq": {
        const index = Number(actionEl.dataset.q);
        quizState.selected[index] = Number(actionEl.dataset.opt);
        render();
        break;
      }
      case "reveal": {
        const index = Number(actionEl.dataset.q);
        quizState.revealed[index] = true;
        render();
        break;
      }
      default:
        break;
    }
  }

  function onDrop(event) {
    const zone = event.target.closest("[data-dropzone]");
    if (!zone) return;
    event.preventDefault();
    zone.classList.remove("dragging");
    const files = event.dataTransfer && event.dataTransfer.files;
    if (files && files.length) addPdfFiles(files);
  }

  function onDragOver(event) {
    const zone = event.target.closest("[data-dropzone]");
    if (!zone) return;
    event.preventDefault();
    zone.classList.add("dragging");
  }

  function onDragLeave(event) {
    const zone = event.target.closest("[data-dropzone]");
    if (zone) zone.classList.remove("dragging");
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  function init() {
    els = {
      view: $("view"),
      nav: $("nav-classes"),
      storage: $("storage-meter"),
      jobBar: $("job-bar"),
      toasts: $("toasts"),
      modalRoot: $("modal-root"),
      search: $("search"),
      fileInput: $("pdf-file-input"),
      sidebar: $("sidebar"),
    };

    els.view.addEventListener("click", onClick);
    els.view.addEventListener("dragover", onDragOver);
    els.view.addEventListener("dragleave", onDragLeave);
    els.view.addEventListener("drop", onDrop);
    els.nav.addEventListener("click", onClick);

    els.search.addEventListener("input", () => {
      query = els.search.value.trim();
      scheduleRender();
    });

    els.fileInput.addEventListener("change", () => {
      const files = Array.from(els.fileInput.files || []);
      els.fileInput.value = "";
      if (!files.length) return;
      if (pendingReprocessId) {
        const resource = store.getResource(pendingReprocessId);
        pendingReprocessId = null;
        els.fileInput.multiple = true;
        if (resource && requireKey()) jobs.uploadPdf(resource, files[0]);
        return;
      }
      addPdfFiles(files);
    });

    $("btn-new-kit").addEventListener("click", () => openNewKit());
    $("btn-settings").addEventListener("click", () => openSettings());
    $("btn-export").addEventListener("click", () => {
      download(`symus-study-backup-${new Date().toISOString().slice(0, 10)}.json`, store.exportData(), "application/json");
      toast("Backup exported.", "success");
    });
    $("btn-import").addEventListener("click", () => $("import-file").click());
    $("import-file").addEventListener("change", async (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = "";
      if (!file) return;
      try {
        const text = await file.text();
        const added = store.importData(text);
        toast(`Imported ${plural(added.kits, "kit")} and ${plural(added.resources, "resource")}.`, "success");
      } catch (error) {
        toast(error.message || "Could not import that file.", "error");
      }
    });

    $("btn-menu").addEventListener("click", () => {
      document.body.classList.toggle("nav-open");
    });

    window.addEventListener("hashchange", () => {
      document.body.classList.remove("nav-open");
      render();
    });
    store.subscribe(scheduleRender);

    let lastSeenJob = null;
    jobs.subscribe((current) => {
      renderJobBar();
      if (lastSeenJob && current !== lastSeenJob) {
        const finished = jobs.getLast();
        if (finished) {
          if (finished.status === "done") {
            toast(
              finished.kind === "quiz" ? "Practice questions ready." : "Study document ready.",
              "success",
            );
          } else if (finished.status === "error") {
            toast(finished.error || "Processing failed.", "error");
          } else if (finished.status === "cancelled") {
            toast("Job cancelled.", "info");
          }
        }
        scheduleRender();
      }
      lastSeenJob = current;
    });

    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        els.search.focus();
        els.search.select();
      }
      if (event.key === "Escape") {
        document.body.classList.remove("nav-open");
      }
    });

    els.modalRoot.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeModal();
      if (event.key === "Enter" && event.target.tagName === "INPUT") {
        const confirm = els.modalRoot.querySelector("[data-confirm]");
        if (confirm) confirm.click();
      }
    });

    store.load();
    render();
    renderJobBar();
  }

  Symus.ui = {
    init,
    render,
    toast,
    openSettings,
    navigate,
    isEditingDoc: () => Boolean(editingDocId),
  };
})((window.Symus = window.Symus || {}));
