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
   - `worked_example`, just before `answer_formula`: values for every variable, the calculation written out with them, and the hand-computed answer. It is checked and then dropped, so it is never saved. The values are a list of `{name, value}` because OpenAI's strict mode does not accept records.
   - `stem` and `explanation` mark values as `{{name}}` or `{{expression}}`. Single braces are left alone, so TeX like `\frac{a}{b}` still works. The explanation may also use `{{answer}}`.
2. **Parse once:** `expr.ts` is a hand-written parser (no `eval`). It allows `+ - * / ^`, parentheses, `sqrt abs exp ln log10`, trig in radians, `sind cosd tand` in degrees, `floor ceil round min max`, and the constants `pi` and `e`. The same syntax tree is evaluated in JS and turned into the TeX formula shown to instructors.
3. **Validate in the browser** (`spec.ts`) over at least 25 seeded samples. A spec is rejected when:
   - an answer is NaN, infinite, zero, or above 10^15;
   - the answer never changes;
   - a variable is not used in the answer formula (models like to make the unknown a variable);
   - the stem leaves out a variable, or shows `{{answer}}` or an expression that always equals it;
   - the constraints are almost never met, or there are fewer distinct versions than needed;
   - a margin rounds below ADAPT's 0.00001;
   - the answer is not exact (four decimals or fewer) when the tolerance is 0.

   Errors name the failing values, such as "when t=0", and go back to the model, which gets up to 3 attempts. The editor runs the same check as you type.

   Model drafts must also pass the **worked-example check** (`checkWorkedExample`). The formula, evaluated on the example's values, must be within 5% of the model's own answer. This catches a formula that says something other than the model meant, which passes every other check. Qwen3.5 4B wrote `xf - x0 / t` for `(xf - x0) / t`, giving 1919.77 instead of 16.75 in one version. The error names both numbers and points at parentheses and operators.

   Common model slips are repaired instead of retried:
   - `{{name}}` placeholders copied into a formula are read as the variable. Uneven braces, such as `( {{xf} - {{x0}} } / {{t}} )` or `( {xf} - {x0} ) / {t}`, are read as parentheses when they balance, which keeps the model's grouping. Otherwise braces around a bare name are dropped, then any left over (`repairFormula`).
   - Tolerance 0 on answers that aren't exact becomes 1%.
   - Step 0 becomes the largest round step (1, 0.5, 0.1, ...) that both ends are multiples of and that still gives ten or more values. Qwen3.5 4B writes step 0 for ranges that start at a fraction, such as a time of 0.5 to 3 s.

   The tolerance and step repairs apply to model output only; the editor still reports those errors.

   A response cut off at the in-browser model's 1,800-token limit is retried at a higher temperature instead of failing the item. A math item needs about 400 tokens, so a cut-off response is a runaway generation.
4. **Versions are deterministic** (mulberry32, seeds 1, 2, 3, ...), so re-exports are byte-identical. Variables print exactly, and computed placeholders print to four significant figures. Answers with a tolerance are rounded to six significant figures for the answer key.
5. **Export:**
   - **Fixed (default):** version 1 goes into the main quiz as a `numerical_question`.
   - **Randomized:** a second zip has one quiz per math question, holding 2 to 10 versions titled "(version n)". ADAPT creates one assignment per quiz. Import it into a course with an assignment template whose Dynamic Questioning settings are **Random sampling**: Yes and **Number of randomized assessments**: 1. Points Per Question has to be "Specify the points for each question individually", which is the default. (The local `../adapt` checkout calls these "Randomizations" and "Specify number of points".) Item identifiers start with the item's position (`q001_…`, since ADAPT imports in identifier order); after it, version 1 keeps the question's own id and later versions hash `<uuid>:v<n>`.
6. **Exact answer keys:** ADAPT stores a numerical answer as `(low + high) / 2` in doubles, so a plain decimal range can turn 0.346154 into 0.34615399999999996. `numericRange` (in `qti/canvas.ts`) detects this. It then writes the bounds as two doubles whose sum is exactly twice the answer, printed so PHP reads back the same doubles. This applies to the numerical type too.

