# Symus Study

A browser-only study workspace. Organise **classes → study kits → resources**, turn PDFs and pasted
text into complete AI-written study documents, and generate practice questions from them.

No build step, no backend to run, no dependencies to install. Your data stays in your browser.

## Quick start

Serve the folder over HTTP (not `file://`):

```bash
python3 -m http.server 8000
```

Open <http://localhost:8000>, open **Settings**, paste an NVIDIA NIM API key, and create a study kit.

## What you can do

### Dashboard

- **Study kits** hold resources. Each kit card shows its class, resource count and last update.
- **Classes** group kits (e.g. *Year 11 Biology*). Create, rename and delete classes; kits are moved
  between classes from the dashboard or the kit page.
- **Rename** kits, edit their subject/focus, move them, delete them.
- **Search** (⌘K / Ctrl-K) matches kit names, subjects and resource names.
- **Export / Import** a JSON backup of everything.

### Study kit tabs

Each study kit is split into three tabs (each with its own URL, so back/forward and bookmarks work):

| Tab | URL | What it shows |
| --- | --- | --- |
| **Resources** | `#/kit/<id>` | Add PDFs/pasted text and see every resource with its status. |
| **Study documents** | `#/kit/<id>/documents` | Read the generated document for any resource in the kit, with copy/download. |
| **Practice questions** | `#/kit/<id>/questions` | Questions written from **all** documents in the kit. |

### Study kits and resources

A resource is either a **PDF** or **pasted text**. Adding one runs the extraction pipeline:

```
PDF   ┌──────────────┐   ┌───────────────┐   ┌─────────────────┐   ┌──────────────────┐
      │ read the PDF │ → │ AI gap check  │ → │ OCR only the    │ → │ AI study document│
      │ text layer   │   │ which pages   │   │ flagged pages   │   │ (saved locally)  │
      └──────────────┘   │ lost content? │   └─────────────────┘   └──────────────────┘
                         └───────────────┘
text  ┌──────────────────┐   ┌──────────────────┐
      │ pasted text      │ → │ AI study document│
      └──────────────────┘   └──────────────────┘
```

**Why the gap check exists:** a PDF's text layer is normally enough, but scanned pages, image-only
pages and vector text have none. Instead of OCR-ing every page (slow), Symus Study asks the model to
audit page-by-page character counts and previews:

- pages with **no text at all** are always OCR'd;
- pages the model flags as damaged or incomplete are OCR'd;
- if the model is unavailable (no key, rate limit, error), a local heuristic flags pages far shorter
  than the document median, and the resource notes say the gap check failed.

OCR uses Tesseract.js at the render quality and language set in **Settings**. The OCR worker is reused
across pages and jobs, and only downloaded the first time a page actually needs OCR.

The extracted text (text layer + OCR) is then merged and sent to the model in ~24 000-character
sections, each of which becomes part of one complete Markdown study document.

### Study documents

- Rendered as Markdown, or edited in place (manual corrections are saved).
- Copy or download as `.md`.
- The document is saved to `localStorage`; **the uploaded file and its raw extracted text are not**.

### Practice questions (per study kit)

Questions belong to the whole **study kit**, not to a single resource: every study document in the kit
is combined and sent to the model together, so the set tests the kit as a whole.

- Choose 5–25 questions and a difficulty; the model writes a mix of multiple-choice and short-answer
  questions and is told to cover every resource in proportion to its size.
- Very large kits are sampled rather than cut off at the front: each resource contributes a
  proportional slice (up to ~60 000 characters in total), and the questions tab says so.
- The tab records which resources the current set was built from and warns when a newer document is
  not covered yet — regenerate to include it.
- Answer MCQs inline (immediate right/wrong marking plus an explanation), reveal model answers for
  short questions, and download the set as Markdown.

## Data and privacy

| Data | Where it lives |
| --- | --- |
| Classes, kits, resources, documents, questions | `localStorage` under `symus.study.v1` (questions live on the kit) |
| NVIDIA NIM API key | `localStorage` (same key), sent only with your requests |
| Uploaded PDFs and their raw extracted text | memory only, discarded when processing ends |
| Generated documents / questions | `localStorage` — use **Export** regularly |

The API key is saved in this browser so you do not have to paste it every session. Anyone with access
to this browser profile can read it; use **Settings → Delete all data** to clear everything, and never
use a shared machine with a billable key.

Note requests go to the Symus Cloudflare Worker, which forwards them to NVIDIA and does not store the
key:

```
browser → https://symus-backend.chibbit99.workers.dev/api/notes → https://integrate.api.nvidia.com/v1/chat/completions
```

