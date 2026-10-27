# Question Studio (assessment-ai-standalone)

This file adds to the workspace `CLAUDE.md`. The workspace is `/Users/libretexts/code/libretexts-dev`, and `../` below means that folder; a worktree checked out elsewhere has no such paths, so use the absolute ones. Read the workspace file first: it points at the issue tracker (`../docs/agents/issue-tracker.md`) and the code review gate (`../docs/agents/code-review.md`). This repo's tickets go in LT project **Question Studio**, labelled `assessment-ai-standalone`.

Question Studio is a browser-only PWA (Vite, React, TypeScript). It turns LibreTexts pages into reviewed question banks and exports Canvas-style QTI 1.2 for ADAPT's Bulk Import. There is no server and no login: each user's sources, sets, questions and settings live in their own browser's IndexedDB (Dexie, `src/lib/storage/db.ts`). README.md is the reference for features, layout and limits.

## Checks

- **Every change:** `npm run lint`, `npm test` and `npm run build`. CI (`.github/workflows/ci.yml`) runs the same three. Only the build type-checks (`tsc -b`).
- **QTI export, question types or math:** also run `npm run verify:adapt`.
  - It re-runs the QTI tests, then ADAPT's own PHP importer (`tests/adapt-parser`) on the exported packages. It needs the `../adapt` checkout and `PHP_WASM_DIR`; README.md, Development, has the setup.
  - CI doesn't run it.
  - In a worktree outside the workspace, set `ADAPT_APP` to `/Users/libretexts/code/libretexts-dev/adapt/app`.
- **Update or caching changes:** the service worker runs only in a build, so check them with `npm run build && npm run preview`.

## Before changing behaviour

- **QTI export, question types or math:** first read `docs/adapt-qti-import.md`, ADAPT's import contract and the parser quirks the exporter works around. Also read `docs/adapt-formats-and-math.md`, ADAPT's other import templates and how math questions map onto them.
- **Stored data:** old rows sit in users' browsers, and old backup files on their disks. When a stored shape changes, keep reading the old shape, or add a Dexie version with an upgrade. A backup skips that upgrade: `restoreBackup` (`src/lib/storage/backup.ts`) re-checks each question's draft against the current schema but writes every other row as it is, so it has to convert old shapes too.
- **Third-party scripts:** add none (no analytics, tag managers or widgets). Any script on this origin could read the remembered OpenAI key (`src/lib/storage/secrets.ts`).

## Supported environments

A change has to work wherever README.md says the app works:

- **Origins:** https (the deployed site) and `http://localhost` (`npm run dev`). WebGPU needs a secure origin.
- **Engines:**
  - In the browser, on WebGPU: Gemma 4 E4B through Transformers.js (the default), Qwen3.5 4B through WebLLM, and EmbeddingGemma 2 through Transformers.js for the duplicate check.
  - OpenAI with the user's own key.
  - Tests use scripted stand-ins for all of them (`FakeProvider`, `fakeEmbedder`). The real models are multi-gigabyte downloads.
- **Browsers:** the in-browser models need recent desktop Chrome or Edge, Safari 26, or Firefox on Windows or Apple Silicon (README.md, Known limits). Gemma 4 E4B has been tested only in desktop Chrome on Apple Silicon; Qwen3.5 4B is the fallback. Phones are out of scope.

## What gets committed

- Never commit a secret; test fixtures use fake keys.
- Put research and working notes in `experiments/`, which is git-ignored on purpose.
- `../assessment-ai` is the older server version: use it for reference only.
