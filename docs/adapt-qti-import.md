# What ADAPT's QTI import accepts

Verified against the ADAPT source in `../adapt` (Laravel 7 / PHP 7.4) and by
running ADAPT's own parser on this app's output (`npm run verify:adapt`).

## The format: Canvas QTI 1.2, nothing else

ADAPT's **Bulk Import → Canvas QTI** (Dashboard → My Questions, which opens the
page titled Question Editor, then the Bulk Import tab) is the only working QTI
import. The parser lives in `adapt/app/QtiImport.php` and the package handling
in `adapt/app/Jobs/ProcessValidateQtiFile.php`.

- **QTI 3.0** (what `assessment-ai` exports, `qti-assessment-item`) is not
  recognised anywhere in ADAPT.
- **QTI 2.2** has a code path, but the UI hides it and the server side is broken
  (it writes columns that a later migration dropped).
- The version is not detected from the file. The form sends `qti_source=canvas`.

## Package layout

```
quiz.zip
├── imsmanifest.xml                  (zip root; at least 2 <resource> elements)
└── g<32 hex>/                       one directory per quiz
    ├── assessment_meta.xml          must contain the text "canvas.instructure.com"
    └── g<32 hex>.xml                must be named after its directory
```

- The quiz is found through the manifest resource whose type is
  `associatedcontent/imscc_xmlv1p1/learning-application-resource`.
- `assessment_meta.xml`'s `<title>` and `<description>` become the assignment
  name and instructions when importing into a course. Students see the
  instructions, so the description must not hold notes meant for instructors.
  The export puts the source credit there (title, book and its authors, link,
  license; the book only when the bundled catalog lists it) and, when one was
  typed, "Question author: <name>".
- ADAPT reads only `<resources>` from the manifest; it ignores `<metadata>`. The
  export still names a typed author there as IEEE LOM in its own XML binding:
  `<lom xmlns="http://ltsc.ieee.org/xsd/LOM">` with `lifeCycle/contribute`,
  role `author` (source `LOMv1.0`) and a vCard 3.0 entity with the name in `FN`
  and an empty `N`. (Canvas's exports put these IEEE names under the IMS MD 1.2
  `imsmd` namespace, whose own names are `lifecycle` and `centity/vcard`; the
  export does not copy that mix.) With no author the
  manifest is unchanged. The items carry no author: per-item metadata would
  change the item XML that ADAPT's re-import dedupe compares, so adding or
  changing the author would import every question again as a new one.
- Items must sit directly in the root `<section>`. With nested sections, only the
  first nested section is read.

## Rules that come from how ADAPT parses

ADAPT turns XML into arrays with SimpleXML → `json_encode` → `json_decode`. Laravel
turns every PHP notice into an exception, and that fails the item.

| Rule | Why |
|---|---|
| Every list ADAPT iterates has 0 or ≥ 2 siblings | A single sibling becomes a map, not a list, and PHP throws `Undefined index` |
| ≥ 2 `qtimetadatafield` per item | The `question_type` lookup iterates them |
| No newline inside any text node | ADAPT deletes every `\n` in the item XML before parsing |
| Displayed text is HTML-escaped, then XML-escaped | ADAPT renders choices, terms and options with `v-html` |
| Multiple-choice and true/false prompts contain no `<img>` with a URL | ADAPT tries to read those images from the zip |
| Matching: `response_lid` idents are `response_<digits>`, `<render_choice>` has no attributes, and `<varequal>` appears only in scoring conditions | Correct pairs are read with a regex over the raw XML |
| Multiple dropdowns: correct option listed first, ≥ 2 dropdowns, no other `[ ]` in the prompt (including `\[ \]` math) | ADAPT marks the first option correct and treats any `[x]` as a dropdown |
| Fill in the blank: exactly one `__`-run, one `varequal` per condition | ADAPT makes one blank per underscore run and grades against the first answer |
| Numerical answers use a `vargte`/`varlte` range whose double-precision midpoint is exactly the answer | ADAPT stores value = (low + high) / 2 and margin = half-width rounded to 5 decimals; a naive range can store 0.346154 as 0.34615399999999996 |
| Item XML is under ~64 KB | `qti_imports.xml` is a MySQL `TEXT` column |

The exporter (`src/lib/qti/canvas.ts`) follows all of these. The schemas
(`src/lib/generation/schema.ts`) reject model output that would break them.

Matching and multiple dropdowns questions give each term or blank its share of
`SCORE` (`<setvar action="Add">`), in hundredths, and the last one takes what is
left, so the shares add up to exactly 100 (33.33 + 33.33 + 33.34). ADAPT reads
only which answers are right; Canvas adds up the shares. The ADAPT harness
checks the total.

## Type mapping

| This app | Canvas `question_type` | ADAPT question |
|---|---|---|
| Multiple choice | `multiple_choice_question` | `multiple_choice` (choices shuffled on import) |
| True / false | `true_false_question` | `true_false` |
| Select all that apply | `multiple_answers_question` | `multiple_answers` |
| Numerical | `numerical_question` | `numerical` (value ± margin) |
| Math (randomized numbers) | `numerical_question`, one per version | `numerical`; see [adapt-formats-and-math.md](adapt-formats-and-math.md) |
| Matching | `matching_question` | `matching` |
| Fill in the blank | `short_answer_question` | `fill_in_the_blank` (one blank, exact, case-insensitive) |
| Multiple dropdowns | `multiple_dropdowns_question` | `select_choice` |
| Essay | `essay_question` | open-ended text question (`technology=text`) |

