# Question Studio (assessment-ai-standalone)

This file adds to the workspace `../CLAUDE.md`. That file covers the issue tracker (`../docs/agents/issue-tracker.md`) and the code review gate (`../docs/agents/code-review.md`). This repo's tickets go in LT project **Question Studio**, labelled `assessment-ai-standalone`.

Question Studio is a browser-only PWA (Vite, React, TypeScript). It turns LibreTexts pages into reviewed question banks and exports Canvas-style QTI 1.2 for ADAPT's Bulk Import. There is no server and no login: each user's sources, sets, questions and settings live in their own browser's IndexedDB (Dexie, `src/lib/storage/db.ts`). README.md is the reference for features, layout and limits.

## Checks

- **Every change:** `npm run lint`, `npm test` and `npm run build`. CI (`.github/workflows/ci.yml`, Node 22) runs the same three. Only the build type-checks (`tsc -b`).
- **QTI export, question-type or math changes:** also run `npm run verify:adapt`.
  - It runs ADAPT's own PHP importer on exported packages. It needs the `../adapt` checkout and `PHP_WASM_DIR`; README.md, Development, has the setup.
  - CI can't run it.
  - In a worktree outside the workspace, set `ADAPT_APP` to the absolute path of `../adapt/app`.

## Before changing behaviour

- **Export, question types or math:** read `docs/adapt-qti-import.md` first. It covers ADAPT's import contract and the parser quirks the exporter works around. Also read `docs/adapt-formats-and-math.md`.
- **Stored data:** old rows and old backup files (`src/lib/storage/backup.ts`, format version 1) sit in users' browsers, with no migration. When a stored shape changes, keep reading the old shape, or add a Dexie version with an upgrade.
- **Scripts:** the app ships only its own code. Any script on this origin could read the remembered OpenAI key (`src/lib/storage/secrets.ts`).

## Supported environments

A change has to work in all of these:

- **Browsers:** recent desktop Chrome, Edge and Safari 26, and Firefox on Windows and Apple Silicon (README.md, Known limits). Phones are out of scope.
- **Origins:** https (the deployed site) and `http://localhost` (`npm run dev`). The service worker and WebGPU need a secure origin.
- **Engines:**
  - Gemma 4 E4B through Transformers.js, and Qwen3.5 4B through WebLLM, both on WebGPU.
  - OpenAI with the user's own key.
  - Tests stand in a scripted model for all of them. The real models are multi-gigabyte downloads.

## What gets committed

- Commit app code, tests and docs only.
- `experiments/` holds research and working notes, and is git-ignored on purpose.
- Test fixtures use fake keys.
- `../assessment-ai` is the older server version: use it for reference only.
