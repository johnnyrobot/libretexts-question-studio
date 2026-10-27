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
   - Choose question types and how many questions per page. The second-pass review is on by default. An answer check also answers each multiple-choice, select-all, true/false, fill-in-the-blank, matching and dropdowns question without its key: it sends back multiple-choice, select-all, matching and dropdowns keys it disagrees with, gives a fill-in-the-blank question a new blank when its answer differs from the key, and notes true/false keys it disagrees with. The app also recomputes the arithmetic in each numerical question's explanation, and sends back a step that does not add up or an answer the working never reaches. These checks always run on the in-browser model; with OpenAI they are on by default and can be turned off in Settings (**Check answer keys**), since they use extra API calls.
   - Generate. Questions appear as they are written, and the run continues if you switch screens.
   - **Link straight to a page:** put `?page=<library>-<page id>` right after the app's address, for example `https://qtistudio.libretexts.dev/?page=human-378488` (`?human-378488` works too). The app opens Create on the **Paste a link** tab with that page looked up and its content pages ticked, as if you had pasted its link. The library is the part before `.libretexts.org`, such as `human` or `chem`, and the page id is the number in the page's `/@go/page/<id>` link. A link to an unknown library says which libraries there are.
3. **Review:** approve, edit, or reject each question. Each question can show the exact source paragraphs it cites.
4. **Export to ADAPT** (from the set's page): download the QTI (.zip). In ADAPT, go to Dashboard → My Questions → Bulk Import tab → Canvas QTI, pick a folder and license, and upload the file. Earlier downloads stay listed and can be downloaded again.
   - **Math questions:** by default each one goes into that file as one version. Choose **Randomized** to download a second file in which each math question is its own quiz with several versions. ADAPT makes each quiz an assignment; import it into a course with an assignment template whose Dynamic Questioning settings are Random sampling: Yes and Number of randomized assessments: 1, and each student gets one version.
5. **Settings → Data and backup** downloads all sets as one JSON file. Restore it in another browser or on another computer.

## Development

```bash
npm install
npm run dev            # http://localhost:5173
npm run lint           # oxlint
npm test               # unit tests under src/ (see below)
npm run build          # type-check (tsc -b) + production build in dist/
npm run catalog        # refresh public/catalog.json from LibreTexts Commons
```

`npm test` runs only the tests under `src/`: the per-type schemas, the
generation pipeline and its answer checks (with a scripted model), model output
parsing and its JSON-escape guard, math formulas and versions, the arithmetic
check of numerical explanations, the LibreTexts page normaliser, the QTI
exporter and export history, backup and restore, the question editor, the
OpenAI answer-check setting, and links that open the app on a LibreTexts page.

GitHub Actions (`.github/workflows/ci.yml`) runs lint, the tests and the build,
but not the ADAPT importer check below; run that one locally.

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
src/lib/math/        math questions: formula parser (no eval), seeded versions, checks;
                     the arithmetic check of numerical explanations
src/lib/qti/         Canvas QTI 1.2 package builder and export history
src/lib/storage/     Dexie (IndexedDB) schema, encrypted API-key storage
src/state/           engine settings, background generation runner
src/views/           Create, Library, Set review, Settings
tests/adapt-parser/  harness that runs ADAPT's QtiImport.php on our packages
```

**Pipeline.**
1. Each page is split into sections that fit the model. For the in-browser model's 8K context that is about 5,500 characters.
2. Concepts are extracted per section, each citing paragraph numbers. The extractor is told how many of the section's questions are calculations.
3. One question is drafted per concept, rotating through the chosen types, and validated against the type's schema. A draft with a stray symbol where math was meant ("The weight (Å)") is sent back, as is a fill-in-the-blank question whose key is a function word ("is", "between"); on the in-browser model the decoder also stops the JSON escape that causes most of the stray symbols, and a LaTeX command that lost its backslash to one (a tab followed by "extsubscript{net}") gets it back.
   - A math or numerical question whose section has no numbers takes a quantitative concept from another section of the same page. Only if the page has none is another type written instead.
4. Validation failures are sent back to the model to fix, up to 3 attempts. If all 3 fail, the question starts over in a new conversation, up to twice more. A question that still fails is left out without a notice; only engine errors (such as a model that is not loaded) are shown.
5. The reviewer pass (on by default) critiques and rewrites each question. Its notes are kept and shown with the question, unless the answer check below gives a fill-in-the-blank question a new blank. On the in-browser model, math questions skip it.
6. An answer check answers each question without seeing its key: always on the in-browser model, and on OpenAI unless **Check answer keys** is turned off in Settings. In testing on the in-browser model (Gemma 4 E4B) it found 16 of 18 wrong multiple-choice and select-all keys and flagged 4 of 93 right ones; it has not been measured on OpenAI:
   - **Multiple choice and select-all:** if the check disagrees, the question goes back once to be fixed, naming the choices. If the check still disagrees, the question gets a note.
   - **Matching and dropdowns:** the check matches each term, or fills each blank, from options listed in alphabetical order. Terms and blanks it answers differently go back once to be fixed, and if the check still disagrees, the question gets a note. These two types were not measured against known wrong keys.
   - **Fill in the blank:** the check fills the blank without the key or the textbook. If its answer differs from the key, or the key is a number or symbol, the model names up to five other words of the completed sentence. The app skips function words and words the textbook makes predictable ("net external ____"), blanks the others in turn, and keeps the first that the check fills in as the key. A number or symbol key is replaced even by a predictable word. The sentence and explanation stay the same. If none passes, a question the check disagreed with gets a note.
   - **True/false:** a key the check disagrees with gets a note. It is not sent back, because the reviewer then flipped a correct key.
   - **Numerical:** no model answers these. The app evaluates each chain of steps in the explanation ("A = B = C", also ≈), reading LaTeX fractions, roots, powers, products and mixed numbers and skipping units. Neighbouring steps must agree to within the rounding of the digits they are written with plus 0.5% (2% after ≈), and the answer must appear as a result. A step that does not add up, or an answer the working never reaches, goes back once to be fixed and gets a note if it remains. The check is the one that screened the fine-tuning data; it has not been measured on the app's questions.
7. With the duplicate check on, a question whose stem is very close to one already in the set (cosine ≥ 0.94 between EmbeddingGemma 2 embeddings) gets a note.
8. Every question is saved as soon as it validates.

**Math questions.** [docs/adapt-formats-and-math.md](docs/adapt-formats-and-math.md)
covers the template format, the checks, and how versions map onto ADAPT's
randomization.

**Why QTI 1.2 and not QTI 3.** `assessment-ai` exports QTI 3.0.1, but ADAPT
cannot import it. See [docs/adapt-qti-import.md](docs/adapt-qti-import.md) for
the exact contract and the parser quirks the exporter works around.

**Research.** The notes behind the runtime and model choice, the OpenAI Luna API
details, and how the browser reaches LibreTexts content are working notes kept
outside this repository.

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
- **Catalog freshness:** `public/catalog.json` is a snapshot, and `npm run build` does not refresh it. Run `npm run catalog` before a build to pick up new books.

## Known limits

- The in-browser models need WebGPU: recent desktop Chrome or Edge, Safari 26, or Firefox on Windows / Apple Silicon. Phones are not supported. Gemma 4 E4B has only been tested in desktop Chrome on Apple Silicon; Qwen3.5 4B is the fallback.
- Small local models write weaker distractors than GPT-6 Luna. Every question is a draft until an instructor approves it.
- Images and figures are not used as question material. Image alt text is kept as text.
- ADAPT grades fill-in-the-blank against a single answer by exact match, ignoring case (alternates are honoured by Canvas only). The app asks for answers in plain words. With the answer check, it also blanks another word when the check fills the blank differently. Questions where it cannot are noted. ADAPT ignores feedback on several types.
- In ADAPT, essays take the assignment's Default Open-ended Submission Type; with None, students have nothing to submit.
