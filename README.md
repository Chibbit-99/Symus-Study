# Symus Study — PDF OCR

A browser-based OCR tool built with the full ARCH.js project loading flow, PDF.js, and Tesseract.js.

## Run locally

Serve this folder over HTTP (do not open index.html directly with file://):

1. Download or clone this repository.
2. In the repository directory, run: python3 -m http.server 8000
3. Open http://localhost:8000 in your browser.

ARCH.js reads arch/config.json, loads npmloader.js, and then executes src/main.js.

## Features

- OCR for scanned/image-based PDFs.
- English, Japanese, English + Japanese, Simplified Chinese, French, German, and Spanish.
- All pages or first page only.
- Adjustable PDF render scale, progress, cancellation, editable results, clipboard copy, and .txt download.
- PDF processing runs in the browser; dependencies and OCR language data are downloaded online.

## Architecture

- index.html — user interface and ARCH.js runtime entry point.
- arch/config.json — enables npmloader.js and loads src/main.js.
- src/main.js — loads PDF.js and Tesseract.js, renders PDF pages, and performs OCR.

## Dependencies

- ARCH.js: https://chibbit-99.github.io/arch.js/
- PDF.js 4.4.168: https://mozilla.github.io/pdf.js/
- Tesseract.js 6.0.1: https://github.com/naptha/tesseract.js

This is an early project and has not yet been validated against every browser or PDF format. Very large documents and high render scales can use substantial memory.