Model: `nvidia/nemotron-3.5-lightning-30b-a3b`. Its strongest languages are English, Spanish, French,
German, Italian and Japanese.

`localStorage` holds roughly 5 MB. The sidebar shows usage; if it fills up, **Export** a backup and
delete old resources.

## ARCH.js runtime

The app follows the layout documented at <https://chibbit-99.github.io/arch.js/docs/>:

```
index.html            loads releases/latest.js
arch/config.json      modules: ["npmloader.js"], js: [seven project files, in order]
arch/init.js          exports SYMUS_CONFIG { model, workerUrl }
src/*.js              application code executed by ARCH.js
```

- **Project files run in order.** ARCH.js fetches and executes each file in `config.json → js`:
  `store → markdown → ocr → ai → jobs → ui → main`. Each registers itself on `window.Symus`;
  `main.js` boots the UI once everything is present.
- **No module syntax in project files.** ARCH.js injects them as classic scripts, so there are no
  `import`/`export` statements and no top-level `await` in `src/`.
- **init.js is light.** It exports configuration only. PDF.js and Tesseract.js load on demand so the
  dashboard paints immediately; Tesseract is requested through the documented `importPackage()`
  package API with a jsDelivr ESM fallback.
- **One loader.** There is no `<script type="module" src="./src/main.js">`; the page-level fallback in
  `index.html` only fires if ARCH.js never loads or never finishes, and `main.js` refuses to boot twice.
- `releases/latest.js` is used because the documented `export const … = await importPackage(…)`
  `init.js` syntax is only supported by the current build (`v0.1.1-alpha` runs `init.js` as an async
  function, where `export` is a syntax error). ARCH.js is experimental; re-check when pinning.

## Project structure

| File | Purpose |
| --- | --- |
| `index.html` | App shell, styles, ARCH.js runtime tag and fallback loader. |
| `arch/config.json` | ARCH.js modules and the ordered project file list. |
| `arch/init.js` | Exports `SYMUS_CONFIG` (model, worker URL). |
| `src/store.js` | localStorage data model: classes, kits, resources, settings, backup/restore. |
| `src/markdown.js` | Small, safe Markdown renderer (HTML escaped, safe links only). |
| `src/ocr.js` | PDF.js text-layer extraction, Tesseract OCR of selected pages, text reconstruction. |
| `src/ai.js` | NIM client: gap analysis, document generation, question generation, chunking, retries. |
| `src/jobs.js` | Sequential job queue and the extraction pipeline. |
| `src/ui.js` | Dashboard, kit and resource views, modals, toasts, job bar. |
| `src/main.js` | Boot. |
| `worker.js` | Cloudflare Worker proxying `/api/notes` to NVIDIA NIM. |
| `wrangler.toml` | Worker configuration. |

## Deploying the Worker

```bash
npx wrangler deploy
```

```toml
name = "symus-backend"
main = "worker.js"
compatibility_date = "2026-09-01"

[vars]
SYMUS_ORIGIN = "https://chibbit-99.github.io"
SYMUS_MODELS = "nvidia/nemotron-3.5-lightning-30b-a3b"
```

- `SYMUS_ORIGIN` — comma-separated allowed origins. Localhost on any port is always allowed.
- `SYMUS_MODELS` — model allow-list; anything else is rejected.
- Only known fields (`model`, `messages`, `max_tokens`, `temperature`, `top_p`,
  `chat_template_kwargs.enable_thinking`) are forwarded, `stream` is forced off, bodies are capped at
  1 MB and roles/token counts are validated, so the Worker cannot be used as a general NIM relay.
- `GET /health` returns `{ "ok": true }`.

## Limitations

- `localStorage` is per-browser and per-origin; clearing site data deletes your library. Export backups.
- OCR quality depends on scan quality, language and render scale. Very large PDFs at 3× use a lot of
  memory, and OCR runs at a few seconds per page.
- The OCR limit is 60 pages per run; any flagged pages beyond that are reported on the resource and
  need a re-run.
- Long resources are split into sections, so cross-section connections can be weaker. If a section hits
  the output-token limit the resource status says which part may be short.
- AI output can be wrong or can miss nuance: check it against the source before revising from it.
- Not exhaustively tested in every browser; it relies on modern ES2022 features.

## Dependencies

- ARCH.js — <https://chibbit-99.github.io/arch.js/>
- PDF.js 4.4.168 — <https://mozilla.github.io/pdf.js/>
- Tesseract.js 6.0.1 — <https://github.com/naptha/tesseract.js>
- NVIDIA NIM / Nemotron 3.5 Lightning — <https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b>
- Cloudflare Workers — <https://developers.cloudflare.com/workers/>
