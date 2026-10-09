# Research notes (October 2026)

Background for the decisions in this app. Versions and model lists were checked
on 2026-10-05.

## 1. Running a model in the browser

### Runtimes: Transformers.js and WebLLM

| Runtime | Version | GPU / CPU | Schema-constrained JSON | Notes |
|---|---|---|---|---|
| **WebLLM** (`@mlc-ai/web-llm`) | 0.2.85 (2026-09) | WebGPU only | **Yes**: XGrammar, `response_format: {type: "json_object", schema}` | Prebuilt Qwen3.5 models, `hasModelInCache()`, runs in a Web Worker, needs no COOP/COEP headers. Apache-2.0. **Used for Qwen3.5 4B.** |
| **Transformers.js** (`@huggingface/transformers`) | 4.3.1 | WebGPU or WASM | **Yes**, with `@huggingface/transformers-structured-output` 4.3.1 (experimental) as a logits processor | Runs Gemma 4 and EmbeddingGemma 2, which WebLLM has no builds of. `ModelRegistry` checks and clears the cache. Already used by the LibreTexts reader for speech. **Used for Gemma 4 E4B and EmbeddingGemma 2 (2026-10-06).** |
| wllama (llama.cpp WASM) | 3.8.1 | WebGPU + CPU fallback | Yes (`json_schema`, grammar) | The only real CPU path, but slow, and multi-threading needs cross-origin isolation. |
| Chrome Prompt API (Gemini Nano) | Chrome 148+ stable | browser-managed model | Yes (`responseConstraint`) | Chrome desktop only, not available in workers, 22 GB free disk required. A possible zero-download extra later. |
| MediaPipe LLM Inference | 0.10.29 | WebGPU | not documented | Maintenance-only; Google points to LiteRT-LM, which is in early preview. |

**Browser support for WebGPU:**
- **Chrome/Edge:** Windows, macOS and ChromeOS since 113. Linux only on some GPUs.
- **Safari 26:** macOS and iOS, on by default.
- **Firefox:** Windows (141+) and Apple Silicon macOS (145+), but without `shader-f16`, so the app automatically picks the `q4f32` model builds there.

### Models