**Real-model test (Qwen3.5 4B, 2026-10-05).** Source: OpenStax College Physics 2.3 and 2.5, 6 math questions requested, review on.

| Run | Math questions | Multiple-choice fallbacks | Failed |
|---|---|---|---|
| Before the repairs | 2, 1 usable | 1 | 3 |
| After the repairs | 3, all usable | 3 | 0 |
| 2026-10-06: worked example, no review, extractor hint | 6, all correct (4 m 38 s) | 0 | 0 |

The fallbacks were sections whose concepts the extractor did not mark as quantitative.

**Math-only fallbacks (decision 2026-10-06): look for numbers elsewhere on the page.**
- **Extractor hint:** the concept prompt says how many of the section's questions are calculations and asks for the quantitative relationships first.
- **Borrowing:** a math or numerical question whose section has none takes the least-used quantitative concept from the nearest other section of the same page. That includes sections that got no questions of their own; they are extracted only while no unused concept has been found.
- **Fallback:** another type is written only when the whole page has no quantitative concept.

Hint measurements (Qwen3.5 4B, two runs per section, 5 sections of 2.3 and 2.5):

| Text | Without hint | With hint |
|---|---|---|
| Physics sections | 8 of 12 concepts quantitative; 2 of 10 runs had none | 12 of 12; every run had one |
| Physics paragraphs with no digits | 0 of 6 | 2 of 6 (definitions that are formulas in words) |
| A Renaissance history passage | 0 of 6 | 0 of 6 |

In the end-to-end run the hint alone was enough; no question had to borrow. Borrowing is covered by a unit test.

**Worked-example check (2026-10-06).** Qwen3.5 4B drafts of the same six quantitative concepts, two per concept, with the step and brace repairs added between the second and third rows:

| Prompt | Questions | Model calls | Wrong formula | Rejected by the example check |
|---|---|---|---|---|
| Without worked example | 9 of 12 | 22 | 0 | — |
| With worked example | 8 of 12 | 22 | 0 | 0 |
| With worked example and the repairs | 12 of 12 | 17 | 1 | 0 |

- **Cost:** about 5 s more per question (roughly 60 tokens).
- **No false rejections:** every hand calculation that reached the check matched its formula, including 50 + (10 + (10 + 2·4))/2·4 = 106.
- **It caught nothing in these runs.** The formula errors seen earlier came from the reviewer, which can no longer change a formula.
- **Limit: it cannot catch a formula that is wrong in substance.** The one wrong formula, `d / v / t + b` for a stopping distance, came after the app rejected an unused variable `d`. The model forced `d` into the formula, and its "hand" example simply evaluated that formula.
- **Copying:** when the variables are called d and t, the model often copies the prompt's example values (100 km, 4 h). The check is still valid, because it evaluates the model's own formula on those values.
- **Why the yield rose:** before the repair, step 0 sank 19 of 44 attempts. Afterwards it was repaired in 6 of 16 attempts.

**Capitalised variable names (Gemma 4 E4B, 2026-10-06).** Gemma names
variables the way physics writes them (`F_net`, `F_foot`). The Transformers.js
grammar cannot carry the name pattern, and the model kept the capitals on every
retry: in the end-to-end test a math question failed all three tries on
`F_net`. `repairDraft` now lowercases a declared name that is valid in lowercase,
and every use of it: the formula, the constraints, the `{{ }}` placeholders and
the worked example. A use that differs from a declared name only in case is
lowercased too. TeX outside the placeholders is left alone, and names that would
collide (`M` and `m`) or become reserved (`E`) are left for the error message.
Ten math drafts of the four quantitative concepts in College Physics 4.3 and 4.4:

| | Questions | Model calls | Attempts with capitals | Rejected for capitals | Time |
|---|---|---|---|---|---|
| Before | 6 of 10 | 22 | 5 | 5 | 478 s |
| The same 22 attempts, re-checked with the repair | 8 of 10 | — | 5 | 0 (3 now pass, 2 fail for other reasons) | — |
| After (new run) | 9 of 10 | 18 | 4 | 0 | 388 s |

