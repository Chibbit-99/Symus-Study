/**
 * Symus Study — boot
 *
 * Executed last by ARCH.js (see arch/config.json). Every module above this file
 * has already registered itself on window.Symus.
 *
 * This file must stay a plain browser script: ARCH.js injects it as a classic
 * <script>, so no import/export statements and no top-level await.
 */
(function (Symus) {
  "use strict";

  if (window.__symusStudyBooted) {
    console.warn("[Symus Study] Already started; ignoring a duplicate boot.");
    return;
  }
  window.__symusStudyBooted = true;

  const REQUIRED = ["store", "md", "ocr", "ai", "jobs", "ui"];

  function showFatal(message) {
    const view = document.getElementById("view");
    if (!view) return;
    view.innerHTML = "";
    const box = document.createElement("div");
    box.className = "page";
    box.innerHTML =
      '<div class="empty"><h2>Symus Study could not start</h2><p class="muted"></p></div>';
    box.querySelector("p").textContent = message;
    view.appendChild(box);
  }

  function boot() {
    const missing = REQUIRED.filter((name) => !Symus[name]);
    if (missing.length) {
      console.error("[Symus Study] Missing modules:", missing);
      showFatal(
        "These modules failed to load: " +
          missing.join(", ") +
          ". Check the browser console and that every file listed in arch/config.json exists.",
      );
      return;
    }

    try {
      Symus.ui.init();
    } catch (error) {
      console.error("[Symus Study] Startup failed:", error);
      showFatal(error && error.message ? error.message : String(error));
      return;
    }

    window.addEventListener("pagehide", () => {
      Symus.ocr.stopWorker();
    });

    window.dispatchEvent(new Event("symus-study:booted"));
    const config = globalThis.SYMUS_CONFIG || {};
    console.log(
      "[Symus Study] Ready. Build:",
      config.version || "unknown",
      "Model:",
      config.model || "nvidia/nemotron-3.5-lightning-30b-a3b",
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})((window.Symus = window.Symus || {}));
