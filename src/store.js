/**
 * Symus Study — data store
 *
 * Everything the app owns lives in localStorage under one key:
 *   classes  -> groups of study kits
 *   kits     -> study kits inside a class (or uncategorised)
 *   resources-> a PDF or pasted text inside a kit, plus its generated document
 *               and practice questions
 *   settings -> NVIDIA NIM API key
 *
 * Raw uploaded files and their extracted source text are never persisted: only
 * the generated document, questions and metadata are written to storage.
 */
(function (Symus) {
  "use strict";

  const STORAGE_KEY = "symus.study.v1";
  const VERSION = 1;

  const listeners = new Set();
  let state = null;
  let storageError = null;

  const uid = (prefix) =>
    `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const now = () => new Date().toISOString();

  function blankState() {
    return {
      version: VERSION,
      classes: [],
      kits: [],
      resources: [],
      settings: { apiKey: "", ocrLanguage: "eng", ocrScale: 2 },
    };
  }

  const OCR_LANGUAGES = ["eng", "jpn", "eng+jpn", "chi_sim", "fra", "deu", "spa"];
  const clampScale = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(3, Math.max(1, number)) : 2;
  };

  const str = (value, fallback = "") => (typeof value === "string" ? value : fallback);
  const arr = (value) => (Array.isArray(value) ? value : []);

  /** Coerce stored JSON into the expected shape; tolerates older or partial data. */
  function normalise(raw) {
    const next = blankState();
    if (!raw || typeof raw !== "object") return next;

    next.classes = arr(raw.classes)
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        id: str(item.id) || uid("cls"),
        name: str(item.name, "Untitled class"),
        createdAt: str(item.createdAt, now()),
      }));

    const classIds = new Set(next.classes.map((c) => c.id));
    next.kits = arr(raw.kits)
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        id: str(item.id) || uid("kit"),
        name: str(item.name, "Untitled kit"),
        classId: classIds.has(item.classId) ? item.classId : null,
        subject: str(item.subject),
        createdAt: str(item.createdAt, now()),
        updatedAt: str(item.updatedAt, now()),
        quiz: normaliseQuiz(item.quiz),
      }));

    const kitIds = new Set(next.kits.map((k) => k.id));
    next.resources = arr(raw.resources)
      .filter((item) => item && typeof item === "object" && kitIds.has(item.kitId))
      .map((item) => ({
        id: str(item.id) || uid("res"),
        kitId: item.kitId,
        name: str(item.name, "Untitled resource"),
        type: item.type === "text" ? "text" : "pdf",
        status: ["queued", "processing", "ready", "error"].includes(item.status)
          ? item.status
          : "queued",
        statusMessage: str(item.statusMessage),
        error: str(item.error),
        createdAt: str(item.createdAt, now()),
        updatedAt: str(item.updatedAt, now()),
        pages: normalisePages(item.pages),
        document: str(item.document),
        documentUpdatedAt: str(item.documentUpdatedAt),
      }));

    // Migration: practice questions used to belong to a single resource. Move a
    // surviving set up to its study kit instead of dropping it.
    for (const kit of next.kits) {
      if (kit.quiz) continue;
      const legacy = arr(raw.resources)
        .filter((item) => item && item.kitId === kit.id && item.quiz)
        .sort((a, b) => str(b.updatedAt).localeCompare(str(a.updatedAt)))[0];
      if (legacy) kit.quiz = normaliseQuiz(legacy.quiz);
    }

    const settings = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
    next.settings = {
      apiKey: str(settings.apiKey),
      ocrLanguage: OCR_LANGUAGES.includes(settings.ocrLanguage) ? settings.ocrLanguage : "eng",
      ocrScale: clampScale(settings.ocrScale),
    };
    return next;
  }

  function normalisePages(raw) {
    const pages = raw && typeof raw === "object" ? raw : {};
    return {
      total: Number.isFinite(pages.total) ? pages.total : 0,
      textPages: Number.isFinite(pages.textPages) ? pages.textPages : 0,
      ocrPages: arr(pages.ocrPages).filter(Number.isFinite),
      pendingOcr: arr(pages.pendingOcr).filter(Number.isFinite),
      gapNotes: str(pages.gapNotes),
      analysedAt: str(pages.analysedAt),
    };
  }

  function normaliseQuiz(raw) {
    if (!raw || typeof raw !== "object") return null;
    const items = arr(raw.items)
      .filter((item) => item && typeof item === "object" && str(item.question))
      .map((item) => ({
        type: item.type === "mcq" ? "mcq" : "short",
        question: str(item.question),
        options: arr(item.options).map((option) => str(option)),
        answerIndex: Number.isInteger(item.answerIndex) ? item.answerIndex : 0,
        answer: str(item.answer),
        explanation: str(item.explanation),
      }));
    if (!items.length) return null;
    return {
      generatedAt: str(raw.generatedAt),
      items,
      // Which resources the set was written from, so the UI can warn when a
      // newer document is not covered yet.
      sourceCount: Number.isFinite(raw.sourceCount) ? raw.sourceCount : 0,
      sourceNames: arr(raw.sourceNames).filter((name) => typeof name === "string"),
      truncated: raw.truncated === true,
    };
  }

  /* ------------------------------------------------------------------ *
   * Persistence
   * ------------------------------------------------------------------ */

  function readStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.warn("[Symus Study] Could not read saved data; starting fresh.", error);
      return null;
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      if (storageError) {
        storageError = null;
        emit();
      }
      return true;
    } catch (error) {
      storageError = error;
      console.warn("[Symus Study] Could not save to localStorage:", error);
      emit();
      return false;
    }
  }

  function emit() {
    for (const listener of listeners) {
      try {
        listener(state, storageError);
      } catch (error) {
        console.error("[Symus Study] Store listener failed:", error);
      }
    }
  }

  function commit() {
    persist();
    emit();
  }

  /* ------------------------------------------------------------------ *
   * Lookups
   * ------------------------------------------------------------------ */

  const get = () => state;
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const getClass = (id) => state.classes.find((item) => item.id === id) || null;
  const getKit = (id) => state.kits.find((item) => item.id === id) || null;
  const getResource = (id) => state.resources.find((item) => item.id === id) || null;
  const kitsInClass = (classId) =>
    state.kits.filter((kit) => (classId ? kit.classId === classId : true));
  const resourcesInKit = (kitId) =>
    state.resources
      .filter((resource) => resource.kitId === kitId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  /* ------------------------------------------------------------------ *
   * Mutations
   * ------------------------------------------------------------------ */

  function addClass(name) {
    const cls = { id: uid("cls"), name: str(name).trim() || "New class", createdAt: now() };
    state.classes.push(cls);
    commit();
    return cls;
  }

  function renameClass(id, name) {
    const cls = getClass(id);
    if (!cls || !str(name).trim()) return false;
    cls.name = name.trim();
    commit();
    return true;
  }

  function deleteClass(id) {
    const index = state.classes.findIndex((item) => item.id === id);
    if (index < 0) return false;
    state.classes.splice(index, 1);
    for (const kit of state.kits) {
      if (kit.classId === id) {
        kit.classId = null;
        kit.updatedAt = now();
      }
    }
    commit();
    return true;
  }

  function addKit({ name, classId = null, subject = "" } = {}) {
    const kit = {
      id: uid("kit"),
      name: str(name).trim() || "New study kit",
      classId: classId && getClass(classId) ? classId : null,
      subject: str(subject).trim(),
      createdAt: now(),
      updatedAt: now(),
      quiz: null,
    };
    state.kits.push(kit);
    commit();
    return kit;
  }

  function updateKit(id, patch = {}) {
    const kit = getKit(id);
    if (!kit) return null;
    if (typeof patch.name === "string" && patch.name.trim()) kit.name = patch.name.trim();
    if ("classId" in patch) kit.classId = patch.classId && getClass(patch.classId) ? patch.classId : null;
    if (typeof patch.subject === "string") kit.subject = patch.subject.trim();
    kit.updatedAt = now();
    commit();
    return kit;
  }

  function deleteKit(id) {
    const index = state.kits.findIndex((item) => item.id === id);
    if (index < 0) return false;
    state.kits.splice(index, 1);
    state.resources = state.resources.filter((resource) => resource.kitId !== id);
    commit();
    return true;
  }

  function touchKit(kitId) {
    const kit = getKit(kitId);
    if (kit) kit.updatedAt = now();
  }

  function addResource({ kitId, name, type = "pdf" } = {}) {
    if (!getKit(kitId)) return null;
    const resource = {
      id: uid("res"),
      kitId,
      name: str(name).trim() || "Untitled resource",
      type: type === "text" ? "text" : "pdf",
      status: "queued",
      statusMessage: "",
      error: "",
      createdAt: now(),
      updatedAt: now(),
      pages: normalisePages(null),
      document: "",
      documentUpdatedAt: "",
    };
    state.resources.push(resource);
    touchKit(kitId);
    commit();
    return resource;
  }

  function updateResource(id, patch = {}) {
    const resource = getResource(id);
    if (!resource) return null;
    for (const [key, value] of Object.entries(patch)) {
      if (key === "pages") resource.pages = normalisePages(value);
      else if (key === "id" || key === "kitId" || key === "createdAt") continue;
      else resource[key] = value;
    }
    resource.updatedAt = now();
    touchKit(resource.kitId);
    commit();
    return resource;
  }

  function setResourceDocument(id, markdown) {
    const resource = getResource(id);
    if (!resource) return null;
    resource.document = str(markdown);
    resource.documentUpdatedAt = now();
    resource.updatedAt = now();
    touchKit(resource.kitId);
    commit();
    return resource;
  }

  function setKitQuiz(kitId, quiz) {
    const kit = getKit(kitId);
    if (!kit) return null;
    kit.quiz = normaliseQuiz(quiz);
    kit.updatedAt = now();
    commit();
    return kit;
  }

  function deleteResource(id) {
    const index = state.resources.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const [removed] = state.resources.splice(index, 1);
    touchKit(removed.kitId);
    commit();
    return true;
  }

  function setApiKey(key) {
    state.settings.apiKey = str(key).trim();
    commit();
    return state.settings.apiKey;
  }

  function setSettings(patch = {}) {
    if ("apiKey" in patch) state.settings.apiKey = str(patch.apiKey).trim();
    if ("ocrLanguage" in patch) {
      state.settings.ocrLanguage = OCR_LANGUAGES.includes(patch.ocrLanguage) ? patch.ocrLanguage : "eng";
    }
    if ("ocrScale" in patch) state.settings.ocrScale = clampScale(patch.ocrScale);
    commit();
    return state.settings;
  }

  const getSettings = () => ({ ...state.settings });
  const getApiKey = () => state.settings.apiKey || "";

  /* ------------------------------------------------------------------ *
   * Backup / restore / storage stats
   * ------------------------------------------------------------------ */

  function exportData() {
    return JSON.stringify({ app: "symus-study", exportedAt: now(), data: state }, null, 2);
  }

  /** Merge an exported backup into the current state. Returns counts. */
  function importData(json) {
    let parsed;
    try {
      parsed = typeof json === "string" ? JSON.parse(json) : json;
    } catch (error) {
      throw new Error("That file is not valid JSON.");
    }
    const data = parsed && parsed.data ? parsed.data : parsed;
    if (!data || typeof data !== "object" || (!data.kits && !data.classes && !data.resources)) {
      throw new Error("That file does not look like a Symus Study backup.");
    }
    const incoming = normalise(data);
    const classMap = new Map();
    const kitMap = new Map();
    let added = { classes: 0, kits: 0, resources: 0 };

    for (const cls of incoming.classes) {
      const existing = state.classes.find((item) => item.name.toLowerCase() === cls.name.toLowerCase());
      if (existing) classMap.set(cls.id, existing.id);
      else {
        state.classes.push(cls);
        classMap.set(cls.id, cls.id);
        added.classes++;
      }
    }
    for (const kit of incoming.kits) {
      if (state.kits.some((item) => item.id === kit.id)) continue;
      kit.classId = kit.classId ? classMap.get(kit.classId) || null : null;
      state.kits.push(kit);
      kitMap.set(kit.id, kit.id);
      added.kits++;
    }
    for (const resource of incoming.resources) {
      if (state.resources.some((item) => item.id === resource.id)) continue;
      resource.kitId = kitMap.get(resource.kitId);
      if (!resource.kitId) continue;
      state.resources.push(resource);
      added.resources++;
    }
    if (incoming.settings.apiKey && !state.settings.apiKey) state.settings.apiKey = incoming.settings.apiKey;
    commit();
    return added;
  }

  function storageBytes() {
    try {
      return new Blob([JSON.stringify(state)]).size;
    } catch (error) {
      return JSON.stringify(state).length;
    }
  }

  function load() {
    state = normalise(readStorage());
    emit();
    return state;
  }

  Symus.store = {
    STORAGE_KEY,
    load,
    get,
    subscribe,
    getClass,
    getKit,
    getResource,
    kitsInClass,
    resourcesInKit,
    addClass,
    renameClass,
    deleteClass,
    addKit,
    updateKit,
    deleteKit,
    addResource,
    updateResource,
    setResourceDocument,
    setKitQuiz,
    deleteResource,
    setApiKey,
    setSettings,
    getSettings,
    OCR_LANGUAGES,
    getApiKey,
    exportData,
    importData,
    storageBytes,
    getStorageError: () => storageError,
  };
})((window.Symus = window.Symus || {}));
