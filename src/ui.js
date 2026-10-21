/**
 * Symus Study — interface
 *
 * Hash routes:
 *   #/                 dashboard (classes + study kits)
 *   #/kit/<id>                   a study kit: add PDFs / pasted text, see resources
 *   #/kit/<id>/documents        study documents
 *   #/kit/<id>/questions        practice questions
 *   #/kit/<id>/flashcards       flashcard deck
 *   #/kit/<id>/exam             timed practice exam
 *   #/resource/<id>             one resource: study document
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

  const KIT_TABS = ["resources", "documents", "questions", "flashcards", "exam"];

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
  // Flashcard deck position, kept per kit while the tab is open.
  let flashState = { kitId: null, index: 0, flipped: false, order: null, known: {}, again: {}, shuffled: false };
  // Timed exam session. Lives in memory only: reloading the page abandons a run.
  let examState = { kitId: null, status: "idle", answers: {}, startedAt: 0, endsAt: 0, secondsUsed: 0 };
  let renderQueued = false;
  let pendingReprocessId = null;
  let lastQuizKey = null;
  // Cached model catalogue for the Settings selector (per page load).
  const modelCache = { models: [], loadedAt: 0 };

  const $ = (id) => document.getElementById(id);

  /* ------------------------------------------------------------------ *
   * Inline icons (stroke, currentColor) — no external dependency.
   * ------------------------------------------------------------------ */

  const ICONS = {
    home: '<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-5H9v5H5a1 1 0 0 1-1-1Z"/>',
    kits: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 9h16M9 5v14"/>',
    folder: '<path d="M4 7a1 1 0 0 1 1-1h4l2 2h7a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    cards: '<rect x="4" y="6" width="12" height="14" rx="2"/><path d="M9 3h9a2 2 0 0 1 2 2v11"/>',
    book: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v14H6.5A1.5 1.5 0 0 0 5 19.5Z"/><path d="M5 19.5A1.5 1.5 0 0 1 6.5 18H19v3H6.5A1.5 1.5 0 0 1 5 19.5Z"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    download: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 19h14"/>',
    upload: '<path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M5 19h14"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z"/>',
    moon: '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/>',
  };

  function icon(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
      ICONS[name] || ""
    }</svg>`;
  }

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
      const tab = KIT_TABS.includes(parts[2]) ? parts[2] : "resources";
      route = { name: "kit", id: parts[1], tab };
    } else if (parts[0] === "resource" && parts[1]) {
      route = { name: "resource", id: parts[1] };
    } else {
      route = { name: "dashboard", id: null };
    }
  }

  function resetDeck(kitId) {
    flashState = {
      kitId,
      index: 0,
      flipped: false,
      order: null,
      known: {},
      again: {},
      shuffled: false,
      showList: false,
    };
  }

  function resetExam(kitId) {
    examState = { kitId, status: "idle", answers: {}, startedAt: 0, endsAt: 0, secondsUsed: 0 };
  }

  /** Deck order: natural, or a stable shuffle stored in flashState.order. */
  function deckOrder(kit) {
    const total = kit.flashcards ? kit.flashcards.items.length : 0;
    if (!total) return [];
    if (!flashState.order || flashState.order.length !== total) {
      flashState.order = Array.from({ length: total }, (_, index) => index);
    }
    return flashState.order;
  }

  function formatClock(seconds) {
    const safe = Math.max(0, Math.ceil(seconds));
    const minutes = Math.floor(safe / 60);
    const rest = safe % 60;
    return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }

  function examSecondsLeft() {
    if (examState.status !== "running") return 0;
    return Math.max(0, Math.ceil((examState.endsAt - Date.now()) / 1000));
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
        resetDeck(route.id);
        if (examState.kitId !== route.id) resetExam(route.id);
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

  function navRow({ action, id = "", label, iconName, count, active, cls = "" }) {
    return `<button class="nav-item ${active ? "active" : ""} ${cls}" data-action="${action}" data-id="${esc(
      id,
    )}" title="${esc(label)}">
      <span class="nav-icon">${icon(iconName)}</span>
      <span class="nav-text">${esc(label)}</span>
      ${count === undefined || count === null ? "" : `<span class="count">${count}</span>`}
    </button>`;
  }

  function renderSidebar() {
    const state = store.get();
    const totalKits = state.kits.length;
    const onDashboard = route.name === "dashboard";

    const main = [
      navRow({
        action: "filter-class",
        label: "Dashboard",
        iconName: "home",
        count: totalKits,
        active: onDashboard && !filterClassId,
      }),
    ];

    const classes = state.classes.map((cls) =>
      navRow({
        action: "filter-class",
        id: cls.id,
        label: cls.name,
        iconName: "folder",
        count: state.kits.filter((kit) => kit.classId === cls.id).length,
        active: onDashboard && filterClassId === cls.id,
      }),
    );

    els.nav.innerHTML = `
      <div class="nav-group">
        <div class="nav-label">Main</div>
        ${main.join("")}
      </div>
      <div class="nav-group">
        <div class="nav-label">Classes</div>
        ${classes.join("")}
        <button class="nav-item nav-add" data-action="new-class" title="New class">
          <span class="nav-icon">${icon("plus")}</span>
          <span class="nav-text">New class</span>
        </button>
      </div>
      <div class="nav-group">
        <div class="nav-label">Data</div>
        <button class="nav-item" data-action="export-backup" title="Export a backup">
          <span class="nav-icon">${icon("download")}</span>
          <span class="nav-text">Export backup</span>
        </button>
        <button class="nav-item" data-action="import-backup" title="Import a backup">
          <span class="nav-icon">${icon("upload")}</span>
          <span class="nav-text">Import backup</span>
        </button>
      </div>`;

    const summary = document.getElementById("user-meta-line");
    if (summary) {
      summary.textContent = `${plural(totalKits, "kit")} · ${plural(state.resources.length, "resource")}`;
    }
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
        <div class="page-title">
          <p class="eyebrow">${filterClassId ? "Class" : "Study library"}</p>
          <h1>${esc(filterClassId ? (store.getClass(filterClassId) || {}).name || "Study kits" : "Study kits")}</h1>
        </div>
        <div class="row tight">
          <button class="btn" data-action="new-class">New class</button>
          <button class="btn primary" data-action="new-kit">New study kit</button>
        </div>
      </header>
      <p class="page-sub">${plural(state.kits.length, "kit")} across ${plural(
        state.classes.length,
        "class",
        "classes",
      )} · ${plural(state.resources.length, "resource")}. Turn each resource into a study document, then questions, flashcards or a timed exam.</p>
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
                    <button class="btn ghost small" data-action="delete-class" data-id="${esc(cls.id)}">Delete</button>
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
        <p class="muted">A study kit holds resources — PDFs or pasted text. Symus Study turns each resource into a complete study document, then writes practice questions, flashcards and timed practice exams from it.</p>
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
    const counts = [];
    if (kit.quiz) counts.push(plural(kit.quiz.items.length, "question"));
    if (kit.flashcards) counts.push(plural(kit.flashcards.items.length, "card"));
    if (kit.exam) counts.push(`${kit.exam.items.length}-question exam`);

    const status = ready
      ? `${plural(ready, "resource")} ready`
      : resources.length
        ? "No study documents yet"
        : "No resources yet";
    const generated = counts.length ? counts.join(" · ") : "";

    return `
      <article class="card kit-card">
        <div class="kit-figure">${resources.length}</div>
        <div class="kit-body">
          <h3><a href="#/kit/${esc(kit.id)}">${esc(kit.name)}</a></h3>
          <p class="kit-meta">${esc(kit.subject || status)}</p>
          ${kit.subject ? `<p class="kit-sub">${esc(status)}</p>` : ""}
          <p class="kit-sub">${generated ? `${esc(generated)} · ` : ""}updated ${esc(relativeTime(kit.updatedAt))}</p>
          ${cls ? `<div class="kit-tag"><span class="chip">${esc(cls.name)}</span></div>` : ""}
        </div>
        <div class="kit-actions">
          <button class="btn primary small" data-action="open-kit" data-id="${esc(kit.id)}">Open</button>
          <button class="btn small" data-action="rename-kit" data-id="${esc(kit.id)}">Rename</button>
          <button class="btn small" data-action="move-kit" data-id="${esc(kit.id)}">Move</button>
          <button class="btn small" data-action="delete-kit" data-id="${esc(kit.id)}">Delete</button>
        </div>
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
      {
        id: "flashcards",
        label: "Flashcards",
        count: kit.flashcards ? kit.flashcards.items.length : 0,
        href: `#/kit/${kit.id}/flashcards`,
      },
      {
        id: "exam",
        label: "Practice exam",
        count: kit.exam ? kit.exam.items.length : 0,
        href: `#/kit/${kit.id}/exam`,
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
        <div class="page-title">
          <p class="eyebrow">${esc(kit.subject || "Study kit")}</p>
          <h1>${esc(kit.name)}</h1>
        </div>
        <div class="row tight">
          <button class="btn" data-action="edit-kit" data-id="${esc(kit.id)}">Edit details</button>
          <button class="btn" data-action="delete-kit" data-id="${esc(kit.id)}">Delete kit</button>
        </div>
      </header>
      ${kitTabs(kit, resources, tab)}
      ${
        tab === "documents"
          ? renderKitDocuments(kit, resources)
          : tab === "questions"
            ? renderKitQuestions(kit, resources)
            : tab === "flashcards"
              ? renderKitFlashcards(kit, resources)
              : tab === "exam"
                ? renderKitExam(kit, resources)
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
          <p class="muted tiny">AI settings: ${esc(settings.model)} · ${esc(settings.ocrLanguage)} OCR · ${settings.ocrScale}× render. ${store.getApiKey() ? "NIM key saved." : '<span class="danger">No NIM key yet.</span>'}</p>
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
    const coverage = (quiz && quiz.coverage && quiz.coverage.length ? quiz.coverage : null) || [];
    const uncovered = coverage.filter((entry) => entry.produced === 0);

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
        ${
          quiz && coverage.length
            ? `<div class="coverage" aria-label="Questions per resource">${coverage
                .map(
                  (entry) =>
                    `<span class="coverage-item ${entry.produced ? "ok" : "empty"}" title="${esc(
                      entry.produced
                        ? `${entry.produced} of ${entry.requested} requested question(s)`
                        : "No questions were produced for this resource",
                    )}">${esc(entry.name)}<span>${entry.produced}</span></span>`,
                )
                .join("")}</div>`
            : ""
        }
        ${quiz && missing > 0 ? `<div class="notice subtle">${plural(missing, "newer document")} not covered yet — regenerate to include them.</div>` : ""}
        ${
          quiz && uncovered.length
            ? `<div class="notice subtle">No questions for ${esc(uncovered.map((entry) => entry.name).join(", "))} — regenerate, or check that its document has enough content to question.</div>`
            : ""
        }
        ${
          quiz && quiz.failures && quiz.failures.length
            ? `<div class="notice error-soft"><strong>Some resources failed.</strong> ${esc(
                quiz.failures.map((failure) => `${failure.name}: ${failure.message}`).join(" · "),
              )}</div>`
            : ""
        }
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

  /* ----------------------------- flashcards ------------------------ */

  function coverageChips(coverage) {
    if (!coverage || !coverage.length) return "";
    return `<div class="coverage" aria-label="Cards or questions per resource">${coverage
      .map(
        (entry) =>
          `<span class="coverage-item ${entry.produced ? "ok" : "empty"}" title="${esc(
            entry.produced
              ? `${entry.produced} of ${entry.requested} requested`
              : "Nothing was produced for this resource",
          )}">${esc(entry.name)}<span>${entry.produced}</span></span>`,
      )
      .join("")}</div>`;
  }

  function sourceFailures(set) {
    return set && set.failures && set.failures.length
      ? `<div class="notice error-soft"><strong>Some resources failed.</strong> ${esc(
          set.failures.map((failure) => `${failure.name}: ${failure.message}`).join(" · "),
        )}</div>`
      : "";
  }

  function renderKitFlashcards(kit, resources) {
    const withDocs = resources.filter((resource) => resource.document);
    const cards = kit.flashcards;

    return `
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Flashcards</h2>
            <p class="muted tiny">${
              cards ? `${cards.style === "question" ? "Exam-style question cards" : "Vocabulary & concept cards"} · ` : ""
            }drawn from all ${plural(withDocs.length, "study document")} in this kit.</p>
          </div>
          <div class="row tight">
            <button class="btn small ${cards ? "" : "primary"}" data-action="make-flashcards" data-id="${esc(kit.id)}">${
              cards ? "Regenerate" : "Generate flashcards"
            }</button>
            ${
              cards
                ? `<button class="btn small" data-action="download-flashcards" data-id="${esc(kit.id)}">Download .md</button>`
                : ""
            }
          </div>
        </div>
        ${
          !withDocs.length
            ? `<div class="notice subtle">Process at least one resource first — cards are written from the study documents in this kit.</div>`
            : ""
        }
        ${cards ? coverageChips(cards.coverage) : ""}
        ${cards ? sourceFailures(cards) : ""}
        ${cards ? renderDeck(kit) : renderDeckEmpty(withDocs.length)}
      </section>`;
  }

  function renderDeckEmpty(documentCount) {
    if (!documentCount) return "";
    return `<p class="muted small">No flashcards yet. Generate a deck and it will be saved with this study kit.</p>`;
  }

  function renderDeck(kit) {
    const items = kit.flashcards.items;
    const order = deckOrder(kit);
    const position = Math.min(flashState.index, order.length - 1);
    const card = items[order[position]];
    if (!card) return "";

    const vocab = kit.flashcards.style !== "question";
    const frontLabel = vocab ? "Term" : "Question";
    const backLabel = vocab ? "Definition" : "Answer";
    const knownCount = Object.keys(flashState.known).length;
    const againCount = Object.keys(flashState.again).length;
    const percent = Math.round((position / order.length) * 100);

    return `
      <div class="deck">
        <div class="deck-bar">
          <span class="muted tiny">Card ${position + 1} of ${order.length}${
            flashState.shuffled ? " · shuffled" : ""
          }</span>
          <span class="muted tiny">${knownCount} known${againCount ? ` · ${againCount} to review` : ""}</span>
        </div>
        <div class="deck-meter"><span style="width:${percent}%"></span></div>
        <button class="flashcard ${flashState.flipped ? "flipped" : ""}" data-action="flip-card" aria-label="Flashcard">
          <span class="fc-side">${flashState.flipped ? backLabel : frontLabel}</span>
          <span class="fc-text">${esc(flashState.flipped ? card.back : card.front)}</span>
          <span class="fc-hint">${
            flashState.flipped ? "Click to see the prompt again" : "Click or press Space to reveal"
          }</span>
        </button>
        ${card.source ? `<p class="muted tiny center">From ${esc(card.source)}</p>` : ""}
        <div class="row center">
          <button class="btn small" data-action="prev-card" ${position === 0 ? "disabled" : ""}>Previous</button>
          <button class="btn small primary" data-action="flip-card">${
            flashState.flipped ? "Show prompt" : "Show answer"
          }</button>
          <button class="btn small" data-action="next-card" ${
            position >= order.length - 1 ? "disabled" : ""
          }>Next</button>
        </div>
        <div class="row center tight">
          <button class="btn small ghost" data-action="card-again">Still learning</button>
          <button class="btn small ghost" data-action="card-known">Got it</button>
        </div>
        <div class="row center tight deck-tools">
          <button class="btn small ghost" data-action="shuffle-cards">Shuffle</button>
          <button class="btn small ghost" data-action="restart-cards">Restart</button>
          <button class="btn small ghost" data-action="deck-list">${
            flashState.showList ? "Back to card" : "Browse all"
          }</button>
        </div>
        ${flashState.showList ? renderDeckList(items) : ""}
      </div>`;
  }

  function renderDeckList(items) {
    return `<ol class="deck-list">${items
      .map((card) => `<li><p><strong>${esc(card.front)}</strong></p><p class="muted small">${esc(card.back)}</p></li>`)
      .join("")}</ol>`;
  }

  /* --------------------------- practice exam ----------------------- */

  function renderKitExam(kit, resources) {
    const withDocs = resources.filter((resource) => resource.document);
    const exam = kit.exam;

    if (!exam) {
      return `
        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>Practice exam</h2>
              <p class="muted tiny">A timed, multiple-choice paper written from all ${plural(
                withDocs.length,
                "study document",
              )} in this kit.</p>
            </div>
            <button class="btn small primary" data-action="make-exam" data-id="${esc(kit.id)}">Build exam</button>
          </div>
          ${
            withDocs.length
              ? `<p class="muted small">No exam yet. Build one, then start the clock — questions are marked automatically when you submit or when time runs out.</p>`
              : `<div class="notice subtle">Process at least one resource first — the exam is written from the study documents in this kit.</div>`
          }
        </section>`;
    }

    if (examState.status === "running") return renderExamRunning(kit);
    if (examState.status === "finished") return renderExamResult(kit);

    return renderExamIntro(kit);
  }

  function renderExamIntro(kit) {
    const exam = kit.exam;
    const attempt = exam.lastAttempt;
    return `
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Practice exam</h2>
            <p class="muted tiny">Written from all ${plural(exam.sourceCount || exam.sourceNames.length, "study document")} in this kit.</p>
          </div>
          <div class="row tight">
            <button class="btn small primary" data-action="start-exam" data-id="${esc(kit.id)}">Start exam</button>
            <button class="btn small" data-action="make-exam" data-id="${esc(kit.id)}">New exam</button>
          </div>
        </div>
        ${coverageChips(exam.coverage)}
        ${sourceFailures(exam)}
        <div class="exam-brief">
          <div><span class="exam-figure">${exam.items.length}</span><span class="muted tiny">questions</span></div>
          <div><span class="exam-figure">${exam.durationMinutes}</span><span class="muted tiny">minutes</span></div>
          <div><span class="exam-figure">${Math.round((exam.durationMinutes * 60) / exam.items.length)}</span><span class="muted tiny">seconds / question</span></div>
          <div><span class="exam-figure">${attempt ? `${attempt.correct}/${attempt.total}` : "—"}</span><span class="muted tiny">last score</span></div>
        </div>
        <div class="notice subtle">
          The clock keeps running if you leave this tab, and the exam submits itself when time is up.
          Only multiple-choice questions are used so the paper can be marked automatically.
        </div>
      </section>`;
  }

  function renderExamRunning(kit) {
    const exam = kit.exam;
    const answers = examState.answers;
    const answered = Object.keys(answers).length;
    const left = examSecondsLeft();

    return `
      <section class="panel">
        <div class="exam-bar">
          <div class="exam-timer">
            <span id="exam-clock" class="exam-clock ${left <= 60 ? "warn" : ""}">${formatClock(left)}</span>
            <span class="muted tiny">remaining</span>
          </div>
          <span class="muted tiny" id="exam-answered">${answered}/${exam.items.length} answered</span>
          <button class="btn small primary" data-action="submit-exam">Submit exam</button>
        </div>
        <ol class="quiz exam-questions">
          ${exam.items
            .map(
              (item, index) => `
            <li class="q">
              <p class="q-text"><span class="q-number">${index + 1}</span>${esc(item.question)}</p>
              <div class="options">
                ${item.options
                  .map(
                    (option, optionIndex) => `<button class="option ${
                      answers[index] === optionIndex ? "selected" : ""
                    }" data-action="exam-answer" data-q="${index}" data-opt="${optionIndex}">
                      <span class="opt-letter">${String.fromCharCode(65 + optionIndex)}</span>
                      <span>${esc(option)}</span>
                    </button>`,
                  )
                  .join("")}
              </div>
            </li>`,
            )
            .join("")}
        </ol>
        <div class="row center">
          <button class="btn primary" data-action="submit-exam">Submit exam</button>
        </div>
      </section>`;
  }

  function renderExamResult(kit) {
    const exam = kit.exam;
    const result = examState.result || { correct: 0, total: exam.items.length, secondsUsed: 0 };
    const percent = result.total ? Math.round((result.correct / result.total) * 100) : 0;
    const grade =
      percent >= 85 ? "Excellent" : percent >= 70 ? "Solid pass" : percent >= 50 ? "Getting there" : "Needs work";

    return `
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Exam result</h2>
            <p class="muted tiny">${result.timedOut ? "Time ran out — the paper was submitted automatically." : "Submitted."}</p>
          </div>
          <div class="row tight">
            <button class="btn small" data-action="retake-exam">Retake</button>
            <button class="btn small" data-action="make-exam" data-id="${esc(kit.id)}">New exam</button>
          </div>
        </div>
        <div class="result-card">
          <span class="result-score">${result.correct}<span class="muted">/${result.total}</span></span>
          <span class="result-percent">${percent}%</span>
          <span class="badge ${percent >= 70 ? "ready" : "error"}">${esc(grade)}</span>
          <span class="muted tiny">in ${formatClock(result.secondsUsed)} of ${exam.durationMinutes}:00</span>
        </div>
        <div class="result-meter"><span style="width:${percent}%"></span></div>
        <h3 class="review-head">Review</h3>
        <ol class="quiz">
          ${exam.items
            .map((item, index) => {
              const chosen = examState.answers[index];
              const correct = chosen === item.answerIndex;
              return `
              <li class="q ${correct ? "q-correct" : "q-wrong"}">
                <p class="q-text"><span class="q-number">${index + 1}</span>${esc(item.question)}</p>
                <div class="options">
                  ${item.options
                    .map((option, optionIndex) => {
                      let cls = "option static";
                      if (optionIndex === item.answerIndex) cls += " correct";
                      else if (optionIndex === chosen) cls += " wrong";
                      return `<span class="${cls}">
                        <span class="opt-letter">${String.fromCharCode(65 + optionIndex)}</span>
                        <span>${esc(option)}</span>
                      </span>`;
                    })
                    .join("")}
                </div>
                <p class="muted tiny">${
                  chosen === undefined ? "Not answered." : correct ? "Correct." : "Incorrect — see the highlighted answer."
                }</p>
                ${item.explanation ? `<p class="explanation">${esc(item.explanation)}</p>` : ""}
              </li>`;
            })
            .join("")}
        </ol>
      </section>`;
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
        <div class="page-title">
          <p class="eyebrow">Resource</p>
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
          <a class="btn" href="#/kit/${esc(resource.kitId)}/flashcards">Flashcards</a>
          <a class="btn" href="#/kit/${esc(resource.kitId)}/exam">Practice exam</a>
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

  const CUSTOM_MODEL = "__custom__";

  function modelFilterLabel() {
    return Symus.ai.MODEL_FILTER.join(", ");
  }

  /** Options for the model select, always including the currently saved model. */
  function modelOptionsHtml(currentModel) {
    const cached = modelCache.models;
    const ids = new Set([currentModel, Symus.ai.DEFAULT_MODEL, ...cached.map((model) => model.id)].filter(Boolean));
    const options = [...ids]
      .sort((a, b) => a.localeCompare(b))
      .map(
        (id) =>
          `<option value="${esc(id)}" ${id === currentModel ? "selected" : ""}>${esc(id)}${
            id === Symus.ai.DEFAULT_MODEL ? " (default)" : ""
          }</option>`,
      );
    options.push(`<option value="${CUSTOM_MODEL}" ${ids.has(currentModel) ? "" : "selected"}>Custom model id…</option>`);
    return options.join("");
  }

  /** Populate the select in an open settings modal. */
  function fillModelOptions(root, currentModel, { keepCustom = false } = {}) {
    const select = root.querySelector("#set-model");
    if (!select) return;
    const previous = keepCustom ? select.value : currentModel;
    select.innerHTML = modelOptionsHtml(currentModel);
    if (previous && [...select.options].some((option) => option.value === previous)) select.value = previous;
    syncCustomInput(root);
  }

  function syncCustomInput(root) {
    const select = root.querySelector("#set-model");
    const input = root.querySelector("#set-model-custom");
    if (!select || !input) return;
    const custom = select.value === CUSTOM_MODEL;
    input.hidden = !custom;
    if (custom && !input.value) input.value = "";
  }

  function readModelField(root) {
    const select = root.querySelector("#set-model");
    const input = root.querySelector("#set-model-custom");
    if (select && select.value === CUSTOM_MODEL) {
      const custom = input ? input.value.trim() : "";
      return custom;
    }
    return select ? select.value : "";
  }

  async function loadModelCatalogue(root, { key, statusEl, button }) {
    const apiKey = (key || "").trim();
    if (!apiKey) {
      if (statusEl) statusEl.textContent = "Enter your NVIDIA API key first.";
      return;
    }
    if (button) button.disabled = true;
    if (statusEl) statusEl.textContent = "Loading models from NVIDIA…";

    try {
      const { models } = await Symus.ai.listModels({ apiKey });
      modelCache.models = models;
      modelCache.loadedAt = Date.now();
      const saved = readModelField(root) || store.getSettings().model;
      fillModelOptions(root, saved, { keepCustom: true });
      if (statusEl) {
        statusEl.textContent = models.length
          ? `${models.length} model(s) available. Only ${modelFilterLabel()} models are listed.`
          : `No models matched ${modelFilterLabel()}. Use a custom model id.`;
      }
      if (!models.length) {
        const select = root.querySelector("#set-model");
        if (select) {
          select.value = CUSTOM_MODEL;
          syncCustomInput(root);
        }
      }
    } catch (error) {
      if (statusEl) statusEl.textContent = "Could not load models: " + Symus.ai.describeError(error);
    } finally {
      if (button) button.disabled = false;
    }
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
        <div class="field">
          <label for="set-model">Model</label>
          <select id="set-model">${modelOptionsHtml(settings.model)}</select>
          <div class="row tight" style="margin-top:2px">
            <button type="button" class="btn small" id="set-model-refresh">Load available models</button>
            <span class="hint" id="set-model-status">Only ${esc(modelFilterLabel())} models are listed.</span>
          </div>
          <input id="set-model-custom" type="text" placeholder="vendor/model-id" hidden>
          <span class="hint">The list comes from your NVIDIA account through the Symus Worker, filtered to the supported model families.</span>
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
        <div class="field">
          <label for="set-cards">Flashcards</label>
          <select id="set-cards">
            <option value="vocab" ${settings.flashcardStyle === "vocab" ? "selected" : ""}>Vocabulary &amp; concepts — term on the front, definition on the back</option>
            <option value="question" ${settings.flashcardStyle === "question" ? "selected" : ""}>Exam-style questions — question on the front, answer on the back</option>
          </select>
          <span class="hint">The default for new decks. You can still pick the other style when generating one.</span>
        </div>
        <div class="notice subtle">
          <strong>Build:</strong> ${esc((globalThis.SYMUS_CONFIG || {}).version || "unknown")}
          <span class="tiny">— if this is not the build you expect, hard-reload (Ctrl/Cmd-Shift-R).</span><br>
          <strong>Model:</strong> ${esc(settings.model)}<br>
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

        const modelSelect = root.querySelector("#set-model");
        const refresh = root.querySelector("#set-model-refresh");
        const statusEl = root.querySelector("#set-model-status");

        modelSelect.addEventListener("change", () => {
          syncCustomInput(root);
          const input = root.querySelector("#set-model-custom");
          if (input && modelSelect.value === CUSTOM_MODEL) input.focus();
        });
        syncCustomInput(root);

        refresh.addEventListener("click", () => loadModelCatalogue(root, { key: keyInput.value, statusEl, button: refresh }));

        // Load the catalogue straight away when a key is already available.
        if (keyInput.value.trim()) {
          loadModelCatalogue(root, { key: keyInput.value, statusEl, button: refresh });
        }

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
        const model = readModelField(root);
        if (!model) {
          const input = root.querySelector("#set-model-custom");
          if (input) {
            input.hidden = false;
            input.focus();
          }
          toast("Enter a model id, or pick one from the list.", "error");
          return false;
        }
        store.setSettings({
          apiKey: root.querySelector("#set-key").value,
          model,
          ocrLanguage: root.querySelector("#set-lang").value,
          ocrScale: Number(root.querySelector("#set-scale").value),
          flashcardStyle: root.querySelector("#set-cards").value,
        });
        toast("Settings saved.", "success");
      },
    });
  }

  /* ------------------------------------------------------------------ *
   * Flashcard deck actions
   * ------------------------------------------------------------------ */

  function moveCard(step) {
    const kit = store.getKit(route.id);
    if (!kit) return;
    const order = deckOrder(kit);
    if (!order.length) return;
    const next = Math.min(order.length - 1, Math.max(0, flashState.index + step));
    flashState.index = next;
    flashState.flipped = false;
    render();
  }

  function markCard(kind) {
    const kit = store.getKit(route.id);
    if (!kit) return;
    const order = deckOrder(kit);
    if (!order.length) return;
    const cardIndex = order[flashState.index];
    if (kind === "known") {
      flashState.known[cardIndex] = true;
      delete flashState.again[cardIndex];
    } else {
      flashState.again[cardIndex] = true;
      delete flashState.known[cardIndex];
    }
    if (flashState.index < order.length - 1) {
      flashState.index += 1;
      flashState.flipped = false;
      render();
    } else {
      flashState.flipped = false;
      render();
      toast("Last card in the deck.", "info");
    }
  }

  function shuffleDeck() {
    const kit = store.getKit(route.id);
    if (!kit) return;
    const order = deckOrder(kit).slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    flashState.order = order;
    flashState.index = 0;
    flashState.flipped = false;
    flashState.shuffled = true;
    render();
    toast("Deck shuffled.", "success");
  }

  function flashcardsToMarkdown(kit) {
    const set = kit.flashcards;
    const styleLabel = set.style === "question" ? "exam-style questions" : "vocabulary & concepts";
    const lines = [`# ${kit.name} — flashcards (${styleLabel})`, ""];
    if (set.sourceNames && set.sourceNames.length) lines.push(`Sources: ${set.sourceNames.join(", ")}`, "");
    set.items.forEach((card, index) => {
      lines.push(`**${index + 1}. ${card.front}**`, "", card.back, "");
    });
    return lines.join("\n");
  }

  /* ------------------------------------------------------------------ *
   * Timed exam
   * ------------------------------------------------------------------ */

  function startExam(kit) {
    if (!kit.exam || !kit.exam.items.length) {
      toast("Build an exam first.", "error");
      return;
    }
    examState = {
      kitId: kit.id,
      status: "running",
      answers: {},
      startedAt: Date.now(),
      endsAt: Date.now() + kit.exam.durationMinutes * 60 * 1000,
      secondsUsed: 0,
      result: null,
    };
    render();
    toast(`Exam started — ${kit.exam.durationMinutes} minutes on the clock.`);
  }

  function submitExam(reason = "manual") {
    if (examState.status !== "running") return;
    const kit = store.getKit(examState.kitId);
    if (!kit || !kit.exam) {
      resetExam(examState.kitId);
      render();
      return;
    }

    const items = kit.exam.items;
    let correct = 0;
    items.forEach((item, index) => {
      if (examState.answers[index] === item.answerIndex) correct += 1;
    });

    const limit = kit.exam.durationMinutes * 60;
    const secondsUsed = Math.min(limit, Math.max(0, Math.round((Date.now() - examState.startedAt) / 1000)));

    examState.status = "finished";
    examState.secondsUsed = secondsUsed;
    examState.result = { correct, total: items.length, secondsUsed, timedOut: reason === "timeout" };

    store.setKitExamAttempt(kit.id, {
      correct,
      total: items.length,
      takenAt: new Date().toISOString(),
      secondsUsed,
    });

    render();
    toast(
      reason === "timeout"
        ? `Time is up — scored ${correct}/${items.length}.`
        : `Exam submitted — ${correct}/${items.length}.`,
      correct / Math.max(1, items.length) >= 0.5 ? "success" : "info",
    );
  }

  /** One ticker for the whole page: updates the clock and enforces the limit. */
  function startExamTicker() {
    setInterval(() => {
      if (examState.status !== "running") return;
      const left = examSecondsLeft();
      const clock = document.getElementById("exam-clock");
      if (clock) {
        clock.textContent = formatClock(left);
        clock.classList.toggle("warn", left <= 60);
      }
      if (left <= 0) submitExam("timeout");
    }, 1000);
  }

  function openFlashcardOptions(kitId) {
    const kit = store.getKit(kitId);
    if (!kit) return;
    const withDocs = store.resourcesInKit(kit.id).filter((resource) => resource.document);
    // The saved preference wins; a deck's own style is the fallback.
    const defaultStyle =
      store.getSettings().flashcardStyle || (kit.flashcards && kit.flashcards.style) || "vocab";

    openModal({
      title: "Generate flashcards",
      confirmLabel: "Generate",
      body: `
        <div class="notice subtle">
          Cards are written from <strong>all ${plural(withDocs.length, "study document")}</strong> in
          “${esc(kit.name)}”. Each resource is asked for its own share, so the deck covers the whole kit.
        </div>
        <div class="field-row">
          <div class="field"><label for="cards-count">How many cards</label>
            <select id="cards-count">
              ${[10, 20, 30, 40].map((n) => `<option value="${n}" ${n === 20 ? "selected" : ""}>${n}</option>`).join("")}
            </select>
          </div>
          <div class="field"><label for="cards-style">Card style</label>
            <select id="cards-style">
              <option value="vocab" ${defaultStyle === "vocab" ? "selected" : ""}>Vocabulary &amp; concepts</option>
              <option value="question" ${defaultStyle === "question" ? "selected" : ""}>Exam-style questions</option>
            </select>
          </div>
        </div>
        <div class="notice subtle" id="cards-style-hint"></div>`,
      onMount: (root) => {
        const select = root.querySelector("#cards-style");
        const hint = root.querySelector("#cards-style-hint");
        const render = () => {
          hint.innerHTML =
            select.value === "question"
              ? "<strong>Question cards:</strong> the front is an exam-style question, the back is the model answer."
              : "<strong>Vocabulary cards:</strong> the front is a term or concept, the back is its definition.";
        };
        select.addEventListener("change", render);
        render();
      },
      onConfirm: (root) => {
        if (!withDocs.length) {
          toast("Add a resource with a study document first.", "error");
          return false;
        }
        if (!requireKey()) return false;
        const count = Number(root.querySelector("#cards-count").value);
        const style = root.querySelector("#cards-style").value === "question" ? "question" : "vocab";
        resetDeck(kit.id);
        jobs.makeFlashcards(kit, count, style);
        toast(style === "question" ? "Generating question cards…" : "Generating vocabulary cards…");
      },
    });
  }

  function openExamOptions(kitId) {
    const kit = store.getKit(kitId);
    if (!kit) return;
    const withDocs = store.resourcesInKit(kit.id).filter((resource) => resource.document);

    openModal({
      title: "Build a practice exam",
      confirmLabel: "Build exam",
      body: `
        <div class="notice subtle">
          A timed, multiple-choice paper from <strong>all ${plural(withDocs.length, "study document")}</strong> in
          “${esc(kit.name)}”. Questions are marked automatically, so short answers are not used.
        </div>
        <div class="field-row">
          <div class="field"><label for="exam-count">Questions</label>
            <select id="exam-count">
              ${[10, 15, 20, 25, 30]
                .map((n) => `<option value="${n}" ${n === 20 ? "selected" : ""}>${n}</option>`)
                .join("")}
            </select>
          </div>
          <div class="field"><label for="exam-time">Time limit</label>
            <select id="exam-time">
              <option value="">Auto (about 1¼ min per question)</option>
              ${[10, 15, 20, 30, 45, 60, 90]
                .map((n) => `<option value="${n}">${n} minutes</option>`)
                .join("")}
            </select>
          </div>
        </div>`,
      onConfirm: (root) => {
        if (!withDocs.length) {
          toast("Add a resource with a study document first.", "error");
          return false;
        }
        if (!requireKey()) return false;
        const count = Number(root.querySelector("#exam-count").value);
        const minutes = Number(root.querySelector("#exam-time").value) || null;
        resetExam(kit.id);
        jobs.makeExam(kit, count, minutes);
        toast("Building the exam…");
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
          Questions are spread across <strong>all ${plural(withDocs.length, "study document")}</strong> in
          “${esc(kit.name)}”. Each resource is asked for its own share, so every one of them is covered
          rather than the model focusing on a single document.
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
      case "open-kit":
        navigate(`#/kit/${id}`);
        break;
      case "export-backup":
        download(
          `symus-study-backup-${new Date().toISOString().slice(0, 10)}.json`,
          store.exportData(),
          "application/json",
        );
        toast("Backup exported.", "success");
        break;
      case "import-backup":
        $("import-file").click();
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
      case "make-flashcards": {
        const kit = store.getKit(id);
        if (kit) openFlashcardOptions(kit.id);
        break;
      }
      case "download-flashcards": {
        const kit = store.getKit(id);
        if (kit && kit.flashcards) {
          download(
            safeFileName(kit.name + " flashcards", "md"),
            flashcardsToMarkdown(kit),
            "text/markdown;charset=utf-8",
          );
        }
        break;
      }
      case "flip-card": {
        flashState.flipped = !flashState.flipped;
        render();
        break;
      }
      case "next-card":
        moveCard(1);
        break;
      case "prev-card":
        moveCard(-1);
        break;
      case "card-known":
        markCard("known");
        break;
      case "card-again":
        markCard("again");
        break;
      case "shuffle-cards":
        shuffleDeck();
        break;
      case "restart-cards": {
        const kit = store.getKit(route.id);
        if (kit) {
          resetDeck(kit.id);
          render();
        }
        break;
      }
      case "deck-list":
        flashState.showList = !flashState.showList;
        render();
        break;
      case "make-exam": {
        const kit = store.getKit(id);
        if (kit) openExamOptions(kit.id);
        break;
      }
      case "start-exam": {
        const kit = store.getKit(route.id);
        if (kit) startExam(kit);
        break;
      }
      case "retake-exam": {
        const kit = store.getKit(route.id);
        if (!kit || !kit.exam) break;
        openModal({
          title: "Retake this exam?",
          body: `<p>The same ${plural(kit.exam.items.length, "question")} with a fresh ${kit.exam.durationMinutes}-minute clock. Your previous score is replaced.</p>`,
          confirmLabel: "Start again",
          onConfirm: () => {
            resetExam(kit.id);
            startExam(kit);
          },
        });
        break;
      }
      case "exam-answer": {
        if (examState.status !== "running") break;
        examState.answers[Number(actionEl.dataset.q)] = Number(actionEl.dataset.opt);
        render();
        break;
      }
      case "submit-exam": {
        if (examState.status !== "running") break;
        const kit = store.getKit(examState.kitId);
        const unanswered = kit ? kit.exam.items.length - Object.keys(examState.answers).length : 0;
        if (unanswered > 0) {
          openModal({
            title: "Submit the exam?",
            body: `<p>${plural(unanswered, "question")} still unanswered. Unanswered questions are marked incorrect.</p>`,
            confirmLabel: "Submit",
            onConfirm: () => submitExam("manual"),
          });
        } else {
          submitExam("manual");
        }
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

    /* Theme: light by default, dark on demand; remembered per browser. */
    const themeButton = $("btn-theme");
    const applyTheme = (theme) => {
      document.documentElement.dataset.theme = theme;
      themeButton.innerHTML = theme === "dark" ? icon("sun") : icon("moon");
      themeButton.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", theme === "dark" ? "#0f1011" : "#ffffff");
    };
    applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    themeButton.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(next);
      try {
        localStorage.setItem("symus.theme", next);
      } catch (error) {
        /* private mode */
      }
    });

    /* Sidebar: collapse to an icon rail on wide screens. */
    const collapseButton = $("btn-collapse");
    const syncCollapse = () => {
      const collapsed = document.body.classList.contains("nav-collapsed");
      collapseButton.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
      collapseButton.setAttribute("aria-label", collapseButton.title);
      collapseButton.setAttribute("aria-expanded", String(!collapsed));
    };
    syncCollapse();
    collapseButton.addEventListener("click", () => {
      document.body.classList.toggle("nav-collapsed");
      try {
        localStorage.setItem("symus.nav", document.body.classList.contains("nav-collapsed") ? "collapsed" : "open");
      } catch (error) {
        /* private mode */
      }
      syncCollapse();
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
              finished.kind === "quiz"
                ? "Practice questions ready."
                : finished.kind === "flashcards"
                  ? "Flashcards ready."
                  : finished.kind === "exam"
                    ? "Practice exam ready."
                    : "Study document ready.",
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
      // Flashcard deck: Space flips, arrows walk the deck — unless the user is
      // typing somewhere or a dialog is open.
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
      if (
        route.name === "kit" &&
        route.tab === "flashcards" &&
        !typing &&
        !event.metaKey &&
        !event.ctrlKey &&
        els.modalRoot.hidden
      ) {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          flashState.flipped = !flashState.flipped;
          render();
          return;
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          moveCard(1);
          return;
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          moveCard(-1);
          return;
        }
      }
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

    startExamTicker();

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
