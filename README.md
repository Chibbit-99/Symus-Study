# Symus Study — OCR & AI Study Notes

A browser-based study tool that extracts text from PDFs locally, then optionally uses NVIDIA NIM's `google/diffusiongemma-26b-a4b-it` model to turn the extracted text into study notes.

## Run locally

Serve this folder over HTTP (do not open `index.html` directly with `file://`):

1. Download or clone this repository.
2. In the repository directory, run: `python3 -m http.server 8000`
3. Open `http://localhost:8000` in your browser.

ARCH.js reads `arch/config.json`, loads `npmloader.js`, and then executes `src/main.js`.

## Features

- OCR for scanned/image-based PDFs using Tesseract.js.
- English, Japanese, English + Japanese, Simplified Chinese, French, German, and Spanish OCR options.
- Process all pages or only the first page; adjustable render scale, progress, cancellation, editable OCR output, clipboard copy, and text download.
- Bring your own NVIDIA NIM API key to generate study notes with `google/diffusiongemma-26b-a4b-it`.
- Study-note styles: concise revision notes, detailed explanations, exam-focused notes with practice questions, and flashcards.
- Optional subject/focus field; longer OCR text is split into sections and each section is processed separately.
- Copy generated notes or download them as Markdown.

## NVIDIA NIM setup

1. Create or obtain an NVIDIA API key from the [NVIDIA model page](https://build.nvidia.com/google/diffusiongemma-26b-a4b-it).
2. Extract text from a PDF, or paste text into the extracted-text box.
3. Enter your API key in the NVIDIA NIM field, choose a notes style, and select **Generate study notes**.

The page calls the OpenAI-compatible endpoint at `https://integrate.api.nvidia.com/v1/chat/completions` with the model `google/diffusiongemma-26b-a4b-it`.

**Key handling and privacy:** the key is kept only in the page's JavaScript memory and is not saved in local storage. The browser sends the key and extracted text directly to NVIDIA when you request notes. Do not use this feature with confidential text. Clear the key when finished. If the browser blocks the request, check network access and whether the provider allows browser-origin requests; do not put a private key into the repository or source code.

## Architecture

- `index.html` — OCR interface and NVIDIA NIM study-notes interface.
- `arch/config.json` — enables `npmloader.js` and loads `src/main.js`.
- `src/main.js` — loads PDF.js and Tesseract.js, performs OCR, and sends user-requested note-generation requests to NVIDIA NIM.

## Dependencies

- ARCH.js: https://chibbit-99.github.io/arch.js/
- PDF.js 4.4.168: https://mozilla.github.io/pdf.js/
- Tesseract.js 6.0.1: https://github.com/naptha/tesseract.js
- NVIDIA NIM API: https://docs.api.nvidia.com/nim/reference/diffusiongemma-26b-a4b-it-infer

## Limitations

This project has not yet been fully browser-tested against every browser, PDF, API-key configuration, or provider-side CORS policy. Large PDFs can use substantial memory, and very long extracted text may require multiple model requests. AI-generated notes can contain errors; compare them against the original source.
