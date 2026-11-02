# qwen35-9b-ftds-q4f16_1-v1 (ft-ds)

Written 2026-11-02 (LT-237). This file is committed with the app
(`models/qwen35-9b-ftds-q4f16_1-v1/MODEL.md`) and served beside the weights.

This is the default in-browser model of LibreTexts Question Studio
(https://qtistudio.libretexts.dev). It is Qwen3.5 9B with a LoRA fine-tune
merged into its weights, then compiled with MLC to q4f16_1 for WebLLM.
It writes assessment questions from LibreTexts textbook pages.

Served from: https://qtistudio.libretexts.dev/models/qwen35-9b-ftds-q4f16_1-v1/

## Base model

- Repository: `Qwen/Qwen3.5-9B` (Hugging Face).
- Revision: `c202236235762e1c871ad0ccb60c8ee5ba337b9a`. All 15 files were
  downloaded at this commit (the `.cache/huggingface/download/*.metadata`
  files in the local download). On 2026-11-02 this is still the head of `main`.
- Licence: Apache License 2.0. The LICENSE file at that revision is
  byte-identical to the one copied into the merged model.
- The base repo has no NOTICE file.

## Licence of this model

This model is a Derivative Work of Qwen3.5-9B and is distributed under the
Apache License 2.0. A copy of the licence sits beside the weights.

Changes from the base model: the language model's weights were changed by
merging a LoRA adapter (see "Fine-tune"), the weights were quantized to
q4f16_1 (4-bit), and the vision tower and the multi-token-prediction head were
left out of the MLC build. The tokenizer files are unchanged.

"Qwen" is a name of Alibaba Cloud. Its use here only describes where the
model came from.

Copyright notice in the base LICENSE file: "Copyright 2026 Alibaba Cloud".

## How it was made

1. A DeepSeek model (the teacher) wrote practice questions from LibreTexts
   pages, with Question Studio's own prompts and schemas.
2. The app's own checks ran on every question. A second model (GLM-5.3) tried
   to answer each question blind. Questions it disagreed with were dropped.
3. The kept questions became chat examples: Question Studio's prompt in, the
   teacher's question (JSON) out.
4. A LoRA was trained on Qwen3.5 9B with those examples (bf16, Colab).
5. The LoRA was merged into the base weights (`merge_lora.py`, strength 1.0).
6. The merged model was converted with `mlc_llm convert_weight` to q4f16_1.
7. The result runs on the official WebLLM model library for stock
   Qwen3.5 9B; no custom WebGPU code was compiled.

## Training data

- Examples: 3,040 (`sft-ds-flash-think.jsonl`), from 260 LibreTexts books.
  2,955 were trained on; 85 examples from 8 whole books were held out to pick
  the checkpoint.
- Books by subject area (count of books): humanities 40, social sciences 38,
  medicine 33, workforce 33, mathematics 25, engineering 22, business 20,
  biology 17, chemistry 14, statistics 7, physics 6, geosciences 5.
- Question types: multiple choice 591, true/false 564, matching 519, multiple
  answers 516, dropdowns 387, fill in the blank 235, numerical 116, math 112.
  No type was allowed above 25% of the set.
- Pages used: only pages licensed CC BY or public domain (an untagged page
  takes its book's licence). Pages that share more than 5% of their 8-word
  shingles with an evaluation or development page were dropped.
- Tokens: 4,004,488 prompt tokens (not trained on), 820,952 completion
  tokens (trained on).
- Teacher: `deepseek-flash` on DeepSeek's own API
  (`https://api.deepseek.com/chat/completions`), thinking on. The project's
  score files call it "DeepSeek V4.1 Flash". 3,346 of 3,749 logged calls
  report reasoning tokens. Only the final answer text was kept; the thinking
  text was not stored or trained on. Drafts written 2026-10-30.
- Concepts for each question slot: also `deepseek-flash` on DeepSeek's API,
  thinking off (`t3-slots.json`).
- Checker (filter only): `z-ai/glm-5.3`, thinking on, through OpenRouter.
  Its verdict decided whether a question was kept. None of its text is in the
  training data. 112 math questions have no blind check; 2,928 examples were
  agreed by the checker.
- No Claude or OpenAI output is in the training data. The training targets
  are DeepSeek's answers after the app's deterministic clean-up (removing
  source references, shuffling choices). The prompts are Question Studio's
  prompt templates, the LibreTexts page text, the DeepSeek-written concept,
  and a list of the book's previous DeepSeek-written stems. Prompt tokens are
  masked out of the loss. (See the note on the prompt templates under
  "Open points".)

## Fine-tune

| Setting | Value |
|---|---|
| Method | LoRA (PEFT 0.21.2), no DoRA, no rsLoRA |
| Rank / alpha / dropout | 16 / 32 / 0.0 |
| Target modules | text model only: full-attention q/k/v/o, linear-attention in_proj_qkv, in_proj_z, out_proj, MLP gate/up/down, in every layer; not the vision tower, not the MTP head (200 modules merged) |
| Learning rate | 1e-4, cosine, warm-up 3% of steps, no weight decay |
| Batch | 2 per device x 8 accumulation = 16 |
| Max sequence length | 8,192 tokens |
| Epochs / steps | 2 epochs, 370 steps (185 per epoch) |
| Loss | completion tokens only |
| Checkpoint kept | step 370 (lowest held-out loss, 0.3851) |
| Final training loss | 0.3501 |
| Training time | 4,302 s |
| Precision | bf16 |

The exact command line run on Colab is not recorded; the values above are the
script defaults and match the saved adapter config, step count and learning
rate log.

## MLC build

| Setting | Value |
|---|---|
| Quantization | q4f16_1 (group size 32, int4, fp16 scales; embedding and final layer quantized) |
| Model type | qwen3_5 |
| Context window in the config | 262,144 (taken from max_position_embeddings) |
| Context window the app uses | 8,192 (set at load time) |
| Prefill chunk size | 2,048 |
| Conversation template | `qwen2` |
| Model library (wasm) | official `Qwen3.5-9B-q4f16_1_cs1k-webgpu.wasm`, WebLLM v0_2_84 |
| Tools | mlc-llm-nightly-cpu 0.26.dev6, mlc-ai-nightly-cpu 0.26.dev246, on macOS CPU |
| Parameters | 9,653,104,368; 4.175 bits per parameter |
| Weight shards | 127 files, 5,038,040,064 bytes |
| Folder total | 5,058,089,106 bytes (5.06 GB) |

`mlc-chat-config.json` is identical to the one in
`mlc-ai/Qwen3.5-9B-q4f16_1-MLC`. A stock Qwen3.5 9B converted with the same
tools matched that official build in every tensor name, shape, dtype and
shard offset.

## Measured quality

Fresh pool: 104 question slots from 13 books not used in training. All arms
ran in desktop Chrome on Apple Silicon at app commit 3d60c4e and went through
the app's own review and key check. The comparison arm is the default until then,
Gemma 4 E4B (`onnx-community/gemma-4-E4B-it-ONNX:q4f16`). Rates are per judged
question: 103 for ft-ds, 99 for E4B.

| | ft-ds | Gemma 4 E4B |
|---|---|---|
| Usable, DeepSeek judge (DeepSeek V4 Pro, DeepSeek API) | 79% | 65% |
| Usable, Claude judge (blind pool) | 62% | 51% |
| Wrong answer key, DeepSeek judge | 8% | 9% |
| Wrong answer key, Claude judge | 5% | 9% |

Paired test against E4B on usable: p = 0.02 (DeepSeek judge), p = 0.053
(Claude judge).

Ship gate (2026-11-02, quiet Mac, Chrome): 104 of 104 drafts and checks
finished, 0 GPU losses. Median 58.9 s per question against a 75.4 s limit
(2x E4B's 37.7 s).

Size: 5.06 GB.

Memory (macOS `footprint` of the test Chrome's processes, sampled every
5 s, 64 GB Apple Silicon Mac, 2026-11-02):

- First load: the GPU process holds 7.6 GB once the model is loaded; the
  whole browser peaked at 11.2 GB during the load.
- In use, before LT-242: the GPU process grew with every long prompt and
  came back only when the page was reloaded: 7.6 to 12.7 GB over one
  6-question set in the app. The page's JavaScript heap stayed flat (about
  32 MB); the growth was WebGPU buffers. The ship gate's one 32.9 GB
  sample was this growth after 76 minutes in one tab. The cause was a leak in
  WebLLM 0.2.85: it kept the logits of every 1,024-token prefill chunk but
  the last, 121 MB each on this model. The app now applies WebLLM 0.2.86's
  fix to 0.2.85 when it is installed and built (LT-242).

30 minutes of continuous drafting in one tab (LT-242, 2026-11-02, quiet Mac,
Chrome, synthetic passages of 300 to 3,000 words, 500 to 3,950 prompt tokens,
cycled; drafts only, no duplicate check). GPU process, after the first
question, then every 10 minutes:

| | Questions | Start | 10 min | 20 min | 30 min | Peak, whole browser | After unload |
|---|---|---|---|---|---|---|---|
| This model, before the fix | 130 | 7.3 GB | 13.7 GB | 19.8 GB | 26.4 GB | 27.5 GB | 0.15 GB |
| This model, after the fix | 133 | 7.3 GB | 7.3 GB | 7.4 GB | 7.4 GB | 8.4 GB | 0.15 GB |
| Gemma 4 E4B (no change) | 88 | 7.4 GB | 9.7 GB | 9.6 GB | 9.7 GB | 24.2 GB | 2.4 GB |

Before the fix the GPU process grew about 0.6 GB a minute. After it, it
stayed between 7.33 and 7.36 GB for the whole 30 minutes.

Gemma 4 E4B (Transformers.js 4.3.1, ONNX Runtime Web 1.31 on WebGPU) does not
leak: the WebGPU buffers it holds rise and fall with prompt length (6.3 to
7.1 GB) and the GPU process levels off near 9.7 GB, ONNX Runtime keeping freed
buffers for reuse. With the worker's 3.2 to 3.4 GB of WebAssembly memory the
whole browser sits at about 12.9 GB while it writes (the median over a
6-question set, with 99% of samples above 12 GB), and for a few seconds in
some long prompts the GPU process reaches about 20 GB. ONNX Runtime's other
buffer cache modes did not help: `lazyRelease` left the whole browser at
12.7 GB (90th percentile 19.5 GB), and `disabled` made the GPU stop
responding on every question. Unloading between sets can't lower a peak
inside one, so E4B's memory is not bounded (LT-242).

The judges are other AI models. These numbers say how this model compares
with E4B on this pool; they do not promise that a given question is right.
Every question still needs a teacher's review.

## Intended use

Drafting questions from LibreTexts pages inside Question Studio, for an
instructor to review. Not for other uses; not tested on phones.

## Files

SHA256SUMS lists all 135 files served for this build with their sha256:

- the 133 files of the MLC build (`mlc-chat-config.json`, `tensor-cache.json`,
  `tensor-cache-b16.json`, the tokenizer files and 127 weight shards);
- `Qwen3.5-9B-q4f16_1_cs1k-webgpu.wasm`, WebLLM's official model library,
  unchanged, from
  https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen3.5-9B-q4f16_1_cs1k-webgpu.wasm
  (Apache-2.0, 6,528,086 bytes), served here so the whole model comes from one
  place under one fixed path;
- `LICENSE`, the base model's Apache License 2.0.

The app also pins `mlc-chat-config.json`, `tokenizer.json` and the wasm by
hash (WebLLM integrity), so a changed file stops the load. This folder never
changes: a new build gets a new folder.

## Third-party terms

### Qwen3.5-9B: Apache License 2.0

Source: https://huggingface.co/Qwen/Qwen3.5-9B/blob/c202236235762e1c871ad0ccb60c8ee5ba337b9a/LICENSE
(retrieved 2026-11-02). Model card front matter:
https://huggingface.co/Qwen/Qwen3.5-9B (`license: apache-2.0`).

> 4. Redistribution. You may reproduce and distribute copies of the
> Work or Derivative Works thereof in any medium, with or without
> modifications, and in Source or Object form, provided that You
> meet the following conditions:
>
> (a) You must give any other recipients of the Work or
> Derivative Works a copy of this License; and
>
> (b) You must cause any modified files to carry prominent notices
> stating that You changed the files; and
>
> (c) You must retain, in the Source form of any Derivative Works
> that You distribute, all copyright, patent, trademark, and
> attribution notices from the Source form of the Work,
> excluding those notices that do not pertain to any part of
> the Derivative Works; and
>
> (d) If the Work includes a "NOTICE" text file as part of its
> distribution, then any Derivative Works that You distribute must
> include a readable copy of the attribution notices contained
> within such NOTICE file, [...]

> You may add Your own copyright statement to Your modifications and
> may provide additional or different license terms and conditions
> for use, reproduction, or distribution of Your modifications, or
> for any such Derivative Works as a whole, provided Your use,
> reproduction, and distribution of the Work otherwise complies with
> the conditions stated in this License.

> 6. Trademarks. This License does not grant permission to use the trade
> names, trademarks, service marks, or product names of the Licensor,
> except as required for reasonable and customary use in describing the
> origin of the Work and reproducing the content of the NOTICE file.

### DeepSeek Open Platform Terms of Service (teacher outputs)

Source: https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html
(retrieved 2026-11-02; "Release date: April 22, 2026", "Effective date: April 29, 2026").

> 4.2 Subject to your compliance to applicable law and our Terms, you have
> the following rights regarding the Inputs and Outputs of the Services:
> (1) You retain any rights, title, and interests—if any—in the Inputs you
> submit; (2) We assign any rights, title, and interests—if any—in the
> Outputs of the Services to you; (3) You may apply the Inputs and Outputs
> of the Services to a wide range of use cases, including personal use,
> academic research, derivative product development, training other models
> (such as model distillation), etc.

> 4.1 You are responsible for all Inputs you submit to our Services and
> corresponding Outputs.

> 5.2 Without our permission, you or your end users shall not use any
> trademarks, service marks, trade names, domain names, website names,
> company logos (LOGOs), URLs, or other prominent brand features related
> to the Services, including but not limited to "DeepSeek," etc., in any
> [...]

> You shall clearly disclose to your end users that the Output
> content is generated by AI, and may contain errors or omissions and
> are for reference only.

(8.1, "AI Generated content")

The teacher's open weights are MIT-licensed:
https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017 (`license: mit`,
"This repository and the model weights are licensed under the [MIT License](LICENSE).",
retrieved 2026-11-02). The teacher was called through DeepSeek's API, so the
Open Platform terms above are the ones that applied.

## Open points

- Which exact DeepSeek model version answered `deepseek-flash` on 2026-10-30
  is not recorded. DeepSeek's API docs on 2026-11-02 say "Use deepseek-flash
  as the model name. It is now served by DeepSeek-V4.1-Flash-1017"
  (https://api-docs.deepseek.com/).
- The training prompts contain Question Studio's prompt templates
  (`src/lib/generation/prompts.ts`). Who or what wrote that template text is
  not recorded in these files. It is part of the input only and is masked from
  the loss.
- `mlc-chat-config.json` lists `stop_token_ids` 151643 and 151645, which are
  not Qwen3.5's ids (`<|endoftext|>` 248044, `<|im_end|>` 248046). It also
  lists `merges.txt`, which is not in the folder. Both match the official
  mlc-ai build; generation stops on the `stop_str` strings.
- Colab hardware for training is not recorded in the build files.
