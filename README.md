# LibreTexts Question Studio

A standalone, installable web app (PWA) that turns LibreTexts textbook content
into reviewed question banks and exports them as QTI files that ADAPT imports.
It is forked in spirit from [`assessment-ai`](../assessment-ai): the same
concept → draft → critique → revise pipeline, ported to run entirely in the
browser.

- **No server, no login.**
  - Everything (sources, questions, exports, settings) is stored in the browser's IndexedDB.
  - Close the tab and come back: nothing has to be regenerated.
- **LibreTexts only.** Find a book from the full LibreTexts catalog, paste any LibreTexts page, chapter or book URL, or paste text copied from a page. Then pick whole chapters, sections or single pages.
- **Two AI engines:**
  - **In-browser** (default): Gemma 4 E4B on WebGPU via Transformers.js (one-time 4.9 GB download), or Qwen3.5 4B via WebLLM (2.4 GB). Free and private, and the text never leaves the device.
  - **OpenAI, bring your own key:** GPT-6 Luna (or GPT-5.6 Luna) at high reasoning effort, called directly from the browser.
- **ADAPT-ready export.**
  - The export is Canvas-style QTI 1.2, the only QTI format ADAPT's Bulk Import accepts, checked against ADAPT's own PHP parser. It also imports into Canvas.
  - Nine question types: multiple choice, true/false, select all that apply, numerical, math (randomized numbers), matching, fill in the blank, multiple dropdowns, and essay.
- **Duplicate check.** EmbeddingGemma 2 (174 MB, on the device) notes a new question that repeats one already in its set.
- **Math with computed answers.** For a math question the model writes a template (variables with ranges, constraints, an answer formula), never the final number. It also works one example by hand, and the formula must agree with it. The app computes and checks every answer over 25 sets of numbers, then exports versions as numerical questions.

## Using it

1. **Settings:** either download and load the in-browser model, or paste an OpenAI API key.
2. **Create:**
   - Choose a source and tick the pages you want.
   - Choose question types and how many questions per page. The second-pass review is on by default. With the in-browser model, an answer check also answers each multiple-choice and select-all question without its key, and sends back keys it disagrees with.
   - Generate. Questions appear as they are written, and the run continues if you switch screens.
3. **Review:** approve, edit, or reject each question. Each question can show the exact source paragraphs it cites.
4. **Export to ADAPT** (from the set's page): download the QTI (.zip). In ADAPT, go to Dashboard → My Questions → Bulk Import tab → Canvas QTI, pick a folder and license, and upload the file. Earlier downloads stay listed and can be downloaded again.
   - **Math questions:** by default each one goes into that file as one version. Choose **Randomized** to download a second file in which each math question is its own quiz with several versions. ADAPT makes each quiz an assignment; import it into a course with an assignment template whose Dynamic Questioning settings are Random sampling: Yes and Number of randomized assessments: 1, and each student gets one version.
5. **Settings → Data and backup** downloads all sets as one JSON file. Restore it in another browser or on another computer.

## Development

```bash
npm install
npm run dev            # http://localhost:5173
npm test               # unit tests (schemas, math specs, normaliser, QTI exporter)
npm run build          # type-check + production build in dist/
npm run catalog        # refresh public/catalog.json from LibreTexts Commons
```

To check exported packages against ADAPT's real importer (PHP 7.4 compiled to
WebAssembly; needs the `../adapt` checkout):

```bash
npm install --prefix /tmp/php-wasm @php-wasm/node   # once, ~470 MB
PHP_WASM_DIR=/tmp/php-wasm npm run verify:adapt
```

## How it is put together

```
src/lib/content/     LibreTexts access: URL parsing, cross-library page/tree/contents,
                     HTML → numbered paragraphs, bundled catalog search, page cache
src/lib/generation/  per-type zod schemas (= ADAPT import rules), prompts, pipeline
src/lib/llm/         provider interface + validation/retry loop; Transformers.js worker
                     (Gemma 4, EmbeddingGemma 2); WebLLM worker (Qwen3.5); OpenAI
src/lib/math/        math questions: formula parser (no eval), seeded versions, checks
src/lib/qti/         Canvas QTI 1.2 package builder and export history
src/lib/storage/     Dexie (IndexedDB) schema, encrypted API-key storage
src/state/           engine settings, background generation runner
src/views/           Create, Library, Set review, Settings
tests/adapt-parser/  harness that runs ADAPT's QtiImport.php on our packages
```

