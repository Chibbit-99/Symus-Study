# Symus Study

**Live app: <https://chibbit-99.github.io/Symus-Study/>**

A browser-only study workspace. Organise **classes → study kits → resources**, turn PDFs and pasted
text into condensed AI-written summary study notes, and generate practice questions, flashcards and a
timed exam from them.

No build step, no install, no server of your own. Your data stays in your browser.

## Using the hosted app

The app is deployed to GitHub Pages at <https://chibbit-99.github.io/Symus-Study/>:

1. Open the URL.
2. Open **Settings** and paste your NVIDIA NIM API key (saved in that browser only).
3. Create a class, then a study kit, then add a PDF or paste text.

Everything except the AI calls runs in the tab. Note requests go to the Symus Cloudflare Worker,
which forwards them to NVIDIA NIM.

### GitHub Pages deployment

The repository is a static site with no build step, so Pages serves it as-is:

- Source: the `main` branch, `/` (root) folder.
- After merging to `main`, give the Pages deployment a minute, then reload.
- Confirm the running build under **Settings → Build**, or the console line
  `[Symus Study] Ready. Build: …`. An older build means Pages has not caught up yet, or the
  browser is caching (see below).

## Running locally

Serve the folder over HTTP (not `file://`):

```bash
python3 dev-server.py          # http://localhost:8000, caching disabled
```

`dev-server.py` is `http.server` plus `Cache-Control: no-store`, so a normal reload always
shows the current build. Plain `python3 -m http.server` sends no cache headers, which lets the
browser keep serving an old `src/*.js` after you update the code — the page looks unchanged
even though the files on disk are new.

Open <http://localhost:8000>, open **Settings**, paste an NVIDIA NIM API key, and create a study kit.

**Confirming which build you are running:** every project file is requested with a `?v=` token
(matched in `arch/config.json` and the fallback list in `index.html`), the startup log prints
`Build: <version>`, and **Settings → Build** shows it. If that version is not the one you expect,
hard-reload with Ctrl/Cmd-Shift-R. When releasing, bump the token in both places and
`version` in `arch/init.js`.

## What you can do

### Interface

A light, minimal layout with a grouped sidebar:

- **Sidebar** — *Main* (Dashboard), *Classes* (one row per class with its kit count, then **New class**),
  and *Data* (export/import). Settings sits in the footer above a small storage meter and the current
  library summary.
- **Theme** — light by default; the moon/sun button in the sidebar header switches to dark and is
  remembered per browser.
- **Collapse** — the chevron folds the sidebar into an icon rail (also remembered).
- **Floating +** (bottom right) creates a study kit from anywhere.
- **Page headers** use a quiet eyebrow, a large title and actions on the right, with content in flat
  bordered rows rather than a dense card grid.

### Dashboard

- **Study kits** hold resources. Each kit row shows the resource count as a large figure, its class,
  what has been generated (questions, cards, exam) and the last update.
- **Classes** group kits (e.g. *Year 11 Biology*). Create, rename and delete classes; kits are moved
  between classes from the dashboard or the kit page.
- **Rename** kits, edit their subject/focus, move them, delete them.
- **Search** (⌘K / Ctrl-K) matches kit names, subjects and resource names.
- **Export / Import** a JSON backup of everything.

### Study kit tabs

Each study kit is split into five tabs (each with its own URL, so back/forward and bookmarks work):

| Tab | URL | What it shows |
| --- | --- | --- |
| **Resources** | `#/kit/<id>` | Add PDFs/pasted text and see every resource with its status. |
| **Study documents** | `#/kit/<id>/documents` | Read the generated document for any resource in the kit, with copy/download. |
| **Practice questions** | `#/kit/<id>/questions` | Questions written from **all** documents in the kit. |
| **Flashcards** | `#/kit/<id>/flashcards` | A revision deck written from **all** documents, with a card player. |
| **Practice exam** | `#/kit/<id>/exam` | A timed, auto-marked multiple-choice paper from **all** documents. |

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
sections. Each section is **condensed** into summary notes — around a third of its length, in the
model's own words — and the sections are joined into one Markdown study document.

### Study documents

The document is **summary study notes**, not a reformatted copy of the resource:

- Each idea is rewritten in condensed form — definitions, formulas, dates, named examples, processes
  and comparisons survive; repetition, filler, tangents and pointless examples do not.