The other rejections across both runs (40 attempts) were a name used but not
declared, such as `m*a` with only `m` or an explanation's `{{w}}` (14), a
constant such as g = 9.8 declared with min equal to max (4), and a stem missing
a placeholder (2). None of these is repaired; the first two now get clearer
messages (see below).

**Starting over automatically (2026-10-07).** A question whose three attempts
all fail now starts over in a new conversation, up to twice more, and is then
left out without a notice. A full run, Gemma 4 E4B, math only, 5 per page on
College Physics 4.3 and 4.4: 9 of 10 questions in 436 s, 20 model calls. All 9
passed in their first round (8 on the first attempt). The tenth used `m*a`
with only `m` declared in all 9 attempts across the three rounds, about 150 s,
so a fresh start does not get past a mistake the model makes every time on a
concept. Earlier, the same fresh start by hand (the Try again button this
replaced) wrote 2 of 2.

**Error messages that say what to do (2026-10-07).** The most common math
rejection was a name used but never declared. Told `answer_formula "m*a":
unknown name "a"; available: m`, Gemma read "available: m" as "use only m": it
rewrote the formula as `F_net / m`, then as `f_net / m` with `m` dropped, and
never declared `a`. Before parsing, `checkDeclared` (spec.ts) now names every
undeclared name and what to do with it:
- in answer_formula: add it to variables with a min, max and step and show it in
  the stem as `{{a}}`; a fixed constant such as g = 9.8 is a number in the formula;
- only in the stem: describe the asked-for quantity in words;
- only in the explanation: write the answer as `{{answer}}`.

A variable with min = max (g = 9.8) gets the same advice: remove it and write
the number. Braces in answer_formula are reported as such. Twelve math drafts
(Gemma 4 E4B, one round of three attempts each) of four quantitative concepts in
College Physics 4.3 and 4.4, same sections and concepts in both runs:

| | Before | After |
|---|---|---|
| Drafts that passed | 8 of 12 | 10 of 12 |
| Model calls | 27 | 23 |
| Rejected for an undeclared name | 14 | 9 |
| Undeclared name fixed by the next attempt | 6 of 11 | 6 of 7 |
| Rejected for a constant with min = max | 2 | 0 |
| Time | 666 s | 674 s |

Twelve drafts is a small sample. Re-scoring the 27 earlier attempts with the new
code rejected none that had passed. The remaining Newton's-second-law failure is
different: told to declare `a`, the model did, but it also turned the question
around to ask for the acceleration (`F_net / m`), which left `a` unused. The
other failures were stems that left out a variable.

**Review pass for math (2026-10-06).** Decision: on the in-browser model, math questions skip the review pass, saving about 20 s each. OpenAI still reviews them, wording only. Other question types are reviewed as before. The measurements behind the decision:
- The reviewer only rewords math questions. Its schema has the wording fields only (title, stem, explanation, Bloom, difficulty, citations), and the validated computation is merged back in. Given the chance, Qwen3.5 4B rewrote a correct `(v0 + v) / 2` as `v0 + v / 2`. That passes every check but gives a wrong answer key in every version, and it is the likely source of an `xf - x0 / t` item seen in testing.
- The review prompt covers content only, because format rules are checked in code. Asked to re-check format rules (variable names, placeholders), the 4B model deliberated inside its `issues` strings ("Let's re-read carefully…") until it looped to the 1,800-token limit.
- Same draft, reviewed 8 times:

| | Before | After |
|---|---|---|
| Runaways | 2 of 4 | 0 of 8 |
| Time per review | ~75 s | ~21 s |
| Formula changed by the reviewer | 1 of 7 | impossible |

- Still weak: 5 of the 8 reviews needed a retry for unbalanced TeX braces around placeholders. The reviewer's notes on math are mostly mistaken claims about placeholder format.

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