**Pipeline.**
1. Each page is split into sections that fit the model. For the in-browser model's 8K context that is about 5,500 characters.
2. Concepts are extracted per section, each citing paragraph numbers. The extractor is told how many of the section's questions are calculations.
3. One question is drafted per concept, rotating through the chosen types, and validated against the type's schema.
   - A math or numerical question whose section has no numbers takes a quantitative concept from another section of the same page. Only if the page has none is another type written instead.
4. Validation failures are sent back to the model to fix, up to 3 attempts. If all 3 fail, the question starts over in a new conversation, up to twice more. A question that still fails is left out without a notice; only engine errors (such as a model that is not loaded) are shown.
5. The reviewer pass (on by default) critiques and rewrites each question. Its notes are kept and shown with the question. On the in-browser model, math questions skip it.
6. On the in-browser model, an answer check answers each multiple-choice and select-all question without seeing its key. If it disagrees, the question goes back once to be fixed, naming the choices; if the check still disagrees, the question gets a note. See [docs/research.md](docs/research.md), "Wrong answer keys".
7. With the duplicate check on, a question whose stem is very close to one already in the set (cosine ≥ 0.94 between EmbeddingGemma 2 embeddings) gets a note.
8. Every question is saved as soon as it validates.

**Math questions.** [docs/adapt-formats-and-math.md](docs/adapt-formats-and-math.md)
covers the template format, the checks, and how versions map onto ADAPT's
randomization.

**Why QTI 1.2 and not QTI 3.** `assessment-ai` exports QTI 3.0.1, but ADAPT
cannot import it. See [docs/adapt-qti-import.md](docs/adapt-qti-import.md) for
the exact contract and the parser quirks the exporter works around.

**Research.** Runtime and model choice, the OpenAI Luna API details, and how the
browser can reach LibreTexts content are in [docs/research.md](docs/research.md).

## Deploying

`npm run build` produces a static site in `dist/`. It can be hosted anywhere that
serves static files over HTTPS. It uses hash routing and relative paths, so it
also works from a sub-path.

- **Public site:** https://qtistudio.libretexts.dev, static files in `/opt/libretexts/qtistudio/` on the libretexts.dev VPS, served by Caddy. `/assets/*` is cached for a year and everything else is `no-cache`, so a new service worker and catalog reach users. Redeploy with `npm run build && rsync -a --delete dist/ <vps>:/opt/libretexts/qtistudio/`; Caddy needs no reload. Browsers keep downloaded models per site, so the first visit downloads the model again even if it was loaded on localhost.

- **Network access** (used directly from the browser):
  - `api.libretexts.org`: book trees and page text, through the public `cross-library` read proxy.
  - `huggingface.co` and `*.hf.co`: model weights (Gemma 4, EmbeddingGemma 2, Qwen3.5). ONNX Runtime's WebAssembly is served with the app.
  - `raw.githubusercontent.com`: WebLLM model libraries.
  - `api.openai.com`: only when a key is used.
- **Content Security Policy:** if you set one, it needs `connect-src` for the hosts above, plus `'wasm-unsafe-eval'` in `script-src` for WebGPU/WASM.
- **libretexts.org hosting:** hosting on a `*.libretexts.org` subdomain also lets the browser call LibreTexts Commons directly, if live search is wanted later.
- **Catalog freshness:** refresh the catalog snapshot with `npm run catalog` as part of each build.

## Known limits

- The in-browser models need WebGPU: recent desktop Chrome or Edge, Safari 26, or Firefox on Windows / Apple Silicon. Phones are not supported. Gemma 4 E4B has only been tested in desktop Chrome on Apple Silicon; Qwen3.5 4B is the fallback.
- Small local models write weaker distractors than GPT-6 Luna. Every question is a draft until an instructor approves it.
- Images and figures are not used as question material. Image alt text is kept as text.
- ADAPT grades fill-in-the-blank against a single answer by exact match, ignoring case (alternates are honoured by Canvas only), so the app asks for answers in plain words and notes the ones that are not. It ignores feedback on several types.
- In ADAPT, essays take the assignment's Default Open-ended Submission Type; with None, students have nothing to submit.