**Decision (2026-10-06):** **Gemma 4 E4B** (Transformers.js) is the default in-browser
model and **Qwen3.5 4B** (WebLLM) stays as the smaller option; see
[Gemma 4 E4B and EmbeddingGemma 2](#gemma-4-e4b-and-embeddinggemma-2-2026-10-06).

**Earlier decision (2026-10-05):** the app offers one in-browser model, **Qwen3.5 4B**.
Qwen3.5 2B, Qwen3.5 9B and MiniCPM5 2B were removed, along with the wllama
runtime MiniCPM5 needed. The notes below are kept as the record of what was
compared.

All are Apache-2.0 and prebuilt for WebLLM. GPU memory is WebLLM's estimate at a 4K context. Qwen3.5's hybrid attention adds only about 100–250 MB to go to the app's 8K context.

| Model | Runtime and id | Download | GPU memory |
|---|---|---|---|
| Qwen3.5 2B | WebLLM `Qwen3.5-2B-q4f16_1-MLC` | 1.08 GB | ~2.2 GB |
| MiniCPM5 2B | wllama `openbmb/MiniCPM5-2B-GGUF` · `MiniCPM5-2B-Q4_K_M.gguf` | 1.56 GB | ~2.3 GB |
| **Qwen3.5 4B (default)** | WebLLM `Qwen3.5-4B-q4f16_1-MLC` | 2.37 GB | ~3.9 GB |
| Qwen3.5 9B | WebLLM `Qwen3.5-9B-q4f16_1-MLC` | 5.06 GB | ~6.4 GB |

### Measured in this app (2026-10-05)

**Test setup:**
- One LibreTexts page, *1.3: Phases and Classification of Matter* (chem, Atoms First 2e).
- 8 questions, one of each type.
- Second-pass review off.
- Headless Chrome on Apple M2 Max, WebGPU.
- Every exported ZIP was then imported by ADAPT's real parser (`tests/adapt-parser`).

| Model | Valid questions | Generation time | First load (download) | Notes |
|---|---|---|---|---|
| MiniCPM5 2B (wllama) | 8 / 8 | 105 s | 41 s | Fastest. One multiple-choice question had a **wrong answer key**, and two items leaked their answer into the stem. |
| Qwen3.5 4B (WebLLM) | 8 / 8 | 255 s | 45 s | Cleanest wording and distractors. Matching was weak (2 pairs), and one dropdown leaked its answer. |
| Qwen3.5 2B (WebLLM) | 5 / 8 before the validation fixes, 8 / 8 after | 270 s / 225 s | 25 s | Weakest. It mixed choices between questions and padded matching with nonsense pairs. |

**What changed as a result:**
- These checks now reject the item, so the model must retry:
  - an answer that appears in its stem;
  - "paragraph N" in student-facing text (since 2026-10-08 rewritten first, see "Paragraph numbers" below);
  - true/false, fill-in-the-blank and dropdown stems written as questions;
  - matching with fewer than 3 pairs;
  - a matching prompt reused as a match.
- Numerical questions only go to concepts the extractor marks as quantitative.
- Retries sample at a higher temperature.
- The second-pass review is now **on by default** for every engine, because a wrong answer key is something only a reviewer can catch.

**Model ranking at the time:**
- **Qwen3.5 4B** stayed the default, and is now the only option.
- **MiniCPM5 2B** was the "fast" choice and the only one that could fall back to the CPU. It has since been removed.

### Gemma 4 E4B and EmbeddingGemma 2 (2026-10-06)

Evaluated in a throwaway bench (`experiments/gemma4/`, uncommitted) and then
built into the app. Same setup throughout: *College Physics 1e* 2.3 "Time,
Velocity, and Speed" (82 paragraphs), nine questions, one of each type, review
off, Chrome on an Apple M2 Max, weights already cached.

| Engine | Valid questions | Time | Notes |
|---|---|---|---|
| Qwen3.5 4B (WebLLM) | 6/9 · 6/9 | 355 s · 311 s | Before the lower-bound fix. |
| Gemma 4 E2B, structured output (bench) | 7/9 · 8/9 | 126 s · 120 s | More wrong answer keys. |
| Gemma 4 E4B, structured output (bench) | 8/9 · 7/9 | 179 s · 209 s | |
| **Gemma 4 E4B in the app** | **7/9** | **186 s** | Failed: a math item whose range let the answer be 0, and a matching item that repeated "Speed". 9 of 11 calls valid first try. |

Hand-graded usable questions in the bench: Qwen 10/18, E2B 11/18, E4B 12/18 (one
reader, one page: within noise). The speed difference is not.

**How it runs:** `src/lib/llm/transformers.worker.ts` hosts both models in one
Web Worker. Gemma 4 E4B loads text-only (`embed_tokens` and
`decoder_model_merged`, q4f16, 4.92 GB; q4 at 5.62 GB without `shader-f16`,
untested) and loads from cache in about 4 s. ONNX Runtime's WebAssembly is
bundled with the app rather than fetched from jsDelivr.

**Pitfalls handled in code:**
- The structured-output package rejects string `pattern`; it is stripped from the schema it sees, and zod still checks it.
- It lets a trailing comma through (`[2,]`); `parseJsonResponse` drops trailing commas when the JSON does not parse.
- Gemma writes LaTeX with one backslash inside JSON, so `\frac` arrives as a form feed and `\text` as a tab. `parseJsonResponse` reads `\b \f \n \r \t` as LaTeX when they start a known command (it leaves `\nu`, `\ne` and `\to`, which read as text after a line break).
- Gemma writes `$…$` math despite the prompt; `repairDraft` turns it into `\( \)` using Pandoc's rule, so "$5 and $10" stays a price.
- Gemma names math variables the way physics writes them (`F_net`, `F_foot`). With the pattern stripped it keeps the capitals on every retry, so `repairDraft` lowercases them and every use (see [adapt-formats-and-math.md](adapt-formats-and-math.md#capitalised-variable-names-gemma-4-e4b-2026-10-06)).

**Review pass on Gemma (2026-10-06).** First tested in the end-to-end run, where
it wrote "The concept_label is too long." Twelve drafts from College Physics 4.3
and 4.4 (multiple choice, true/false, select all, fill in the blank, three each)
were reviewed with the old and the new review prompt:

| | Old prompt, no filter | New prompt and filter |
|---|---|---|
| Notes written | 15 | 16 |
| About the app's side (field names, "final output structure", "prompt rules") | 4 | 1, dropped |
| A wrong choice called wrong or "not in the source", which is its job | 3 | 4, dropped |
| The explanation called redundant or not needed | 1 | 1, dropped |
| Notes shown to the instructor | 15 | 10 |
| Reviews with no notes shown | 5 | 6 |
| Time for 12 reviews | 168 s | 191 s |

- **Prompt:** the reviewer is told the instructor reads the list, to use plain words ("the choice '…'", "the explanation"), not field names, and that the app checks format, the concept label and citations.
- **Filter (`cleanReviewNotes`):** drops notes about the app's side, notes that only call a wrong choice wrong or unsupported (unless they also say it is too easy, also true, misleading and so on), and notes that the explanation is redundant or not needed (it is the feedback students read). It writes any snake_case name as words. The phrases are narrow, because "field", "output" and "stem" are also subject words. With the old prompt the filter alone would have shown 8 of the 15 notes.
- **In the app:** a full run of 6 questions (the end-to-end settings) gave 4 notes on 3 questions, none naming a field; the filter caught one more "explanation was redundant" note, which led to that rule.
- **Still weak:** two kept notes only say the question is wordy. The reviewer also missed a wrong answer key: a select-all draft marked "The acceleration is directly proportional to the net external force" incorrect, and both reviews defended it. The answer check (see "Wrong answer keys" below) was added for this.

**EmbeddingGemma 2** (q4, 174 MB, text part only) runs the duplicate check: a
new question whose stem has cosine ≥ 0.94 with one already in its set gets a
note. In the bench it separated hand-labelled duplicates from distinct questions
with AUC 0.99 (no task prefix; 85% found at 91% precision at 0.937). In the app
a reworded stem scored 0.956 against its original, and the closest pair of
distinct stems in the new set 0.898. Ten stems embed in under 0.1 s. Its other
use from the bench, showing the best-matching source paragraph in review, is not
built: the cited paragraph ranked in the top three for only 61% of questions.

**Not yet tested:** Safari, Firefox, Windows and Intel/AMD GPUs, GPU memory use
(not measurable from a page), and more source pages. An ADAPT import of
Gemma-written questions worked in the 2026-10-06 end-to-end test (5 of 5).

### MiniCPM5-2B (openbmb, Apache-2.0, 2026-09-06)

**Architecture:**
- Standard `LlamaForCausalLM`: 2.52B parameters, 42 layers, grouped-query attention (16 Q / 2 KV heads), 128K context, 130K vocabulary.
- The 2 KV heads keep an 8K context to about 350 MB.

**Vendor-reported scores** (they are probably measured in thinking mode; this app runs with thinking off for JSON output):

| Benchmark | MiniCPM5-2B | Qwen3.5-2B | Qwen3.5-4B |
|---|---|---|---|
| Average | 53.9 | 33.2 | 51.1 |
| MMLU-Pro | 70.8 | 65.2 | 78.0 |
| IFEval (instruction following) | 86.7 | 93.4 | 90.2 |
| GPQA-Diamond | 70.2 | 55.8 | 77.1 |

**Strengths and weakness:**
- Strongest in code, math, long-context and agentic tasks.
- Instruction following is its weak spot, and that matters for strict item formats.

**Getting it into the browser:**
- **WebLLM:** no prebuilt build. Because it is plain Llama it could be compiled with MLC-LLM (`convert_weight` / `gen_config` / `compile --device webgpu`) and hosted by LibreTexts, but that needs the MLC toolchain plus a custom chat template.
- **wllama:** the official GGUF runs today. llama.cpp turns the JSON schema into a grammar, and wllama passes `chat_template_kwargs: {enable_thinking: false}` and `min_p: 0` (the model card warns that llama.cpp's default `min_p` causes repetition loops).
- **Cross-origin isolation:** wllama would only run multi-threaded on the CPU with COOP/COEP headers. With WebGPU, all layers run on the GPU.

**Status:** offered from 2026-10-05 until it was removed later that day; see the decision above.

### Laya (convaiinnovations, Apache-2.0, 2026-09)

**What it is:**
- A ~420M-parameter **non-generative** "System 1" decision model.
- It takes a text "state" plus typed questions (choice / score / yes-no) and returns calibrated probabilities in one forward pass.

**Fit for this app:**
- It cannot write questions, options or explanations, so it cannot replace the generator.
- It could be a cheap side-checker, for example "is this item answerable from the source?" or tagging the Bloom level.

**Why it is not added now:**
- There is no browser build. It uses a custom architecture with Python pre/post-processing, so it would need an ONNX export plus a JS port.
- It is another ~840 MB download on top of the generator.
- Its card reports 0.36 zero-shot vs 0.77 fine-tuned accuracy on its own typed-decisions benchmark.

**Future use:** the approve/reject decisions instructors make in this app are the data a fine-tuned "likely to be rejected" predictor would need. Collecting them would require opt-in, because nothing leaves the browser today.

**Jev (TypeSafe AI, 2026-09-15)** is the hosted model Laya is an open version of: typed, probabilistic decisions instead of text, by API, early access only. It would send source text and drafts to another company, which the no-login, in-browser design avoids. Considered on 2026-10-07 for math drafts that kept failing: neither model helps there, because the app's own checks already know exactly what is wrong, and only the generator can write the fix. Clearer error messages did help (see [adapt-formats-and-math.md](adapt-formats-and-math.md)). Where a decision model could help later is in judgment calls the checks cannot make, such as a wrong answer key that the reviewer defended.

**Other models considered:**
- **Phi-4-mini 3.8B** (MIT, 2.2 GB) and **Ministral 3 3B** (Apache-2.0, 2.0 GB): both are in WebLLM and worth A/B testing against Qwen3.5-4B.
- **Llama 3.2 1B/3B:** community license.
- **Gemma 4 E2B/E4B** (now Apache-2.0): not in WebLLM (rechecked 2026-10-05: only Gemma 2 and Gemma 3 1B). E4B was added through Transformers.js on 2026-10-06, see below. E2B was about 1.6 times as fast again but wrote more wrong answer keys, so it is not offered.
- **LFM2.5-1.2B:** the license restricts commercial use above $10M revenue.
- **Phones:** iOS tabs are killed at roughly 1.5–3 GB, so phones are out of scope.

Rough speeds (estimates, not measured here): Qwen3.5-4B runs at about 15–25
tokens/s on a base M1/M2 and 5–12 on Intel Iris Xe. The 2B model is about twice as fast.

**Pitfalls handled in code:**
- **Thinking mode:** Qwen3.5 "thinks" by default, so the app passes `enable_thinking: false` and strips any `</think>` prefix.
- **JSON mode prompting:** the prompt must also ask for JSON, or the model can stall emitting whitespace.
- **Model download caching:** WebLLM keeps weights in the Cache API. The service worker never caches them. `navigator.storage.persist()` is requested before download.
- **Numbers with only a lower bound:** XGrammar compiles `minimum` or `exclusiveMinimum` without a maximum into a grammar that cannot write 0.5 or 0.05, only 0 or numbers of 1 or more. That is why Qwen wrote `step: 0` and `tolerance: 0`. `toLlmSchema` now drops lower-only bounds on numbers; zod still enforces them. Asked for `{"step": 0.5, "tolerance": 0.05}`, Qwen3.5 4B wrote `0, 0` in 3 of 3 tries before the change and `0.5, 0.05` in 3 of 3 after. In a math-only run afterwards (4 questions from *College Physics* 2.3), none of 7 attempts wrote step 0, against 19 of 44 before the step repair; that page's ranges were all whole numbers, so the probe is the stronger evidence.
- **Not handled yet:** WebLLM issues #807/#766 report an occasional XGrammar "invalid token id" abort with q4f16. Retrying usually works; switching to the q4f32 build is the fallback.

### Wrong answer keys and the answer check (2026-10-07)

**The problem:**
- Gemma 4 E4B writes true statements as wrong choices in multiple-choice and select-all questions. Examples:
  - `a = F/m` as a wrong choice next to the key `F = ma`.
  - "The net external force is proportional to the acceleration" marked wrong.
  - "If the net force is zero, the acceleration is zero" marked wrong.
  - In "which forces are left out" questions, one left-out force marked correct and the others marked wrong.
- Its feedback on such a choice often admits it is true ("This equation is correct…, but…").
- Of 18 wrong keys in 120 questions, 15 were already in the draft. The reviewer kept all 15 and introduced the other 3. Twice it noted the problem ("mathematically equivalent to the correct choice") and kept the key: shown a key, it defends it.

**How it was measured:**
- 60 questions per run: 4 for each of 15 concepts from *College Physics* 4.3 and 4.4 (multiple choice, select-all, multiple choice, select-all), review on, Gemma 4 E4B.
- The runs were shuffled together and judged blind, from the stem and the choices with their key. Feedback was left out, because it could give the run away.
- **Wrong:** a choice marked correct is false, a choice marked incorrect is true, or a multiple-choice question has a second, equally correct choice.
- **Debatable:** a wrong choice that is true but less complete than the key, or whose truth depends on how it is read.

**Prompt rules and a phrase check did not work:**
- The prompts said a wrong choice must be false, never true but unstated in the excerpt. A code check sent back a wrong choice whose feedback said "not explicitly stated" or "implied".
- Result: wrong keys 8 → 10 of 60, debatable 5 → 4, time 3163 → 3541 s.
- The phrase check never fired. That phrasing came from the 4 wrong keys seen earlier, and it appeared only once in the 60 new drafts.
- The change was reverted.

**The answer check:** a separate call answers the question without seeing the key, using the whole section the question was written from. Two output formats were run on the same 120 judged questions (18 wrong keys, 9 debatable, 93 right):

| | True/false per choice after a reason | "1 wrong: reason" for each choice, then the list of right choices |
|---|---|---|
| Wrong keys found | 11 of 18 | 16 of 18 |
| Right keys flagged | 21 of 93 | 5 of 93 |
| Debatable keys flagged | 1 of 9 | 2 of 9 |
| Time per question | 17 s | 24 s |

- **First format:** about 17 of its 21 false flags were a reason that called the choice wrong, followed by a verdict marking it correct.
- **Second format:**
  - Each of its 16 finds pointed at the bad choice.
  - It missed "friction is *always* an external force" and "the weight is 9.8 N *only if* its mass is 1.0 kg".
  - Of its 5 false flags, 3 were physics mistakes by the check and 2 were questions with unclear stems.
  - It is the format in the app (`keyCheckPrompt`, `checkAnswerKey`), with shorter lines since 2026-10-08 (see below). It was chosen after seeing its results on these 120, so the first numbers from other pages will be the real test.

**In the app:**
- The check runs on the in-browser model only, for multiple-choice and select-all questions, after the review. Since 2026-10-09 it also checks true/false questions (a note only) and fill-in-the-blank questions; see "The fill-in-the-blank check" and "Smaller fixes" below.
- **On a disagreement:** the question goes back once through the reviewer, naming the choices (`verifyAnswerKey`), and is checked again. If the check still disagrees, the question keeps a note for the instructor.
- **gpt-6-luna is not checked:** none of its 32 multiple-choice and select-all questions had a wrong key.

**End-to-end test:** the same 60 questions as the before run, written with the check. The 120 were judged blind together. My verdicts on the 60 before questions matched the first judging for all 60.

| | Before | With the check |
|---|---|---|
| Wrong keys | 8 | 4 |
| Wrong keys without a note | 8 | 1 |
| Debatable keys | 5 | 3 |
| Sent back to be fixed | — | 10: 6 fixed, 4 kept with a note (3 wrong, 1 debatable) |
| Time for 60 questions | 3163 s (53 s each) | 5198 s (87 s each, 28 s of it the check and fixes) |

- **What the fixes did:** none introduced a new error. The 3 wrong keys a fix did not repair all kept a note, and the one wrong key without a note was a miss by the check.
- **Cost:** these question types took about 64% longer on Gemma. Drafting and review also ran 6 s slower per question than in the before run, which is normal variation between runs. The shorter lines below cut the check from 24 s to 8 s a question.
- **Limits:** one pair of pages, one model and one judge.

**Shorter reasoning (2026-10-08):** asked for "a short reason" per choice, the check wrote about 1,000 characters of `working` and often ignored the one-line format. With no reasoning at all, it took 4 s a question, so nearly all of the 24 s was the reasoning. Same 120 judged questions:

| | "A short reason" (end-to-end test above) | One line per choice, at most 12 words (now in the app) | No reasoning, only the list of right choices |
|---|---|---|---|
| Wrong keys found | 16 of 18 | 16 of 18 | 14 of 18 |
| Right keys flagged | 5 of 93 | 4 of 93 | 8 of 93 |
| Debatable keys flagged | 2 of 9 | 4 of 9 | 4 of 9 |
| Time per question | 24 s | 8 s | 4 s |
| Reasoning written | about 1,000 characters | about 300 | none |

- **The short lines found the same wrong keys:** the same 2 misses. In 13 of the 16 finds the check disagreed on exactly the same choices; in the other 3 the choices overlapped.
- **Not measured end-to-end.** From the end-to-end test (a fix for about 1 question in 6, each a review call plus another check), the check and fixes should drop from about 28 s to about 13 s a question. On top of the before run's 53 s, that is about 25% more time instead of about 50%.

### Fill-in-the-blank answers and plain-text symbols (2026-10-08)

**The problem:** found in the live-site end-to-end test (see [adapt-qti-import.md](adapt-qti-import.md)).
- ADAPT grades fill-in-the-blank by exact match, ignoring case, against the first answer only. Gemma wrote keys such as "w = mg", "9.8 N", "9.8 m/s^2", "F_{net}/m" and "a ∈ F_{net}". A student who types "w=mg" or "9.8N" is marked wrong.
- Gemma also writes symbols as plain text ("F_net", "F_{net}"), which ADAPT shows as typed. Some are the textbook figure's force labels (F_prof, F_floor), which students never saw.

**How it was measured:** 30 fill-in-the-blank questions per run: 2 for each of 15 concepts from *College Physics* 4.3 and 4.4, review on, Gemma 4 E4B, drafted and reviewed as in a real run. The before run and the "reject and retry" run (57 questions) were shuffled together and judged blind. A question was good if a student who knows the answer would type the key, the sentence alone pins the answer down, and the blank tests an idea rather than a filler word.

| | Before | Reject and retry | Review, then note (now in the app) |
|---|---|---|---|
| Keys that are numbers, symbols or equations | 5 | 0 | 4, each with a note |
| Questions written | 30 of 30 | 27 of 30 | 28 of 30 |
| Rejected attempts | 22 | 79 | 38 |
| Time | 15.6 min | 31.1 min | 20.8 min |

- **Rejecting worked but cost too much:** no bad keys, but twice the time and 3 questions left out, all on calculation concepts ("Weight Calculation"), where Gemma kept offering "9.8 N" or "g". Told not to use numbers, it blanked words already in the sentence, so "the stem gives the answer away" rejections went from 7 to 31.
- **Blind read:** good questions 14 of 30 before, 15 of 27 after. The rule removes the bad keys, not Gemma's other weak blanks.
- **The 2 questions left out in the last run** failed on the older paragraph-number rule: Gemma wrote "paragraph 3" into the explanation in all 9 attempts. That rule rejected 16 to 29 attempts per run of 30. Such mentions are now rewritten instead; see the next section.
- **What the app does now:** `typedAnswerProblem` sends such a key to the review pass that already runs, asking for a word to blank instead. If the key is still a number, symbol or equation, the instructor gets a note. Over two runs Gemma's reviewer fixed 1 of the 8 keys it was sent. It usually recognized the problem and listed it, so its own note on that answer is dropped in favour of the app's. In practice this is a note. Single letters such as "g" in "w = m____" are allowed: they match exactly.
- **Plain-text symbols are repaired, not rejected:** as a check that sent them back, Gemma could not write "F_net" as math in 9 attempts, and 2 of 30 questions failed on it. `symbolsToMath` now wraps a one-letter name with a subscript, outside math and placeholders, in `\( \)`, except in titles. On the 823 saved drafts, it changed 139 of 5,595 texts. Every change was F_net or a professor-example force label, and all rendered in KaTeX.
- **Figure labels remain:** wrapping makes `\(F_{prof}\)` render, but students still don't know what it is. In 13 multiple-choice and select-all questions on the professor example, 4 used the figure's labels ("System 1", F_prof), only 1 of them as plain text. No code check can tell a label from a symbol the question defines. **Addressed 2026-10-09** with a prompt and reviewer rule; see "Figure labels" below.

**Gemma's other weak blanks (not fixed):** about half of its fill-in-the-blank questions were weak either way.
- Ambiguous blanks copied from the textbook: "do not cancel if they act on different ____" ("systems", but "objects" is also right), "experiencing a force ____" ("itself"), "defined differently for each ____" ("problem").
- Multi-word keys few students would type exactly: "elements of the system", or "proportional to" before the word "to".
- **Fixed 2026-10-09:** see "The fill-in-the-blank check" below.

### Paragraph numbers: rewritten, not rejected (2026-10-08)

**The problem:** the model is shown the source as `[paragraph N]` blocks and cites them in explanations students read. Since 2026-10-05 that was rejected and sent back. It was the most common rejection for Gemma 4 E4B: 29 of 41 in the last fill-in-the-blank run, and 18 of 25 in one select-all run. Gemma repeats it on retry, so 2 of 30 questions were left out.

**Real examples first:** 30 fill-in-the-blank and 15 select-all drafts (same 15 concepts, every attempt saved; localStorage `qsParaBench.collect`). 31 of 39 rejected attempts were this rule, all in the explanation. One question failed all 9 attempts on it. The forms:
- The paragraph as the subject: "Paragraph 21 explicitly states that …", "Paragraph 24 and 26 explicitly state the relationship as F = ma", "…, and paragraph 19 provides the formula: …"
- After a reporting verb: "The source states in paragraph 21 that …", "… in paragraph 21: "…""
- A trailing clause: "…, as shown in paragraphs 14 and 21."
- A citation in brackets: "(Paragraph 10, 21)", "[paragraph 12]"

**The repair:** `stripParagraphMentions` (pipeline.ts) runs in `repairDraft` on every text field of a draft or a reviewer revision, before the checks.
- Bracketed citations and "as shown in paragraph N" clauses are dropped.
- "in paragraph N" after "states" is dropped.
- A paragraph used as the subject becomes "the textbook", with a singular verb: "The textbook explicitly states that …".
- A sentence that opens with "According to paragraph 3," starts at the next word.
- Dropping the subject outright breaks sentences such as "… state the relationship as F = ma", which is why it becomes "the textbook". `stripSourceReferences` already leaves "the textbook" alone.
- The check stays as a fallback for forms the repair misses.

**Re-scoring the saved attempts:** all 31 paragraph rejections pass with the repair. No other attempt's result changed. Attempts needed fell from 83 to 51, and the question that failed 9 times passes on its first attempt. All 25 distinct rewritten explanations read correctly.

**End to end:** the same 30 fill-in-the-blank jobs as the earlier runs (review on, Gemma 4 E4B), compared with that section's final run.

| | Before (reject) | After (rewrite) |
|---|---|---|
| Questions written | 28 of 30 | 30 of 30 |
| Paragraph-number rejections | 29 | 0 |
| All rejected attempts (draft + review) | 41 | 17 |
| Fresh starts | 5 | 0 |
| Time | 20.8 min | 14.0 min |
| Keys that are numbers, symbols or equations (each with a note) | 4 | 6 |

- 8 of the 30 drafts say "the textbook", against 2 in the earlier run. That is where the rewrite shows; the harness does not save raw attempts, so the exact count is unknown. All of those sentences read correctly.
- The 2 extra number keys came from calculation concepts. One of them, "Newton's Second Law Equation", was left out entirely in the earlier run.
- Review rejections rose from 3 to 8: five "the stem gives the answer away" and two concept labels that were too long. That is the reviewer varying between runs, not this change.
- **Not fixed, seen while reading:**
  - One attempt copied the textbook's display math without its backslashes ("[a = \dfrac{F_{net}}{m}. \nonumber ]"). The paragraph rule happened to reject it. **Fixed 2026-10-09:** `bracketsToDelimiters` turns square brackets outside math that hold a LaTeX command back into `\[ \]`. On all 3,892 saved texts it changed only that one, which then rendered in KaTeX. 3 texts had LaTeX with no delimiters at all. **Fixed 2026-10-09:** `bareLatexToMath` wraps a text that is only a formula in `\( \)`, such as a choice "x = x_0 + \bar{v} t" or a key "a \propto F_{net}". In a sentence it writes common commands as characters ("w = (1.0 kg) × (9.8 m/s^2) = 9.8 N"), because a formula's ends cannot be told from the words around it. On all 4,138 saved texts it changed only those 3. Both wrapped formulas rendered in KaTeX, and no saved text has LaTeX outside math any more.
  - One reviewer revision replaced `\(w\)` and `\(m\)` with "™" and "Å". This was the only case in all the saved runs.

### The fill-in-the-blank check (2026-10-09)

**The problem:** in the blind read of 57 Gemma 4 E4B fill-in-the-blank questions (previous sections), 29 were good. The rest:
- 13 had a blank another word fits as well. Examples: "do not cancel if they act on different ____" (systems, but objects too) and "without experiencing a force ____" (itself).
- 8 had a key few students would type the same way: "elements of the system", "force of gravity", "9.8 N".
- 6 were broken, and 1 blanked a filler word ("between").

ADAPT marks only the exact key right, so a student who writes "objects" is marked wrong.

**The check:** the model fills the blank the way a student would, without seeing the key. Three forms were run on all 115 saved questions from the earlier runs, 57 of them judged blind:

| | Without the textbook (now in the app) | With the textbook | Listing every right answer |
|---|---|---|---|
| Ambiguous blanks it disagreed with | 12 of 13 | 7 of 13 | 13 of 13 |
| Hard-to-type keys it disagreed with | 4 of 8 | 3 of 8 | 8 of 8 |
| Good blanks it disagreed with | 6 of 29 | 1 of 29 | 29 of 29 |
| Time per question | 0.7 s | 3.3 s | 1.4 s |

- **With the textbook,** the check copied the textbook's word, so it filled "systems" and "itself" exactly as the keys, though students would not.
- **Listing every right answer** produced synonyms for every question.
- **Without the textbook,** some of the 6 disagreements on good blanks were fair. "A change in motion is equivalent to a change in ____" (velocity) drew "momentum", and "weight varies depending on ____" (gravity) drew "location".
- **What is in the app:** the form without the textbook (`checkBlank`). It never catches a number key it can copy from the sentence, such as "9.8 N"; the app's own number check (`typedAnswerProblem`) covers those.

**The fix:** sent to the reviewer, a number key was replaced 1 time in 8 (see "Fill-in-the-blank answers" above). So the fix is narrower (`verifyBlank`):
1. The key goes back into the sentence.
2. The model names up to three other words of it to blank (`reblank`).
3. The app blanks each in turn, if it appears once outside math and is a word of at least three letters, not a number or symbol.
4. It keeps the first one the check fills in as the key.

The sentence and explanation stay as they were, so the question's facts do not change. If no word passes, the question keeps its blank, with a note if the check disagreed.

- **On the 115 saved questions:**
  - 51 passed the check, 49 got a new blank, and 15 kept theirs with a note, at 1.7 s a question on average.
  - Ambiguous blanks: 8 of 13 got a new blank, 4 a note, and 1 was missed.
  - Hard-to-type keys: 7 of 8 got a new blank, and 1 was missed.
  - Good blanks: 23 of 29 were left alone, 4 got a new blank and 2 a note.
- **Typical new blanks:** "the ____ of a 1.0 kg object on Earth is 9.8 N" (weight) in place of "9.8 N", and "Forces always occur in ____" (pairs) in place of "itself".
- **Obvious words:** Gemma also offers words the rest of the sentence gives away, such as "Two equal and opposite ____ exerted during an interaction" (forces).
  - It offered that word first even when the prompt named this very example.
  - Asking it first to say what the sentence teaches did not change the words it picked, and took 60% longer (4.1 s against 2.6 s per fix).
- **Repeated words:** a two-word key put back into its sentence repeated a word ("an internal force force", "proportional to to"). `fillIn` writes it once.

**End to end:**
- **Setup:** the same 30 fill-in-the-blank jobs as the last run in "Paragraph numbers" (review on, Gemma 4 E4B), now with the check.
- **Blind read:** the two runs were shuffled together and read blind from the stem and key; the notes were hidden because they would give the run away.
- **Verdicts, fixed before reading:**
  - **Good:** a student who knows the material would type exactly the key, the sentence pins it down, and the rest of the sentence does not give it away.
  - **Ambiguous:** another answer fits.
  - **Hard to type:** the key is a phrase, number, symbol or equation that students would type differently.
  - **Given away:** the rest of the sentence gives the word away.
  - **Broken:** the sentence or key is wrong or garbled.

| | Before (paragraph rewrite run) | With the check |
|---|---|---|
| Good | 11 of 30 | 23 of 30 |
| Ambiguous | 8 | 4, each with a note |
| Hard to type | 10 (6 with a note) | 0 |
| Given away | 0 | 2 |
| Broken | 1 | 1 |
| Weak with no note | 13 | 3 |
| Questions written | 30 of 30 | 30 of 30 |
| Time | 14.0 min | 21.0 min |

- **What the check did:**
  - 16 questions passed the check.
  - 10 got a new blank. Four were "9.8 N", "9.8 m/s^2" or "force of gravity" becoming "weight" or "mass". Others included "itself" becoming "pairs" and "internal forces" becoming "internal".
  - 4 kept their blank with a note: "differently" twice, "motion" and "reaction force".
- **Given away:** both new weak blanks were "given away". "An ____ force acts from outside the system …, while an internal force acts between elements" replaced the hard-to-type key "elements of the system", and "net external ____ … `\(F_{net}\)`" replaced "`\(F_{net}\)`/m". Both are still gradable, which the old keys were not.
- **Broken:** the broken question had the key "is" in "The weight ____ of an object…". Its new blank kept the stray word, giving "The ____ is of an object".
- **Time:** the check and the new blanks took 2.2 s a question, 67 s in all. The other 6 minutes came from drafting and review. They had 26 rejected attempts against 17 and 2 fresh starts, which is the variation between runs seen before.
- **Limits:** one pair of pages, one model and one judge, who also wrote the check.

### Figure labels (2026-10-09)

**The problem:** the textbook's worked example names its parts in a figure:
- "System 1" is the professor and the cart, and "System 2" is the cart alone.
- The forces are labelled `\(F_{prof}\)`, `\(F_{cart}\)`, `\(F_{foot}\)` and `\(F_{floor}\)`.

Gemma copied these labels into questions, where students have no figure to look them up. No code check can tell such a label from a symbol the question defines.

**The fix:**
- The system prompt says never to use the excerpt's own labels for the parts of its figures and examples. It asks for the thing in words instead: "the professor and the cart together", "the force of the floor on the professor".
- The reviewer is told to look for such labels too.

**How it was measured:**
- Jobs: the three professor-example concepts and "System Dependence of Forces", as multiple choice and select-all, 3 times each (draft and review, Gemma 4 E4B).
- **Before:** the same code with the two new sentences removed from the prompts. I checked that this gives exactly the old prompts.
- The 6 calculation jobs were left out of the before run. They never used a label in either run and take 2 to 3 minutes each.

| Of 18 questions | Before | After |
|---|---|---|
| Use any label from the figure | 10 | 4 |
| Use a force label such as `\(F_{prof}\)` | 4 | 0 |
| Use a label the question never explains | 3 | 0 |
| Time | 18.8 min | 21.1 min |

- **Remaining labels:** all 4 after questions use "System 1" and "System 2", but define them in the stem ("if System 1 includes both the professor and the cart, and System 2 includes only the cart"). Students can follow that.
- **Force labels:** none were left. The questions say "the force from the floor" and "the force the professor exerts on the cart" instead.
- **Unexplained labels before:** for example, "why are the forces `\(F_{prof}\)` and `\(F_{cart}\)` not included …", and a select-all whose choices were only "The force `\(F_{prof}\)`", "The force `\(F_{cart}\)`" and so on.

### Concept labels (2026-10-09)

**The problem:** one section's concepts once came back labelled "Calculation", "Concept" and "Concept". The test runs reused those concepts, so 6 of every 30 questions carried "Concept" or "Calculation" as the concept label that instructors see on the question.

**The fix:**
- The concept prompt asks for a label that names the idea itself ("Newton's third law", "Mass versus weight"), never a word for its kind.
- `extractConcepts` sends back a batch with a label that is only such a word, optionally numbered: concept, calculation, topic, definition, relationship, formula and the like (`GENERIC_LABEL`).

**Measured:** all 8 sections of *College Physics* 4.3 and 4.4, 3 times each, with and without the new prompt line:
- 0 of 36 labels were generic in either run, and no attempt was rejected.
- Extraction took 12.4 s against 12.8 s per section.
- The bad labels did not come back, so the rejection is a safety net. A unit test covers it.

### Smaller fixes (2026-10-09)

**"The source states that …":**
- Gemma opens explanations and choice feedback with "The text states that …" or "The source explicitly states, "…"". Students never saw "the source".
- Across 2,542 distinct stems, explanations, feedback and model answers in the saved runs, 556 had such an opening that the earlier clean-up left, nearly all explanations and feedback.
- `stripSourceClaims` now runs on stems, explanations, feedback and model answers when a question is saved:
  - A sentence that only reports a clause or a quotation becomes the clause itself (410 texts): "The text states that weight is a measure of the force of gravity" → "Weight is a measure of the force of gravity". This includes "The textbook states that …", which the paragraph-number rewrite produces.
  - Where the clause cannot stand alone, "the source" becomes "the textbook" (146 texts). Examples: "…, not that they are equal", "…, but does not say …", "…, and provides the equation …", or a quotation followed by more text.
  - "It also states that …" after such a sentence is dropped too.
- `stripSourceReferences` also removes "based on the context provided" and "based on the provided information". It now runs on feedback too, and removes only a reference that ends a clause, so "as shown in the context of the wagon" stays.
- I read samples of the rewritten texts after each change and fixed the forms that broke a sentence. In the last sample of 30, 29 read correctly; one kept a dangling "…, using the example of a swimmer and a pool wall". 4 texts still mention the source in other wordings.

**Math explanations without the result:**
- 21 of 25 saved Gemma math explanations explain the formula but never give the result, for example "a = F_net / m.", so a student who got the question wrong never sees the number.
- `withFinalValue` adds "With these numbers, the answer is {{answer}} m/s²." to an explanation that shows neither {{answer}} nor a placeholder equal to the answer formula. The app computes the value for each version.

**True/false keys:**
- The check from "Wrong answer keys" now also judges true/false statements without the key (`checkTrueFalse`, about 4.5 s).
- On the 28 saved true/false questions (Gemma and Luna, all keys right in the blind read), it agreed with 27. The one disagreement was the check's own mistake: it judged "two equal and opposite forces … cancel if they act on the same system" false.
- Sent back to the reviewer like a multiple-choice key, that question came back 4 times:
  - twice with a different true statement;
  - once kept, with a note;
  - once with its correct key flipped to false, which the recheck then agreed with.
- So a true/false disagreement only adds a note for the instructor. No wrong true/false key has been seen in these runs, so the check mainly guards against one.

### Fine-tuning Gemma (considered 2026-10-07, not started)

The question: could a large model (Luna, another GPT-6 model, or Claude) teach Gemma 4 E4B to write better questions, by fine-tuning it on the large model's questions (distillation), for example with Unsloth? And would a smaller fine-tuned model, such as E2B, do as well while fitting on more machines? Parked for now; this is what was found.

**Today nothing is distilled.** Luna is only the yardstick in the before/after tests. Every improvement to Gemma so far came from the prompts, the app's checks and automatic retries.

**Training is the easy part:**
- Unsloth supports Gemma 4 E2B and E4B (text, vision, audio and RL fine-tuning). Its guide gives about 17 GB of GPU memory for E4B with LoRA and 18–22 GB with QLoRA, and recommends E4B QLoRA over E2B LoRA.
- Unsloth Studio is its open-source, no-code interface for training, running and exporting models. Its "Data Recipes" turn documents into synthetic datasets.
- Training needs a GPU machine or a cloud GPU; none of it runs in the browser.

**Getting it into the app is the risk:**
- The app loads `onnx-community/gemma-4-E4B-it-ONNX` (q4f16) through Transformers.js. A fine-tune has to be merged, exported to ONNX (Gemma 4's "E" architecture), quantized to q4f16 and hosted on Hugging Face for download.
- Unsloth exports GGUF and safetensors, not this ONNX build, and no published recipe for exporting Gemma 4 to ONNX turned up (2026-10-07).
- **First step if this is revisited:** export the unmodified E4B ourselves and check that it runs in the app and writes the same questions as the onnx-community build. If that fails, fine-tuning Gemma is a dead end here. Qwen3.5 4B through WebLLM may be easier, because MLC compiles fine-tuned weights of an architecture it already supports.

**Training data:**
- **Provider terms:** OpenAI's terms forbid using its output to develop models that compete with OpenAI. Anthropic's commercial terms have a similar clause about training competing models. Whether a question-writing model counts is for LibreTexts to decide, for either provider.
- **A route without that question:** generate many questions with Gemma itself and train only on those that pass the app's checks and a judge. In the long run, the questions instructors approve are the best data; collecting them needs opt-in, because nothing leaves the browser today (see Laya above).
- **Source licenses:** LibreTexts books are mostly CC BY-NC-SA, so check each book's license (the app stores it with each source).
- **Format:** the exact prompts and JSON schemas the app sends (`draftPrompt`, `reviewPrompt`, `llmSchemaFor`), from many subjects, not only physics.

**What to expect:**
- Fine-tuning fixes habits well: valid JSON on the first try (fewer retries, so faster runs), feedback that says why a choice is false, stems that state every given, and not marking a true statement wrong because the excerpt does not say it.
- It adds little knowledge. Whether a statement is true still depends on what the model knows and what it was shown. E2B wrote more wrong answer keys than E4B (above); a fine-tune might close part of that gap, but outside the subjects it was trained on, smaller models should be expected to get more keys wrong.
- **Memory:** WebGPU runs the model in GPU memory, which on Macs and laptops with integrated graphics is system RAM, so a smaller model fits more machines. Not measured: a page cannot read GPU memory use.

**If revisited, in this order:**
1. Prove the ONNX export path with the stock model.
2. Build a held-out test set from several subjects, with an automatic judge. Today's tests use two physics pages, judged by hand.
3. Generate and filter training data in the app's format.
4. Train E2B and E4B with LoRA, and compare them with the stock models on that set, for quality and for time per question.

Sources: [Unsloth Gemma 4 fine-tuning guide](https://unsloth.ai/docs/models/gemma-4/train), [Introducing Unsloth Studio](https://unslothai.substack.com/p/introducing-unsloth-studio), [OpenAI Terms of Use, prohibited conduct (summary)](https://conductatlas.com/platform/openai/openai-terms-of-use/usage-policy-and-prohibited-conduct/), [Model distillation: terms of service and IP law](https://www.ertas.ai/blog/ai-model-distillation-ip-law).

## 2. OpenAI bring-your-own-key: "Luna"

- **Models:**
  - **`gpt-6-luna`** is the low-cost tier of the GPT-6 family (Astra > Sol > Luna). It was released 2026-09-22 and costs $0.10 / $0.50 per 1M input/output tokens.
  - **`gpt-5.6-luna`** is the previous generation.
  - Both have a 1.05M-token context window.
- **Reasoning effort:** "on high" is the reasoning effort setting. The Responses API takes `reasoning: { effort: "high" }`. Allowed values are `none`, `low`, `medium` (the default), `high`, `xhigh` and `max`. The app defaults to `high` and lets the user pick down to `low` or up to `xhigh`.
- **Responses API usage:**
  - The app calls the Responses API with `text.format: { type: "json_schema", strict: true }`, which gives schema-guaranteed output.
  - Strict schemas need every field listed in `required` and `additionalProperties: false`. They do not accept `minLength` or `maxLength`; the app removes those, and zod enforces them afterwards.
- **Browser access:**
  - api.openai.com answers CORS preflights with `access-control-allow-origin: *`, so the browser calls it directly with plain `fetch` (no SDK, no proxy).
  - The `x-ratelimit-*` headers are not exposed to browser code, so 429 errors are retried with a fixed backoff.
- **Streaming:** requests use `stream: true` with `reasoning.summary: "auto"`. The connection stays active during long high-effort reasoning, and summaries show as progress.
- **Data retention:** `store: false` is always sent. OpenAI keeps abuse-monitoring logs for up to 30 days.
- **Key storage:**
  - By default the key lives in memory only.
  - With "Remember on this device", it is AES-GCM encrypted under a non-extractable WebCrypto key kept in IndexedDB.
  - That stops casual copying from disk or exports. It does not stop script running on this origin, which is why the app loads no third-party scripts.

**First live test (2026-10-07, gpt-6-luna, high effort).** Until then the OpenAI path had only run against a fake provider. College Physics 4.3 and 4.4:

| | Gemma 4 E4B (2026-10-06) | gpt-6-luna |
|---|---|---|
| Set: 3 per page, five types, review on | 6 of 6 in 297 s | 6 of 6 in 162 s, every call valid first time |
| Questions with a problem a reviewer would catch | 5 of 8: an MC distractor that is also correct, a debatable select-all key, a circular distractor, two near-duplicates | 2 of 6: a fill-in-the-blank missing the data it needs, broken math delimiters (now repaired) |
| 12 math drafts, same concepts as the error-message test | 10 of 12, 23 calls, 674 s | 12 of 12, 13 calls, 171 s |
| Cost | none | about $0.01 per test (31K in / 14K out tokens for the set) |

- **Luna's questions** were mostly applied ones: a scenario, numbers from the source, wrong choices that are real misconceptions with feedback. Gemma's mostly restate a source sentence.
- **Missing data:** a fill-in-the-blank asked for "the professor's force on the cart" (53 N) without giving the masses, friction or acceleration from the textbook example; the reviewer did not notice. Its exact-text answer "53 N" also had no alternates.
- **Answerable from the question alone (2026-10-07).** The system prompt said every question "must be answerable from the supplied textbook excerpt alone", which let a question lean on the excerpt's worked example. It now says students see only the question, so it must state every number, name and situation it needs, and never mention an example, figure, table or person it does not describe. The reviewer checks for the same thing and adds what is missing. `parseDraft` rejects "Figure 4.3.1", "Table 2" and "Example 4.4". Thirty questions per run (two for each of 15 concepts from College Physics 4.3 and 4.4: multiple choice, true/false, select-all, fill-in-the-blank, review on), 120 in all, judged blind in random order:

  | | Gemma before | Gemma after | Luna before | Luna after |
  |---|---|---|---|---|
  | Written | 30 | 30 | 30 | 30 |
  | Not answerable from the question | 6 | 1 | 3 | 0 |
  | Borderline (leans on an example but answerable) | 0 | 1 | 3 | 1 |
  | Wrong answer key (not targeted) | 2 | 1 | 0 | 0 |
  | Time | 1198 s | 1040 s | 430 s | 417 s |

  The failures were the professor-and-cart example without its masses or friction, the example's force labels ("System 1", F_prof, F_foot), "based on the context provided", and a force called internal or external without saying which system. The remaining Gemma failure uses those force labels, which the code check does not cover. None of the 120 named a numbered figure, so the check did not fire here.
- **Control characters:** under strict JSON output a backslash must start a valid JSON escape, so where Luna meant `\(` it wrote `\f(`, `\u0005(` or a stray `\u0002`: 3 of its 18 questions, whose math then did not render. `controlsToBackslashes` (pipeline.ts) restores the backslash in every prose field, and the QTI export drops characters XML forbids, because one of them made the whole quiz file invalid XML.

## 3. Getting LibreTexts content from a browser

| What | Endpoint | Browser CORS |
|---|---|---|
| Page info / contents / tree / subpages / tags | `https://api.libretexts.org/endpoint/cross-library/https://{lib}.libretexts.org/@api/deki/pages/{id or =path}/…?dream.out.format=json` | **Echoes the origin.** Plain GET only, with the target URL appended unencoded. |
| Deki API directly (`{lib}.libretexts.org/@api/deki/...`) | — | No CORS headers |
| `api.libretexts.org/endpoint/contents` and `/info` (used by assessment-ai) | — | Only `*.libretexts.org` origins (the server version sets `Origin` by hand) |
| Commons search / book / table of contents (`commons.libretexts.org/api/v1/...`) | — | Only `*.libretexts.org` origins |
| Commons master catalog | `/api/v1/commons/mastercatalog/v2` | Same origin limit, but Node can fetch it at build time |

**Decisions:**
- **Book search** runs over a catalog snapshot bundled at build time (`npm run catalog`): 4,125 books, 250 KB gzipped, precached for offline use.
- **Hosting:** if the app is hosted on a `*.libretexts.org` subdomain, live Commons search would also work and could replace the snapshot.
- **Fetching pages:**
  - Tables of contents and page text come from `cross-library` (verified: chem book 415392, 278 pages, about 1.5 minutes for a full book at 4 concurrent requests).
  - Pages are cached in IndexedDB.
- **Pasted URLs:**
  - Accepted forms: any `https://{library}.libretexts.org/...` page, `/@go/page/{id}`, and `/@api/deki/pages/{id}`.
  - The app resolves the URL and shows its subtree, so a page, a chapter or a whole book all work.
- **"LibreTexts CLI":** the only one found is `johnnylibretexts-ai/libretexts-cli` (Go; search, page, tree, extract, pdf). It calls the same Deki and Commons endpoints, which a browser can only reach through `cross-library`. Its logic is mirrored in `src/lib/content/libretexts.ts`.
- **The "reader" app:** the desktop reader that imports books (`libretexts-reader`, Tauri) uses Commons `books-v2` search and the Deki `tree` and `contents` endpoints, the same steps as here.
- **Open item:** `cross-library` is an undocumented community endpoint. Ask LibreTexts to confirm it is supported for this use, or host the app on a libretexts.org subdomain.
