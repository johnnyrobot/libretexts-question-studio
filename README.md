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
   - **Link straight to a page:** put `?page=<library>-<page id>` right after the app's address and before any `#`, for example `https://qtistudio.libretexts.dev/?page=human-378488` (`?human-378488` works too). The app opens Create on the **Paste a link** tab with that page looked up and its content pages ticked, as if you had pasted its link. The library is the part before `.libretexts.org`, such as `human` or `chem`, and the page id is the number in the page's `/@go/page/<id>` link. A link to an unknown library says which libraries there are. **Copy link** copies such a link for the page looked up on **Paste a link** or a set made from one LibreTexts page. For the book opened in **Find a book** it copies `?book=<library>-<page id>` instead, which reopens **Find a book** with that book open (or **Paste a link** on its cover page, if the book list no longer has it or can't load). Where the browser cannot copy, it shows the link selected instead.
3. **Review:** approve, edit, or reject each question. Each question can show the exact source paragraphs it cites.
4. **Export to ADAPT** (from the set's page): download the QTI (.zip). In ADAPT, go to Dashboard → My Questions → Bulk Import tab → Canvas QTI, pick a folder and license, and upload the file. Earlier downloads stay listed and can be downloaded again.
   - **Author name** (optional, remembered in this browser only): the export names this person as the questions' author in the package's manifest and in each quiz's instructions. ADAPT shows the instructions, not the manifest, and students see them. The instructions also credit the source: its title, its book and the book's authors, its link and its license, whichever the app knows. A pasted page is credited to the book the bundled catalog lists it under. When that listing may be a collection of books or a whole campus, the app instead looks at the page and up to two pages above it for one LibreTexts marks as a book's cover, and credits that book (never a campus). When none is marked, it credits the catalog's listing, unless that is a campus. The book's authors come from the catalog when it lists the book. Otherwise the page is credited on its own, with no book named.
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
check of numerical explanations, the LibreTexts page normaliser and book
lookup, the QTI exporter with its author name and source credit, export
history, backup and restore, the question editor, the OpenAI answer-check
setting, links that open the app on a LibreTexts page, and a second tab
leaving a set alone while another tab is still writing it, then marking it
interrupted if that tab closes first, and Delete everything refusing while any
set is being written.

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
serves static files over HTTPS. Serve it from the root of a site: the built
pages load all their files from there.

- **Public site:** https://qtistudio.libretexts.dev, static files in `/opt/libretexts/qtistudio/` on the libretexts.dev VPS, served by Caddy. `/assets/*` is cached for a year and everything else is `no-cache`, so a new service worker and catalog reach users. Redeploy with `npm run build && rsync -a --delete dist/ <vps>:/opt/libretexts/qtistudio/`; Caddy needs no reload. Browsers keep downloaded models per site, so the first visit downloads the model again even if it was loaded on localhost.

- **Network access** (used directly from the browser):
  - `api.libretexts.org`: book trees and page text, through the public `cross-library` read proxy.
  - `huggingface.co` and `*.hf.co`: model weights (Gemma 4, EmbeddingGemma 2, Qwen3.5). ONNX Runtime's WebAssembly is served with the app.
  - `raw.githubusercontent.com`: WebLLM model libraries.
  - `api.openai.com`: only when a key is used.
- **Content Security Policy:** if you set one, it needs `connect-src` for the hosts above, plus `'wasm-unsafe-eval'` in `script-src` for WebGPU/WASM.
- **libretexts.org hosting:** hosting on a `*.libretexts.org` subdomain also lets the browser call LibreTexts Commons directly, if live search is wanted later.
- **Catalog freshness:** `public/catalog.json` is a snapshot, and `npm run build` does not refresh it. Run `npm run catalog` before a build to pick up new books.

## Question quality

The test set is 22 textbook pages kept out of all prompt tuning and training: 2 pages from each of 11 books in 11 subjects. Each model was asked for 8 questions per page, rotating through the 8 types that have an answer key, with the review on; a question a model could not finish is left out, so each wrote fewer than 176. A math or numerical question needs numbers or a formula from the page: where a run found none, it wrote multiple choice instead. All three Gemma 4 E4B runs also had the answer check, done by the default model in each; GPT-6 Luna's run did not. The default model's and GPT-6 Luna's runs used the app as it was on 2026-10-10, before its newer checks (see **What the numbers cover**). Claude graded all the questions blind against one rubric, with the three models' questions shuffled together; the current-checks run was graded later in a second round the same way, shuffled together with the default model's 2026-10-10 questions (see **The newer checks made no clear difference**). No LibreTexts instructor has checked Claude's grades; a planned instructor check of a random 20% was not done. Each question gets one verdict:

- **Usable as is:** an instructor would publish it without editing.
- **Needs a small edit:** fixable in under a minute.
- **Rejected:** a wrong key, unanswerable, trivial, or needs rewriting. A wrong key always means rejected.

A **wrong answer key** is false for the question as written; a fill-in-the-blank key is also wrong when another common word fits equally well. **Weak distractors** counts only multiple choice, select-all, dropdowns and matching questions: one of the wrong choices is implausible, a near-duplicate or a joke.

Claude graded the questions in two rounds, and the second round graded higher: the same 2026-10-10 questions from the default model scored 35% usable as is in the first round and 45% in the second. Compare columns within a round, not across them.

| | Round 1: Gemma 4 E4B in the browser (the default), 2026-10-10 | Round 1: Fine-tuned Gemma 4 E4B (tested, not shipped) | Round 1: GPT-6 Luna, high reasoning effort | Round 2: the default, 2026-10-10 | Round 2: the default, current checks (2026-10-29) |
|---|---|---|---|---|---|
| **Usable as is** | 35% (59/168) | 44% (75/172) | 62% (108/175) | 45% (76/168) | 46% (76/166) |
| Needs a small edit | 36% (60/168) | 28% (49/172) | 19% (33/175) | 33% (55/168) | 31% (51/166) |
| Rejected | 29% (49/168) | 28% (48/172) | 19% (34/175) | 22% (37/168) | 23% (39/166) |
| **Wrong answer key** | 17% (28/168) | 19% (32/172) | 5% (9/175) | 14% (23/168) | 14% (23/166) |
| Wrong key with no note from the app | 4% (6/168) | 6% (10/172) | 4% (7/175) | 2% (3/168) | 0% (0/166) |
| Weak distractors | 59% (61/103) | 56% (59/106) | 21% (19/90) | 51% (53/103) | 43% (44/102) |

- **Wrong answer keys are the error that matters most, and Gemma 4 E4B makes far more of them.** About one question in five or six has a wrong key, three to four times GPT-6 Luna's rate. The app put a note on 22 of the default model's 28 wrong keys, but it also put one on 62% of that model's questions, so a note was only a weak warning.
- **Matching and dropdowns are the weakest types, and numerical is weak too.** A third to nearly half of Gemma 4 E4B's matching and dropdowns questions have wrong keys, with or without fine-tuning, and few are usable. The default model's numerical questions have wrong keys where GPT-6 Luna's have none, and the fine-tuned model's were rarely usable. Select-all is also rarely usable from the default model. GPT-6 Luna's weak type is fill in the blank, which it wrote without the answer check that now re-blanks a question the check fills differently. Math and numerical questions came from a different set of pages in each run. Multiple choice includes the questions written in their place: 16 in each of the default model's runs, 18 in the fine-tuned one, 2 in GPT-6 Luna's. By type, usable as is / wrong key (7 to 40 questions per type, so read these roughly; compare columns within a round):

  | Type | Round 1: default, 2026-10-10 | Round 1: fine-tuned | Round 1: GPT-6 Luna | Round 2: default, 2026-10-10 | Round 2: default, current checks |
  |---|---|---|---|---|---|
  | Matching | 5% / 43% | 0% / 45% | 64% / 0% | 14% / 43% | 5% / 40% |
  | Multiple dropdowns | 5% / 32% | 23% / 36% | 55% / 5% | 23% / 23% | 18% / 9% |
  | Numerical | 43% / 14% | 15% / 8% | 52% / 0% | 64% / 14% | 71% / 7% |
  | Multiple choice | 37% / 13% | 65% / 10% | 75% / 0% | 39% / 13% | 61% / 13% |
  | Select all that apply | 18% / 5% | 32% / 18% | 77% / 0% | 27% / 5% | 32% / 18% |
  | True/false | 91% / 0% | 95% / 0% | 91% / 0% | 95% / 0% | 95% / 0% |
  | Fill in the blank | 52% / 19% | 50% / 14% | 45% / 36% | 62% / 5% | 43% / 5% |
  | Math | 25% / 0% | 33% / 22% | 30% / 0% | 50% / 0% | 14% / 29% |

- **Fine-tuning raised usable questions but did not reduce wrong keys.** The fine-tuned model is Gemma 4 E4B with a LoRA adapter (a small set of trained changes to its weights), applied at a quarter of its trained strength. The adapter was trained on 3,855 questions that Gemma 4 31B drafted from 261 other LibreTexts books. In the test, the fine-tuned model drafted the questions, and the default model did every other step, including the review and the answer check. On the 162 slots (same page, type and position) where both wrote a question, the fine-tuned model wrote more usable questions (45% vs 35%, p = 0.014) and as many wrong keys (17% each). The fine-tuned run had newer app checks (see below), but the usable gain is all in the five types those checks do not touch (62% vs 46%, p = 0.005), with wrong keys the same there too (8% vs 9%), so it comes from the model. It is not in the app: it leaves wrong keys where they were, and the tested setup held a second 2.9 GB set of weights in GPU memory beside the default model. Loading one model at a time and swapping between them was not tried.
- **What the numbers cover.** The default model and GPT-6 Luna wrote their questions on 2026-10-10. That was before the answer check covered matching and dropdowns, before the arithmetic check of numerical explanations, and before the answer check ran on OpenAI; the app does all three by default now. The fine-tuned run, on 2026-10-26 and 27, had the first two. Counted together, its matching, dropdowns and numerical questions were no better than the default model's from 2026-10-10. The current-checks run, on 2026-10-29, had all three.
- **The newer checks made no clear difference to the default model.** On 2026-10-29 the default model wrote the test again on the app as it is now, with every check at its default setting. Its questions were graded in the second round, shuffled together with the default model's 2026-10-10 questions, and that round graded higher: the 2026-10-10 questions scored 45% usable and 14% wrong keys in it, against 35% and 17% in the first round (usable p < 0.001 on the same questions). On the 160 slots where both runs wrote a question, usable was 47% vs 46% (p = 0.89) and wrong keys 12% vs 13% (p = 0.84). In matching, dropdowns and numerical, the types the newer checks touch (54 slots), wrong keys were 10 vs 14 (p = 0.34) and usable 14 vs 16 (p = 0.79). Multiple choice looked better, 23 vs 15 usable on 36 slots, but not clearly (p = 0.13). The app now puts a note on every wrong key (23 of 23, against 20 of 23 for the 2026-10-10 questions in the same round), but it also puts one on 72% of the questions, up from 62%, so a note is still only a weak warning. About one question in seven still has a wrong key, and two in five of the matching questions.

## Known limits

- The in-browser models need WebGPU: recent desktop Chrome or Edge, Safari 26, or Firefox on Windows / Apple Silicon. Phones are not supported. Gemma 4 E4B has only been tested in desktop Chrome on Apple Silicon; Qwen3.5 4B is the fallback.
- Gemma 4 E4B in the browser writes weaker distractors and more wrong answer keys than GPT-6 Luna (see [Question quality](#question-quality)); Qwen3.5 4B has not been measured. Every question is a draft until an instructor approves it.
- Images and figures are not used as question material. Image alt text is kept as text.
- ADAPT grades fill-in-the-blank against a single answer by exact match, ignoring case (alternates are honoured by Canvas only). The app asks for answers in plain words. With the answer check, it also blanks another word when the check fills the blank differently. Questions where it cannot are noted. ADAPT ignores feedback on several types.
- In ADAPT, essays take the assignment's Default Open-ended Submission Type; with None, students have nothing to submit.
