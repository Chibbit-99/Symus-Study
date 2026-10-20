/**
 * ARCH.js startup module.
 *
 * Runs before the project files in arch/config.json and is awaited by ARCH.js.
 * Exports are placed on globalThis by the runtime, so every project file can
 * read `globalThis.SYMUS_CONFIG` without any import statements.
 *
 * Kept deliberately light: OCR and PDF libraries are loaded on demand inside
 * src/ocr.js so the dashboard paints immediately instead of waiting for a
 * multi-megabyte WASM package.
 *
 * See https://chibbit-99.github.io/arch.js/docs/#init
 */
export const SYMUS_CONFIG = Object.freeze({
  model: "nvidia/nemotron-3.5-lightning-30b-a3b",
  workerUrl: "https://symus-backend.chibbit99.workers.dev",
  tesseractPackage: "tesseract.js",
});
