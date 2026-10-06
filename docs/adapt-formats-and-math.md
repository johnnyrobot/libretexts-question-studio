# ADAPT's other import templates, and math questions

Researched 2026-10-05 against `LibreTexts/adapt` branch `master` (commit 24b0865).
This branch matches production's Bulk Import UI. `main` is stale (2023).

**Decision (2026-10-05): the app produces Canvas QTI only.** The other templates
and the PGML route below are kept as research; none of them is planned.

## Bulk Import templates in production

| Template | What you upload | Creates | Can this app produce it? |
|---|---|---|---|
| **Canvas QTI** | zip (see [adapt-qti-import.md](adapt-qti-import.md)) | native ADAPT QTI questions | **Yes, done** |
| **Flashcard** | 11-column CSV, one card per row | native `flashcard` questions | Could, but out of scope (QTI only) |
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
| Several numerical variants of one item | yes, via ADAPT's "randomizations" (N of M per student) | no | no | Canvas QTI: one quiz per family, then turn on randomization in the assignment. **This is what the app does.** |
| **WeBWorK PG/PGML** | yes | yes (MathObjects) | yes | Question Editor → WeBWorK → paste code, or `POST /api/questions` with `new_auto_graded_code=webwork` and `webwork_code` (needs a JWT from `/api/login`) |
| IMathAS code | yes | yes | partly | Author on imathas.libretexts.org, then MyOpenMath CSV by ID; several manual steps |
| Canvas `calculated_question` / H5P | — | — | — | not viable |

### What the app builds (QTI only)

The math question type (`math`, "Math (randomized numbers)") lives in
`src/lib/math/`.

1. **The model returns a template, never code or a final number:**
   - `variables`: one to six, each with min, max and step.
   - `constraints`: comparisons such as `a < b` that every version must meet.
   - `answer_formula`, `tolerance_percent` (0, or 0.1 to 5) and `units`.
   - `stem` and `explanation` mark values as `{{name}}` or `{{expression}}`. Single braces are left alone, so TeX like `\frac{a}{b}` still works. The explanation may also use `{{answer}}`.
2. **Parse once:** `expr.ts` is a hand-written parser (no `eval`). It allows `+ - * / ^`, parentheses, `sqrt abs exp ln log10`, trig in radians, `sind cosd tand` in degrees, `floor ceil round min max`, and the constants `pi` and `e`. The same syntax tree is evaluated in JS and turned into the TeX formula shown to instructors.
3. **Validate in the browser** (`spec.ts`) over at least 25 seeded samples. A spec is rejected when:
   - an answer is NaN, infinite, zero, or above 10^15;
   - the answer never changes;
   - the stem leaves out a variable, or shows `{{answer}}` or an expression that always equals it;
   - the constraints are almost never met, or there are fewer distinct versions than needed;
   - a margin rounds below ADAPT's 0.00001;
   - the answer is not exact (four decimals or fewer) when the tolerance is 0.

   Errors name the failing values, such as "when t=0", and go back to the model, which gets up to 3 attempts. The editor runs the same check as you type.
4. **Versions are deterministic** (mulberry32, seeds 1, 2, 3, ...), so re-exports are byte-identical. Variables print exactly, and computed placeholders print to four significant figures. Answers with a tolerance are rounded to six significant figures for the answer key.
5. **Export:**
   - **Fixed (default):** version 1 goes into the main quiz as a `numerical_question`.
   - **Randomized:** a second zip has one quiz per math question, holding 2 to 10 versions titled "(version n)". ADAPT creates one assignment per quiz. Import it into a course with an assignment template whose Dynamic Questioning settings are **Random sampling**: Yes and **Number of randomized assessments**: 1. Points Per Question has to be "Specify the points for each question individually", which is the default. (The local `../adapt` checkout calls these "Randomizations" and "Specify number of points".) Version 1 keeps the question's own identifier; later versions hash `<uuid>:v<n>`.
6. **Exact answer keys:** ADAPT stores a numerical answer as `(low + high) / 2` in doubles, so a plain decimal range can turn 0.346154 into 0.34615399999999996. `numericRange` (in `qti/canvas.ts`) detects this. It then writes the bounds as two doubles whose sum is exactly twice the answer, printed so PHP reads back the same doubles. This applies to the numerical type too.

Both zips were checked with ADAPT's PHP parser (`tests/adapt-parser`). The
sample package (version 1 of a math question among the other eight types) was
imported live into adapt.libretexts.org on 2026-10-05; see
[adapt-qti-import.md](adapt-qti-import.md#live-import-check). The randomized zip
was imported live the same day, into a hidden test course with such a template.
ADAPT created one assignment per math question. Each one listed "Number of
Questions 5" and "Number of Randomized Questions Chosen 1", and the 10 versions
imported with no errors.

**PGML examples from the research** (rendered and graded on staging-render; not used by the app):
- [examples/deriv.pg](examples/deriv.pg): a randomized polynomial with a formula answer and a numeric answer.
- [examples/units.pg](examples/units.pg): an answer in m/s with a 1% relative tolerance. It accepts `90 m/s` and `324 km/h` and rejects a bare `90`.

### How assessment-ai did it

- **Validation and compilation:** `assessment-ai/app/parameterized.py` validates the spec over 25 seeds and compiles it to plain PG (`Real(...)->cmp(tol=>T)`) or IMathAS. Publishing goes through `adapt.py` (WeBWorK, inline code) and a bridge that writes straight into IMathAS's database.
- **Portable to the browser:** the schema, the expression evaluator, seeded sampling, and the PG/IMathAS string emitters.
- **Needs a server:** real engine rendering, IMathAS question creation, and authenticated ADAPT posts.
