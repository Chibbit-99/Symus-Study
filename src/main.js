/**
 * StudyForge — boot
 *
 * Executed last by ARCH.js (see arch/config.json). Every module above this file
 * has already registered itself on window.StudyForge.
 *
 * This file must stay a plain browser script: ARCH.js injects it as a classic
 * <script>, so no import/export statements and no top-level await.
 */
(function (StudyForge) {
  "use strict";

  if (window.__studyForgeBooted) {
    console.warn("[StudyForge] Already started; ignoring a duplicate boot.");
    return;
  }
  window.__studyForgeBooted = true;

  const REQUIRED = ["store", "md", "ocr", "ai", "jobs", "ui"];

  function showFatal(message) {
    const view = document.getElementById("view");
    if (!view) return;
    view.innerHTML = "";
    const box = document.createElement("div");
    box.className = "page";
    box.innerHTML =
      '<div class="empty"><h2>StudyForge could not start</h2><p class="muted"></p></div>';
    box.querySelector("p").textContent = message;
    view.appendChild(box);
  }

  function boot() {
    const missing = REQUIRED.filter((name) => !StudyForge[name]);
    if (missing.length) {
      console.error("[StudyForge] Missing modules:", missing);
      showFatal(
        "These modules failed to load: " +
          missing.join(", ") +
          ". Check the browser console and that every file listed in arch/config.json exists.",
      );
      return;
    }

    try {
      StudyForge.ui.init();
    } catch (error) {
      console.error("[StudyForge] Startup failed:", error);
      showFatal(error && error.message ? error.message : String(error));
      return;
    }

    window.addEventListener("pagehide", () => {
      StudyForge.ocr.stopWorker();
    });

    window.dispatchEvent(new Event("studyforge:booted"));
    const config = globalThis.STUDYFORGE_CONFIG || {};
    console.log(
      "[StudyForge] Ready. Build:",
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
})((window.StudyForge = window.StudyForge || {}));