## Feedback

- **Multiple choice:** keeps `general_fb` (shown as "any"), `correct_fb`,
  `general_incorrect_fb` and per-choice `<ident>_fb`.
- **Numerical:** keeps general, correct and incorrect feedback.
- **Matching:** keeps only per-term feedback.
- **True/false, multiple answers, dropdowns, fill-in-the-blank and essay:** ADAPT
  drops item feedback. The explanation is still in the file for Canvas and other
  LMSs.

## Import quirks worth knowing

- `points_possible` is ignored. Points come from the assignment template.
- ADAPT imports a quiz's items in identifier order, not file order
  (`QtiJobController.php` reads `qti_imports` with no ORDER BY, and the unique
  index `(qti_job_id, identifier)` returns them sorted). Item identifiers are
  therefore `q<position>_g<question id hex>`, with the position zero-padded to
  at least 3 digits, so the assignment keeps the set's order.
- Re-importing byte-identical item XML reuses the existing ADAPT question
  ("Already exists in the database"). The identifier is part of that XML, so a
  re-export dedupes an unchanged question only while it keeps its position; an
  edited, moved or renumbered question (after a deletion above it) imports as a
  new one.
- The author and source URL entered on the import form are not saved on imported
  questions (an ADAPT bug: the controller reads columns the job never writes).
- Fill-in-the-blank is graded by exact match after trimming, ignoring case
  (`QtiImport.php` stores `matchingType: exact`, `caseSensitive: no`). "w=mg"
  does not match "w = mg", nor "9.8N" "9.8 N". When a model answer is a number,
  symbol or equation, the review pass is asked to blank a word instead
  (`typedAnswerProblem`). With the answer check (always on the in-browser
  model, on OpenAI unless turned off), the fill-in-the-blank check then blanks
  another word of the sentence if the key is still one, or if the
  check fills the blank differently (`verifyBlank`). The instructor gets a note
  if neither works.
- Essays (`technology=text`) take the assignment's **Default Open-ended
  Submission Type** (`AssignmentSyncQuestion.php`). An assignment template
  where it is None gives students nothing to submit ("Nothing to submit" in the
  assignment's question list); choose Rich Text, or change it per question.

## Live import check

On 2026-10-05, `tests/adapt-parser/out/sample.zip` (one question of every type,
plus version 1 of a math question) went through production
adapt.libretexts.org: Bulk Import → Canvas QTI, Public = No, no course, folder
Main. All 9 questions imported with no errors. Numerical and matching also
worked, though the form's list of supported types leaves them out.

Spot checks in the question preview:
- **Math version:** the numbers were filled in and MathJax rendered the feedback. The answer key read exactly 0.375. ADAPT shows the accepted range to 4 decimals (0.3713 to 0.3787).
- **Multiple choice:** both stem paragraphs, `&`, quotes and `x < y` came through. A `<b>Helium</b>` choice showed as literal text, ADAPT shuffled the choices, and per-choice feedback was kept.
- **Matching and dropdowns:** the answer keys were correct.

On 2026-10-08, three exports from the public site (qtistudio.libretexts.dev,
build 5c08334) went into the hidden test course with an assignment template:
a Gemma 4 E4B set (10 questions: multiple choice, true/false, select all,
fill in the blank, math), that set's math question as 5 randomized versions,
and a GPT-6 Luna set with one question of each of the 9 types. All passed the
PHP parser first, and ADAPT imported 10/10, 5/5 and 10/10 with no errors.

- **Order:** each assignment listed the questions in the set's order (the
  `q001_` identifiers).
- **Names:** the set name "Newton's Laws & Systems — live site, Gemma" became
  the assignment name with the apostrophe, ampersand and dash intact.
- **Model-written math:** the numbers were filled in and the keys were right
  (6.1, accepted 6.039 to 6.161; and 33 with 0% tolerance). Units showed as
  typed ("m/s^2"); the export now writes powers as superscripts.
- **Math in choices:** `\(3.0\,\text{m/s}^2\)` choices and their per-choice
  feedback rendered with MathJax.
- **Essay:** imported, but "Nothing to submit" under that template (see above).

## Checking a package against ADAPT's parser

`tests/adapt-parser/` runs ADAPT's real `app/QtiImport.php` under PHP 7.4,
compiled to WebAssembly. Only Laravel, the database and S3 are stubbed, and
notices throw just as they do under Laravel:

```bash
npm install --prefix /tmp/php-wasm @php-wasm/node      # once, ~470 MB
PHP_WASM_DIR=/tmp/php-wasm npm run verify:adapt          # fixtures of every type, then randomized math versions
PHP_WASM_DIR=/tmp/php-wasm node tests/adapt-parser/run.mjs some-export.zip --no-expectations
```
