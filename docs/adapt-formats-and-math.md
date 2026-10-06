# ADAPT's other import templates, and math questions

Researched 2026-10-05 against `LibreTexts/adapt` branch `master` (commit 24b0865).
This branch matches production's Bulk Import UI. `main` is stale (2023).

## Bulk Import templates in production

| Template | What you upload | Creates | Can this app produce it? |
|---|---|---|---|
| **Canvas QTI** | zip (see [adapt-qti-import.md](adapt-qti-import.md)) | native ADAPT QTI questions | **Yes, done** |
| **Flashcard** | 11-column CSV, one card per row | native `flashcard` questions | **Yes, easy (planned)** |
| **WeBWorK** | CSV with `File Path*` to a problem already on LibreTexts' WeBWorK store | WeBWorK questions | No, it cannot carry new PG code |
| **MyOpenMath** (form value `advanced`) | CSV of question IDs on `imathas.libretexts.org` | IMathAS / H5P / text questions | IDs only; no IMathAS source |
| **H5P** | comma-separated `studio.libretexts.org` node IDs | H5P questions | No; there is no API for creating Studio content |

### Flashcard CSV

Every column is required and must be in this exact order:

```
Title*,Front*,Front Text Language*,Back*,Back Text Language*,Hint,Tags,Folder*,Public*,Author*,License*
```

- **Languages:** `English`, `Spanish` or `French` only, case-sensitive.
- **Public:** `0` or `1`. A Folder that doesn't exist yet is created.
- **License:** one of `publicdomain, publicdomaindedication, ccby, ccbynd, ccbync, ccbyncnd, ccbyncsa, ccbysa, gnu, arr, gnufdl, imathascomm, ck12foundation, ncbsn`.
- **File:** UTF-8, with exactly as many fields as the header on every row. The server's MIME allow-list omits `text/csv`, which is worth testing live.
- **Format:** text and TeX only. The viewer escapes HTML and runs MathJax. There is no deck column; a deck is an assignment with `assessment_type=flashcard`.
- **Duplicates:** ADAPT reuses any existing flashcard with the same front and back, from any user.
- **Example:** [examples/flashcards.csv](examples/flashcards.csv).

### Canvas QTI changes since the local `adapt` checkout

- **Images:** multiple-choice and true/false *choices* and essay HTML now also pass through `sendImgsToS3`. An absolute or `data:` image URL there will probably fail the import. This app emits no images.
- **MathJax:** production runs MathJax 3 with `$…$` as inline math. The exporter wraps every literal `$` in `<span class="tex2jax_ignore">`.
- **Nested sections:** only the first nested section is imported. The exporter puts every item directly in the root section.
- **Calculated questions:** `calculated_question` is still rejected.

## Math questions

ADAPT has no formula or expression type of its own. The options:

| Option | Randomized | Formula answers | Units | Path into ADAPT |
|---|---|---|---|---|
| QTI `numerical_question` (value ± margin) | no | no | no | Canvas QTI bulk import, **works today** |
| Several numerical variants of one item | yes, via ADAPT's "randomizations" (N of M per student) | no | no | Canvas QTI: one quiz per family, then turn on randomization in the assignment |
| **WeBWorK PG/PGML** | yes | yes (MathObjects) | yes | Question Editor → WeBWorK → paste code, or `POST /api/questions` with `new_auto_graded_code=webwork` and `webwork_code` (needs a JWT from `/api/login`) |
| IMathAS code | yes | yes | partly | Author on imathas.libretexts.org, then MyOpenMath CSV by ID; several manual steps |
| Canvas `calculated_question` / H5P | — | — | — | not viable |

### Recommended design (not built yet)

1. **The model returns a constrained spec, never code:** variables with min, max and step, constraints, a prompt template, an answer expression, and a tolerance. This is assessment-ai's `ParameterizedItemSpec`, plus a small whitelist of functions.
2. **Parse once:** a hand-written parser (no `eval`) turns the answer expression into a syntax tree. JS evaluation, PG and TeX are all generated from that one tree.
3. **Validate in the browser** over about 25 seeded samples. Reject NaN or infinite answers, division by zero, answers that never change, duplicate variants, and tolerance above 5% of the answer.
4. **Export:**
   - **QTI numerical variants** for ADAPT bulk import (the default).
   - **`.pg` (PGML) files** with a "copy code" button for pasting into ADAPT's WeBWorK editor. Formula and unit answers need this.
   - **Optional:** publish through the ADAPT API with the user's own JWT (CORS is open).
5. **Engine check during development:** `staging-render.libretexts.org/render-api` accepts raw PG source from any origin. The production renderer needs a JWT.

**Tested PGML examples** (rendered and graded on staging-render):
- [examples/deriv.pg](examples/deriv.pg): a randomized polynomial with a formula answer and a numeric answer.
- [examples/units.pg](examples/units.pg): an answer in m/s with a 1% relative tolerance. It accepts `90 m/s` and `324 km/h` and rejects a bare `90`.

### How assessment-ai did it

- **Validation and compilation:** `assessment-ai/app/parameterized.py` validates the spec over 25 seeds and compiles it to plain PG (`Real(...)->cmp(tol=>T)`) or IMathAS. Publishing goes through `adapt.py` (WeBWorK, inline code) and a bridge that writes straight into IMathAS's database.
- **Portable to the browser:** the schema, the expression evaluator, seeded sampling, and the PG/IMathAS string emitters.
- **Needs a server:** real engine rendering, IMathAS question creation, and authenticated ADAPT posts.
