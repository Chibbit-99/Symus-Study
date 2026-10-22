/**
 * Symus Study — one-time kit sharing.
 *
 * A share uploads the finished study documents of a kit (never the PDFs, never
 * the API key) to the Symus Cloudflare Worker, which stores them in its
 * SHARING_KV namespace under a random id. The app hands out
 * `#/share/<id>`, and the reader's browser deletes the record from the Worker as
 * soon as the page has rendered, so a link works once.
 *
 * Wire format
 *   POST   /api/shares      { name, subject, resources: [{ name, type, document }] }
 *                           -> { id, expiresAt, resources }
 *   GET    /api/shares/<id> -> { id, name, subject, sharedAt, resources }
 *   DELETE /api/shares/<id> -> { ok: true }
 */
(function (Symus) {
  "use strict";

  const CONFIG = globalThis.SYMUS_CONFIG || {};
  const WORKER_URL = CONFIG.workerUrl || "https://symus-backend.chibbit99.workers.dev";

  const SHARE_ROUTE = "#/share/";
  // Kept in sync with the Worker limits so a failure is explained before it is
  // sent, rather than as a 400 from the backend.
  const MAX_SHARE_BYTES = 900_000;
  const MAX_SHARE_RESOURCES = 40;

  function shareUrl(id) {
    const base = `${location.origin}${location.pathname}`.replace(/\/index\.html$/, "/");
    return `${base}${SHARE_ROUTE}${id}`;
  }

  function shareIdFromHash(hash) {
    const match = /^#?\/?share\/([a-z0-9]{4,64})\/?$/i.exec(String(hash || "").trim());
    return match ? match[1].toLowerCase() : null;
  }

  /** The documents of a kit, in display order. Empty documents are skipped. */
  function collectDocuments(kit, resources) {
    return (resources || [])
      .filter((resource) => resource.document && resource.document.trim())
      .map((resource) => ({
        name: resource.name,
        type: resource.type === "pdf" ? "pdf" : "text",
        document: resource.document,
      }));
  }

  /** Byte-ish size check, matching how the Worker measures the payload. */
  function estimateSize(payload) {
    try {
      return JSON.stringify(payload).length;
    } catch (error) {
      return Infinity;
    }
  }

  /**
   * Why a kit cannot be shared yet, or "" when it can.
   * Checked in the UI before the request so the message is specific.
   */
  function checkSharable(documents) {
    if (!documents.length) {
      return "This study kit has no study documents yet. Process at least one resource before sharing.";
    }
    if (documents.length > MAX_SHARE_RESOURCES) {
      return `A share can hold at most ${MAX_SHARE_RESOURCES} resources. This kit has ${documents.length}.`;
    }
    return "";
  }

  function errorFrom(response, data, fallback) {
    const detail =
      data && data.error
        ? String(data.error.message || data.error) + (data.detail ? " " + data.detail : "")
        : fallback;
    const error = new Error(detail || `HTTP ${response.status}`);
    error.status = response.status;
    error.gone = Boolean(data && data.gone);
    return error;
  }

  async function readJson(response) {
    const raw = await response.text();
    try {
      return JSON.parse(raw);
    } catch (error) {
      return null;
    }
  }

  /**
   * Upload a kit's study documents and get the share id back.
   * @returns {Promise<{id:string, url:string, expiresAt:string, resources:number}>}
   */
  async function createShare({ name, subject = "", documents, signal } = {}) {
    const problem = checkSharable(documents || []);
    if (problem) throw new Error(problem);

    const payload = { name, subject, resources: documents };
    if (estimateSize(payload) > MAX_SHARE_BYTES) {
      throw new Error(
        "This kit is too large to share (the limit is 900 kB of study documents). Share fewer resources, or shorten them.",
      );
    }

    let response;
    try {
      response = await fetch(WORKER_URL + "/api/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      if (error && error.name === "AbortError") throw error;
      throw new Error("Could not reach the share service. Check your connection and try again.");
    }

    const data = await readJson(response);
    if (!response.ok) throw errorFrom(response, data, `Sharing failed (HTTP ${response.status}).`);
    if (!data || typeof data.id !== "string") {
      throw new Error("The share service returned an unexpected response.");
    }

    return {
      id: data.id,
      url: shareUrl(data.id),
      expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : "",
      resources: Number(data.resources) || 0,
    };
  }

  /** Read a share. Does not consume it — the caller deletes it after rendering. */
  async function openShare(id, { signal } = {}) {
    let response;
    try {
      response = await fetch(WORKER_URL + "/api/shares/" + encodeURIComponent(id), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal,
      });
    } catch (error) {
      if (error && error.name === "AbortError") throw error;
      throw new Error("Could not reach the share service. Check your connection and try again.");
    }

    const data = await readJson(response);
    if (!response.ok) throw errorFrom(response, data, "This share could not be opened.");
    if (!data || !Array.isArray(data.resources)) {
      throw new Error("This share is not in a format this app understands.");
    }

    return {
      id: typeof data.id === "string" ? data.id : id,
      name: typeof data.name === "string" && data.name.trim() ? data.name : "Shared study kit",
      subject: typeof data.subject === "string" ? data.subject : "",
      sharedAt: typeof data.sharedAt === "string" ? data.sharedAt : "",
      resources: data.resources
        .filter((entry) => entry && typeof entry === "object" && typeof entry.document === "string")
        .map((entry) => ({
          name: typeof entry.name === "string" && entry.name.trim() ? entry.name : "Untitled resource",
          type: entry.type === "pdf" ? "pdf" : "text",
          document: entry.document,
        })),
    };
  }

  /**
   * Delete a share — the step that makes the link one-time.
   * Best effort: the page has already been shown, so a failure only means the
   * record lingers until its TTL. Returns true when the Worker confirmed it.
   */
  async function consumeShare(id) {
    try {
      const response = await fetch(WORKER_URL + "/api/shares/" + encodeURIComponent(id), {
        method: "DELETE",
        headers: { Accept: "application/json" },
      });
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  Symus.share = {
    shareUrl,
    shareIdFromHash,
    collectDocuments,
    checkSharable,
    createShare,
    openShare,
    consumeShare,
    MAX_SHARE_RESOURCES,
  };
})((window.Symus = window.Symus || {}));