- The target is roughly **one third of the source length** (25–35% of its words), never more than half.
- Headings group themes, bullets keep it skimmable, key terms are bold, comparisons become tables, and
  a short **Key takeaways** list closes the notes.
- The prompt explicitly forbids copying source sentences: if a sentence could be pasted back into the
  original unchanged, it must be rewritten or dropped.

- Rendered as Markdown, or edited in place (manual corrections are saved).
- Copy or download as `.md`.
- The document is saved to `localStorage`; **the uploaded file and its raw extracted text are not**.

#### Watching a document being written (streaming)

The study document is **streamed**, not delivered all at once:

- The Worker asks NVIDIA NIM for a server-sent-events response (`{"stream": true}`) and pipes the
  events straight back, so nothing is buffered on the way.
- The app renders the markdown as it arrives: open the resource while it is processing
  (**View live** in the job bar, the resource in **Study documents**, or by clicking the resource)
  and you see the text grow, with a live character count and part indicator.
- The view follows the writing while you are at the bottom of the panel and stops following when you
  scroll up, so reading earlier sections is not interrupted.
- Only the finished document is saved to `localStorage`; the partial text lives in memory and is
  discarded if the job fails or is cancelled.
- If the Worker has not been redeployed with streaming support, the app falls back to a normal
  non-streaming request and shows the document once it is complete.

### Practice questions (per study kit)

Questions belong to the whole **study kit**: every study document in it is covered.

A single prompt containing every document does not work — the model drifts towards whichever resource
is most salient and effectively ignores the rest. So the kit's questions are **allocated per
resource**:

1. Each resource gets a quota: one question minimum, and the remainder shared in proportion to
   document length (largest-remainder rounding, so quotas always add up to the requested count).
   With fewer questions than resources, the largest documents get them.
2. Each resource is generated **in its own request**, prompted with only that document and told
   exactly how many questions to write about it.
3. Results are interleaved (so the set is not blocked by resource) and de-duplicated.
4. If the model returns fewer than requested, or a pass fails, one bounded top-up pass asks the
   resources that did produce questions for the shortfall.

Consequences you will see in the questions tab:

- A **coverage chip per resource** showing how many questions it produced.
- Specific warnings when a resource produced none, when a newer document is not covered yet,
  and when a resource's request failed (the other resources' questions are still saved).
- Progress reports which resource is being written and how many questions it is asked for.
- Answer MCQs inline (immediate right/wrong marking plus an explanation), reveal model answers for
  short questions, and download the set as Markdown.

### Flashcards (per study kit)

A deck of revision cards, written the same way: **allocated per resource**, one request each, then
merged, de-duplicated by prompt and interleaved so the deck is not grouped by resource.

- Each card is one fact: a **front** you are cued with and a **back** you try to recall.
- Choose 10, 20, 30 or 40 cards.
- **Two deck styles**, set under **Settings → Flashcards**:
  - **Vocabulary & concepts** — the front is the *term or concept* (no question mark), the back is its
    definition or explanation. Best for definitions, names and key ideas.
  - **Exam-style questions** — the front is an actual question ending in `?`, the back is the model
    answer. Best for rehearsing how you would answer in a paper.
  The generate dialog defaults to your saved style and lets you pick the other one for a single deck;
  the deck records which style it was written in and labels the card faces accordingly.
- The player shows one card at a time: click it (or press **Space**) to reveal the answer, **←/→** to
  move through the deck, **Got it** / **Still learning** to rate a card as you go.
- **Shuffle** randomises the order, **Restart** returns to the first card, **Browse all** switches to a
  plain list, and the deck can be downloaded as Markdown.
- Progress (card *n* of *N*, cards known, cards to review) is shown above the card.

### Practice exam (per study kit)

The same material as the practice questions, but as a **timed paper**:

- **Multiple choice only**, so the paper can be marked automatically — no short answers.
- Choose 10–30 questions and a time limit, or let it pick about 1¼ minutes per question (minimum 5,
  rounded to 5).
- **Start exam** begins a countdown. Questions show no feedback while the exam runs; answers are
  recorded as you click, and the header tracks how many you have answered.
- Submit early (with a confirmation if questions are unanswered) or let the clock auto-submit at zero.
  The clock keeps running if you switch tabs; reloading the page abandons the run.
