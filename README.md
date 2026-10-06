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
  - **In-browser** (default): Qwen3.5 2B, 4B or 9B on WebGPU via WebLLM, or MiniCPM5 2B via wllama (llama.cpp). Free and private, and the text never leaves the device. One-time 1–5 GB download.
  - **OpenAI, bring your own key:** GPT-6 Luna (or GPT-5.6 Luna) at high reasoning effort, called directly from the browser.
- **ADAPT-ready export.**
  - The export is Canvas-style QTI 1.2, the only QTI format ADAPT's Bulk Import accepts, checked against ADAPT's own PHP parser. It also imports into Canvas.
  - Nine question types: multiple choice, true/false, select all that apply, numerical, math (randomized numbers), matching, fill in the blank, multiple dropdowns, and essay.
- **Math with computed answers.** For a math question the model writes a template (variables with ranges, constraints, an answer formula), never the final number. The app computes and checks every answer over 25 sets of numbers, then exports versions as numerical questions.

## Using it

1. **Settings:** either download and load the in-browser model, or paste an OpenAI API key.
2. **Create:**
   - Choose a source and tick the pages you want.
   - Choose question types and how many questions per page. The second-pass review is on by default; it catches wrong answer keys.
   - Generate. Questions appear as they are written, and the run continues if you switch screens.
3. **Review:** approve, edit, or reject each question. Each question can show the exact source paragraphs it cites.
4. **Download QTI (.zip).** In ADAPT, go to Question Editor → Bulk Import → Canvas QTI, pick a folder and license, and upload the file. Earlier downloads stay listed and can be downloaded again.
   - **Math questions:** by default each one goes into that file as one version. Choose **Randomized** to download a second file in which each math question is its own quiz with several versions. ADAPT makes each quiz an assignment; import it with an assignment template where Randomizations is Yes and Number of randomized assessments is 1, and each student gets one version.
5. **Settings → Backup** downloads all sets as one JSON file. Restore it in another browser or on another computer.

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
src/lib/llm/         provider interface + validation/retry loop; WebLLM worker; OpenAI
src/lib/math/        math questions: formula parser (no eval), seeded versions, checks
src/lib/qti/         Canvas QTI 1.2 package builder and export history
src/lib/storage/     Dexie (IndexedDB) schema, encrypted API-key storage
src/state/           engine settings, background generation runner
src/views/           Create, Library, Set review, Settings
tests/adapt-parser/  harness that runs ADAPT's QtiImport.php on our packages
```

**Pipeline.**
1. Each page is split into sections that fit the model. For the in-browser model's 8K context that is about 5,500 characters.
2. Concepts are extracted per section, each citing paragraph numbers.
3. One question is drafted per concept, rotating through the chosen types, and validated against the type's schema.
4. Validation failures are sent back to the model to fix, up to 3 attempts.
5. The reviewer pass (on by default) critiques and rewrites each question. Its notes are kept and shown with the question.
6. Every question is saved as soon as it validates.

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

- **Network access** (used directly from the browser):
  - `api.libretexts.org`: book trees and page text, through the public `cross-library` read proxy.
  - `huggingface.co` and `*.hf.co`: model weights.
  - `raw.githubusercontent.com`: WebLLM model libraries.
  - `api.openai.com`: only when a key is used.
- **Content Security Policy:** if you set one, it needs `connect-src` for the hosts above, plus `'wasm-unsafe-eval'` in `script-src` for WebGPU/WASM.
- **libretexts.org hosting:** hosting on a `*.libretexts.org` subdomain also lets the browser call LibreTexts Commons directly, if live search is wanted later.
- **Catalog freshness:** refresh the catalog snapshot with `npm run catalog` as part of each build.

## Known limits

- The in-browser model needs WebGPU: recent desktop Chrome or Edge, Safari 26, or Firefox on Windows / Apple Silicon. Phones are not supported.
- Small local models write weaker distractors than GPT-6 Luna. Every question is a draft until an instructor approves it.
- Images and figures are not used as question material. Image alt text is kept as text.
- ADAPT grades fill-in-the-blank against a single answer (alternates are honoured by Canvas only) and ignores feedback on several types.
