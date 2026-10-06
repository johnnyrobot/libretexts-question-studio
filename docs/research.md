# Research notes (October 2026)

Background for the decisions in this app. Versions and model lists were checked
on 2026-10-05.

## 1. Running a model in the browser

### Runtime: WebLLM

| Runtime | Version | GPU / CPU | Schema-constrained JSON | Notes |
|---|---|---|---|---|
| **WebLLM** (`@mlc-ai/web-llm`) | 0.2.85 (2026-09) | WebGPU only | **Yes**: XGrammar, `response_format: {type: "json_object", schema}` | Prebuilt Qwen3.5 models, `hasModelInCache()`, runs in a Web Worker, needs no COOP/COEP headers. Apache-2.0. **Chosen.** |
| Transformers.js | 4.3.0 | WebGPU or WASM | Experimental (separate package) | Already used by the LibreTexts reader for speech. A good fallback runtime. |
| wllama (llama.cpp WASM) | 3.8.1 | WebGPU + CPU fallback | Yes (`json_schema`, grammar) | The only real CPU path, but slow, and multi-threading needs cross-origin isolation. |
| Chrome Prompt API (Gemini Nano) | Chrome 148+ stable | browser-managed model | Yes (`responseConstraint`) | Chrome desktop only, not available in workers, 22 GB free disk required. A possible zero-download extra later. |
| MediaPipe LLM Inference | 0.10.29 | WebGPU | not documented | Maintenance-only; Google points to LiteRT-LM, which is in early preview. |

**Browser support for WebGPU:**
- **Chrome/Edge:** Windows, macOS and ChromeOS since 113. Linux only on some GPUs.
- **Safari 26:** macOS and iOS, on by default.
- **Firefox:** Windows (141+) and Apple Silicon macOS (145+), but without `shader-f16`, so the app automatically picks the `q4f32` model builds there.

### Models

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
  - "paragraph N" in student-facing text;
  - true/false, fill-in-the-blank and dropdown stems written as questions;
  - matching with fewer than 3 pairs;
  - a matching prompt reused as a match.
- Numerical questions only go to concepts the extractor marks as quantitative.
- Retries sample at a higher temperature.
- The second-pass review is now **on by default** for every engine, because a wrong answer key is something only a reviewer can catch.

**Model ranking:**
- **Qwen3.5 4B** stays the default.
- **MiniCPM5 2B** is the "fast" choice, and the only one that can fall back to the CPU.

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

**Status:** added as an option.

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

**Other models considered:**
- **Phi-4-mini 3.8B** (MIT, 2.2 GB) and **Ministral 3 3B** (Apache-2.0, 2.0 GB): both are in WebLLM and worth A/B testing against Qwen3.5-4B.
- **Llama 3.2 1B/3B:** community license.
- **Gemma 4 E2B/E4B** (now Apache-2.0): not in WebLLM yet.
- **LFM2.5-1.2B:** the license restricts commercial use above $10M revenue.
- **Phones:** iOS tabs are killed at roughly 1.5–3 GB, so phones are out of scope.

Rough speeds (estimates, not measured here): Qwen3.5-4B runs at about 15–25
tokens/s on a base M1/M2 and 5–12 on Intel Iris Xe. The 2B model is about twice as fast.

**Pitfalls handled in code:**
- **Thinking mode:** Qwen3.5 "thinks" by default, so the app passes `enable_thinking: false` and strips any `</think>` prefix.
- **JSON mode prompting:** the prompt must also ask for JSON, or the model can stall emitting whitespace.
- **Model download caching:** WebLLM keeps weights in the Cache API. The service worker never caches them. `navigator.storage.persist()` is requested before download.
- **Not handled yet:** WebLLM issues #807/#766 report an occasional XGrammar "invalid token id" abort with q4f16. Retrying usually works; switching to the q4f32 build is the fallback.

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