- The result screen shows the score, percentage, time used, and a full review with the correct answer
  highlighted plus the explanation. **Retake** reuses the questions with a fresh clock; the last score
  is remembered on the exam's front page.

## Choosing the model

**Settings → Model** picks which NVIDIA NIM model writes your documents and questions.

- The list comes from the Symus Worker: `GET /api/models` asks NVIDIA which models your API key can
  see, then keeps only the supported families.
- A model is offered only if its id contains **deepseek**, **step**, **nemotron**, **mistral**,
  **gemma**, **glm** or **muse**. The same rule is enforced in the Worker when a request is made, so
  a model outside those families is rejected even if the UI is bypassed.
- **Load available models** refreshes the list using the key currently typed in Settings. Failures
  (bad key, offline) are shown in the dialog and your saved model is kept.
- **Custom model id…** lets you type an id by hand, for a model that is not in the catalogue yet.
- The default is `nvidia/nemotron-3.5-lightning-30b-a3b`. The choice is stored in `localStorage` and
  applies to all later document and question requests; existing documents are unaffected.

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
| `src/ai.js` | NIM client: gap analysis, document generation, questions, flashcards, exam papers, allocation, retries. |
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
SYMUS_MODEL_FILTER = "deepseek,step,nemotron,mistral,gemma,glm,muse"
SYMUS_MODELS = "nvidia/nemotron-3.5-lightning-30b-a3b"
```

| Variable | Purpose |
| --- | --- |
| `SYMUS_ORIGIN` | Comma-separated allowed browser origins. Localhost on any port is always allowed. |
| `SYMUS_MODEL_FILTER` | Substrings a model id must contain to be listed or accepted. Defaults to the seven families above. |
| `SYMUS_MODELS` | Optional extra model ids allowed even when they match no filter substring. |

Routes:

| Route | Description |
| --- | --- |
| `GET /health` | `{ "ok": true }` |
| `GET /api/models` | Requires `Authorization: Bearer <NVIDIA key>`. Proxies NVIDIA's `/v1/models`, filters to the allowed families and returns `{ models: [{ id, ownedBy }], filter, count }`. |
| `POST /api/notes` | Chat completion. Only known fields (`model`, `messages`, `max_tokens`, `temperature`, `top_p`, `stream`, `chat_template_kwargs.enable_thinking`) are forwarded, bodies are capped at 1 MB, roles and token counts are validated, and the model must match the family filter. With `{"stream": true}` the upstream server-sent events are piped back as `text/event-stream`. |

The Worker never stores or logs the key — it forwards the caller's `Authorization` header.

## Limitations

- `localStorage` is per-browser and per-origin; clearing site data deletes your library. Export backups.
- OCR quality depends on scan quality, language and render scale. Very large PDFs at 3× use a lot of
  memory, and OCR runs at a few seconds per page.
- The OCR limit is 60 pages per run; any flagged pages beyond that are reported on the resource and
  need a re-run.
- Long resources are split into sections, so cross-section connections can be weaker. If a section hits
  the output-token limit the resource status says which part may be short.
- AI output can be wrong or can miss nuance: check it against the source before revising from it.
- Live document streaming needs the current Worker deployed. Against an older Worker the app still
  works: the study document simply appears when it is finished instead of growing on screen.
- Kits with many resources mean one model request per resource, so generating a large set takes
  proportionally longer — a 40-card deck or a 30-question exam across five resources is ten requests.
- An exam run lives in memory: reloading the page or closing the tab abandons it (the saved paper and
  last score survive).
- Available models depend on your NVIDIA account and the Worker's family filter. If one is missing,
  check **Settings → Model → Load available models** and `SYMUS_MODEL_FILTER` on the Worker.
- Not exhaustively tested in every browser; it relies on modern ES2022 features.

## Dependencies

- ARCH.js — <https://chibbit-99.github.io/arch.js/>
- PDF.js 4.4.168 — <https://mozilla.github.io/pdf.js/>
- Tesseract.js 6.0.1 — <https://github.com/naptha/tesseract.js>
- NVIDIA NIM — <https://build.nvidia.com/> (default model: Nemotron 3.5 Lightning,
  <https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b>)
- Cloudflare Workers — <https://developers.cloudflare.com/workers/>
