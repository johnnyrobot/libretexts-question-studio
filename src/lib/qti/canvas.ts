import { zipSync, strToU8 } from 'fflate'
import { BLANK_RUN, type DraftOf, type QuestionDraft } from '../generation/schema'
import { formatNumber, formatUnits } from '../math/format'
import { compileMath, type MathVariant } from '../math/spec'

export { formatNumber }

// Canvas-flavoured QTI 1.2 quiz packages: the only QTI that ADAPT's importer
// accepts (adapt/app/Jobs/ProcessValidateQtiFile.php, adapt/app/QtiImport.php).
// ADAPT reads the XML through PHP SimpleXML -> json_encode -> arrays, so the
// shape below follows rules that importer imposes, not only the QTI spec:
//
//   * imsmanifest.xml lists >= 2 resources; the quiz is found through its
//     `associatedcontent/imscc_xmlv1p1/learning-application-resource`.
//   * {quiz}/assessment_meta.xml mentions canvas.instructure.com.
//   * Items live at {quiz}/{quiz}.xml directly in the root <section>.
//   * Every item has >= 2 qtimetadatafields, and every list ADAPT iterates
//     (choices, matching terms, dropdowns, respconditions, itemfeedback) has
//     either 0 or >= 2 siblings; a lone sibling becomes a map and PHP throws.
//   * ADAPT deletes every "\n" in an item before parsing, so no text node may
//     contain a newline; lines between tags are fine.
//   * Displayed text is HTML (ADAPT renders it with v-html), so it is
//     HTML-escaped, then XML-escaped once more as mattext content.
//   * Matching correct pairs are read with a regex over the raw XML, so
//     <varequal> appears only in the scoring conditions and matching
//     response_lid idents are `response_<digits>`.
//   * Multiple dropdowns: ADAPT treats the FIRST option as correct, and any
//     other [ ] in the prompt is mistaken for a dropdown.

export interface QuizItem {
  id: string
  draft: QuestionDraft
}

// The item's own id (seeds its shuffles) and its identifier in the file.
interface ItemKey {
  id: string
  ident: string
}

export interface QuizPackageInput {
  id: string
  title: string
  description?: string
  items: QuizItem[]
  pointsPerItem?: number
}

export interface PackageOptions {
  // Who wrote the questions. ADAPT ignores the manifest's metadata, so the
  // export also names them in each quiz's description.
  author?: string
}

export function buildQuizPackage(quizzes: QuizPackageInput[], options: PackageOptions = {}): Uint8Array {
  if (quizzes.length === 0) throw new Error('Nothing to export.')
  const files: Record<string, Uint8Array> = {}
  const resources: string[] = []
  for (const quiz of quizzes) {
    if (quiz.items.length === 0) throw new Error(`"${quiz.title}" has no approved questions to export.`)
    const dir = ident(quiz.id)
    files[`${dir}/${dir}.xml`] = strToU8(buildAssessmentXml(quiz))
    files[`${dir}/assessment_meta.xml`] = strToU8(buildAssessmentMetaXml(quiz))
    resources.push(
      `<resource identifier="${dir}" type="imsqti_xmlv1p2">\n<file href="${dir}/${dir}.xml"/>\n<dependency identifierref="${dir}_meta"/>\n</resource>`,
      `<resource identifier="${dir}_meta" type="associatedcontent/imscc_xmlv1p1/learning-application-resource" href="${dir}/assessment_meta.xml">\n<file href="${dir}/assessment_meta.xml"/>\n</resource>`,
    )
  }
  files['imsmanifest.xml'] = strToU8(buildManifestXml(ident(quizzes[0].id) + '_manifest', resources, options.author))
  // A fixed local-time stamp keeps the archive byte-stable for the same content
  // (zip stores local DOS time, so a UTC date would shift with the time zone).
  return zipSync(files, { level: 9, mtime: new Date(2000, 0, 1) })
}

function buildManifestXml(identifier: string, resources: string[], author = ''): string {
  // With no author the manifest stays exactly as it was before authorship.
  const lom = author.trim() ? `\n${authorLom(author)}` : ''
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<manifest identifier="${identifier}" xmlns="http://www.imsglobal.org/xsd/imsccv1p1/imscp_v1p1"${lom && ' xmlns:imsmd="http://www.imsglobal.org/xsd/imsmd_v1p2"'} xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.imsglobal.org/xsd/imsccv1p1/imscp_v1p1 http://www.imsglobal.org/xsd/imscp_v1p1.xsd">`,
    `<metadata>\n<schema>IMS Content</schema>\n<schemaversion>1.1.3</schemaversion>${lom}\n</metadata>`,
    '<organizations/>',
    '<resources>',
    ...resources,
    '</resources>',
    '</manifest>',
    '',
  ].join('\n')
}

// IEEE LOM in the imsmd namespace and shape of Canvas's QTI export manifests.
// The author is a lifeCycle contributor with the role "author", named by a
// vCard 3.0 whose text escapes \ , and ;.
function authorLom(author: string): string {
  const name = oneLine(author).replace(/[\\,;]/g, (c) => `\\${c}`)
  return [
    '<imsmd:lom>',
    '<imsmd:lifeCycle>',
    '<imsmd:contribute>',
    '<imsmd:role>',
    '<imsmd:source>LOMv1.0</imsmd:source>',
    '<imsmd:value>author</imsmd:value>',
    '</imsmd:role>',
    `<imsmd:entity>BEGIN:VCARD\nVERSION:3.0\nFN:${xml(name)}\nEND:VCARD</imsmd:entity>`,
    '</imsmd:contribute>',
    '</imsmd:lifeCycle>',
    '</imsmd:lom>',
  ].join('\n')
}

export function buildAssessmentMetaXml(quiz: QuizPackageInput): string {
  const points = quiz.items.length * (quiz.pointsPerItem ?? 1)
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<quiz identifier="${ident(quiz.id)}" xmlns="http://canvas.instructure.com/xsd/cccv1p0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://canvas.instructure.com/xsd/cccv1p0 https://canvas.instructure.com/xsd/cccv1p0.xsd">`,
    `<title>${xml(oneLine(quiz.title))}</title>`,
    `<description>${xml(paragraphsHtml(quiz.description ?? ''))}</description>`,
    '<shuffle_answers>true</shuffle_answers>',
    '<scoring_policy>keep_highest</scoring_policy>',
    '<quiz_type>assignment</quiz_type>',
    `<points_possible>${points}</points_possible>`,
    '<show_correct_answers>true</show_correct_answers>',
    '<allowed_attempts>1</allowed_attempts>',
    '<one_question_at_a_time>false</one_question_at_a_time>',
    '<cant_go_back>false</cant_go_back>',
    '<available>false</available>',
    '</quiz>',
    '',
  ].join('\n')
}

export function buildAssessmentXml(quiz: QuizPackageInput): string {
  const points = quiz.pointsPerItem ?? 1
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<questestinterop xmlns="http://www.imsglobal.org/xsd/ims_qtiasiv1p2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.imsglobal.org/xsd/ims_qtiasiv1p2 http://www.imsglobal.org/xsd/ims_qtiasiv1p2p1.xsd">',
    `<assessment ident="${ident(quiz.id)}" title="${xml(oneLine(quiz.title))}">`,
    '<qtimetadata>\n<qtimetadatafield>\n<fieldlabel>cc_maxattempts</fieldlabel>\n<fieldentry>1</fieldentry>\n</qtimetadatafield>\n</qtimetadata>',
    '<section ident="root_section">',
    ...quiz.items.map((item, index) => buildItemXml(item, points, itemIdent(item.id, index, quiz.items.length))),
    '</section>',
    '</assessment>',
    '</questestinterop>',
    '',
  ].join('\n')
}

export function buildItemXml(item: QuizItem, points = 1, identifier = ident(item.id)): string {
  const key: ItemKey = { id: item.id, ident: identifier }
  const draft = item.draft
  switch (draft.item_type) {
    case 'multiple_choice':
      return choiceItem(key, draft, 'multiple_choice_question', points)
    case 'true_false':
      return choiceItem(key, trueFalseAsChoices(draft), 'true_false_question', points)
    case 'multiple_answers':
      return multipleAnswersItem(key, draft, points)
    case 'numerical':
      return numericalItem(key, draft, points)
    case 'math':
      // On its own a math question exports its first version; export.ts can
      // also write every version as a quiz for ADAPT's randomization.
      return numericalItem(key, mathVersion(draft, compileMath(draft).variants[0]), points)
    case 'matching':
      return matchingItem(key, draft, points)
    case 'fill_in_blank':
      return fillInBlankItem(key, draft, points)
    case 'dropdowns':
      return dropdownsItem(key, draft, points)
    case 'essay':
      return essayItem(key, draft, points)
  }
}

// One version of a math question as a fixed numerical question.
export function mathVersion(draft: DraftOf<'math'>, variant: MathVariant, title = draft.title): DraftOf<'numerical'> {
  const { variables: _v, constraints: _c, answer_formula: _a, tolerance_percent: _t, ...common } = draft
  void [_v, _c, _a, _t]
  return {
    ...common,
    item_type: 'numerical',
    title,
    stem: variant.stem,
    explanation: variant.explanation,
    answer: variant.answer,
    tolerance: variant.margin,
  }
}

// ---------------------------------------------------------------- item types

interface ChoiceLike {
  stem: string
  title: string
  explanation: string
  choices: { text: string; correct: boolean; feedback: string | null }[]
}

function trueFalseAsChoices(draft: DraftOf<'true_false'>): ChoiceLike {
  // ADAPT and Canvas both expect the labels in True, False order.
  return {
    ...draft,
    choices: [
      { text: 'True', correct: draft.answer, feedback: null },
      { text: 'False', correct: !draft.answer, feedback: null },
    ],
  }
}

function choiceItem(key: ItemKey, draft: ChoiceLike, questionType: string, points: number): string {
  const labels = draft.choices.map((choice, index) => ({ ...choice, ident: String(1000 + index) }))
  const correct = labels.find((label) => label.correct)
  if (!correct) throw new Error(`"${draft.title}" has no correct choice.`)
  const choiceFeedback = labels.filter((label) => label.feedback)
  return item(key, draft.title, questionType, points, [
    presentation(
      draft.stem,
      `<response_lid ident="response1" rcardinality="Single">\n<render_choice>\n${labels
        .map((label) => responseLabel(label.ident, label.text))
        .join('\n')}\n</render_choice>\n</response_lid>`,
    ),
    resprocessing([
      generalFeedbackCondition(),
      ...choiceFeedback.map(
        (label) =>
          `<respcondition continue="Yes">\n<conditionvar>\n<varequal respident="response1">${label.ident}</varequal>\n</conditionvar>\n<displayfeedback feedbacktype="Response" linkrefid="${label.ident}_fb"/>\n</respcondition>`,
      ),
      `<respcondition continue="No">\n<conditionvar>\n<varequal respident="response1">${correct.ident}</varequal>\n</conditionvar>\n<setvar action="Set" varname="SCORE">100</setvar>\n<displayfeedback feedbacktype="Response" linkrefid="correct_fb"/>\n</respcondition>`,
      incorrectFeedbackCondition(),
    ]),
    ...standardFeedback(draft.explanation),
    ...choiceFeedback.map((label) => itemFeedback(`${label.ident}_fb`, label.feedback!)),
  ])
}

function multipleAnswersItem(key: ItemKey, draft: DraftOf<'multiple_answers'>, points: number): string {
  const labels = draft.choices.map((choice, index) => ({ ...choice, ident: String(1000 + index) }))
  const conditions = labels
    .map((label) =>
      label.correct
        ? `<varequal respident="response1">${label.ident}</varequal>`
        : `<not>\n<varequal respident="response1">${label.ident}</varequal>\n</not>`,
    )
    .join('\n')
  return item(key, draft.title, 'multiple_answers_question', points, [
    presentation(
      draft.stem,
      `<response_lid ident="response1" rcardinality="Multiple">\n<render_choice>\n${labels
        .map((label) => responseLabel(label.ident, label.text))
        .join('\n')}\n</render_choice>\n</response_lid>`,
    ),
    resprocessing([
      generalFeedbackCondition(),
      `<respcondition continue="No">\n<conditionvar>\n<and>\n${conditions}\n</and>\n</conditionvar>\n<setvar action="Set" varname="SCORE">100</setvar>\n<displayfeedback feedbacktype="Response" linkrefid="correct_fb"/>\n</respcondition>`,
      incorrectFeedbackCondition(),
    ]),
    ...standardFeedback(draft.explanation),
  ])
}

function numericalItem(key: ItemKey, draft: DraftOf<'numerical'>, points: number): string {
  const [low, high] = numericRange(draft.answer, draft.tolerance)
  const stem = draft.units ? `${draft.stem} (Answer in ${formatUnits(draft.units)}.)` : draft.stem
  return item(key, draft.title, 'numerical_question', points, [
    presentation(
      stem,
      '<response_str ident="response1" rcardinality="Single">\n<render_fib fibtype="Decimal">\n<response_label ident="answer1"/>\n</render_fib>\n</response_str>',
    ),
    resprocessing([
      generalFeedbackCondition(),
      `<respcondition continue="No">\n<conditionvar>\n<vargte respident="response1">${low}</vargte>\n<varlte respident="response1">${high}</varlte>\n</conditionvar>\n<setvar action="Set" varname="SCORE">100</setvar>\n<displayfeedback feedbacktype="Response" linkrefid="correct_fb"/>\n</respcondition>`,
      incorrectFeedbackCondition(),
    ]),
    ...standardFeedback(draft.explanation),
  ])
}

// ADAPT reads a vargte/varlte range as value = (low + high) / 2 and margin =
// half-width rounded to 5 decimals, in doubles, just as JavaScript computes
// them. A plain decimal range can store 0.346154 as 0.34615399999999996,
// which ADAPT then shows as the answer. When it would, the bounds are written
// as two doubles whose sum is exactly twice the answer, printed with enough
// digits that PHP parses back the same doubles.
export function numericRange(answer: number, tolerance: number): [string, string] {
  const center = Number(formatNumber(answer))
  if (tolerance === 0) return [formatNumber(center), formatNumber(center)]
  const margin = Math.round(tolerance * 1e5) / 1e5
  const stores = ([low, high]: [string, string]) => {
    const value = (Number(low) + Number(high)) / 2
    return value === center && Math.round((Number(high) - value) * 1e5) / 1e5 === margin
  }
  const plain: [string, string] = [formatNumber(center - tolerance), formatNumber(center + tolerance)]
  if (stores(plain)) return plain
  // 2 * center - low can land on a rounding tie; a neighbouring low cannot.
  const start = center - tolerance
  const ulp = 2 ** (Math.floor(Math.log2(Math.abs(start) || 1)) - 52)
  for (const step of [0, 1, -1, 2, -2, 3, -3]) {
    const low = start + step * ulp
    const exact: [string, string] = [String(low), String(2 * center - low)]
    if (stores(exact) && !/e/i.test(exact.join(''))) return exact
  }
  return plain
}

function matchingItem(key: ItemKey, draft: DraftOf<'matching'>, points: number): string {
  const options = [...draft.pairs.map((pair) => pair.match), ...draft.distractors].map((text, index) => ({
    ident: String(2000 + index),
    text,
  }))
  const terms = draft.pairs.map((pair, index) => ({
    lid: `response_${1000 + index}`,
    prompt: pair.prompt,
    correct: options[index].ident,
  }))
  // Listed in pair order, option N would answer term N. ADAPT and Canvas
  // shuffle per student, but other importers may not; a seeded shuffle keeps
  // the file byte-stable.
  seededShuffle(options, key.id)
  // <render_choice> must carry no attributes: ADAPT iterates its children.
  const renderChoice = `<render_choice>\n${options.map((o) => responseLabel(o.ident, o.text)).join('\n')}\n</render_choice>`
  const shares = scoreShares(terms.length)
  return item(key, draft.title, 'matching_question', points, [
    presentation(
      draft.stem,
      terms
        .map(
          (term) =>
            `<response_lid ident="${term.lid}">\n<material>\n<mattext texttype="text/html">${xml(displayHtml(oneLine(term.prompt)))}</mattext>\n</material>\n${renderChoice}\n</response_lid>`,
        )
        .join('\n'),
    ),
    resprocessing(
      terms.map(
        (term, index) =>
          `<respcondition>\n<conditionvar>\n<varequal respident="${term.lid}">${term.correct}</varequal>\n</conditionvar>\n<setvar varname="SCORE" action="Add">${shares[index]}</setvar>\n</respcondition>`,
      ),
    ),
    ...standardFeedback(draft.explanation),
  ])
}

function fillInBlankItem(key: ItemKey, draft: DraftOf<'fill_in_blank'>, points: number): string {
  // Normalise the single blank to exactly four underscores.
  const stem = draft.stem.replace(BLANK_RUN, '____')
  const answers = [draft.answer, ...draft.alternates]
  return item(key, draft.title, 'short_answer_question', points, [
    presentation(
      stem,
      '<response_str ident="response1" rcardinality="Single">\n<render_fib>\n<response_label ident="answer1" rshuffle="No"/>\n</render_fib>\n</response_str>',
    ),
    // ADAPT grades against the first accepted answer; Canvas accepts each one.
    resprocessing(
      answers.map(
        (answer) =>
          `<respcondition continue="No">\n<conditionvar>\n<varequal respident="response1">${xml(oneLine(answer))}</varequal>\n</conditionvar>\n<setvar action="Set" varname="SCORE">100</setvar>\n</respcondition>`,
      ),
    ),
    ...standardFeedback(draft.explanation),
  ])
}

function dropdownsItem(key: ItemKey, draft: DraftOf<'dropdowns'>, points: number): string {
  let next = 3000
  const blanks = draft.blanks.map((blank) => ({
    ...blank,
    // Correct option first: that is how ADAPT knows which one is right. ADAPT
    // shuffles options per student, so the order is not visible to learners.
    options: [blank.correct, ...blank.distractors].map((text) => ({ ident: String(next++), text })),
  }))
  const shares = scoreShares(blanks.length)
  return item(key, draft.title, 'multiple_dropdowns_question', points, [
    presentation(
      draft.stem,
      blanks
        .map(
          (blank) =>
            `<response_lid ident="response_${blank.id}">\n<material>\n<mattext>${blank.id}</mattext>\n</material>\n<render_choice>\n${blank.options
              .map((option) => responseLabel(option.ident, option.text))
              .join('\n')}\n</render_choice>\n</response_lid>`,
        )
        .join('\n'),
    ),
    resprocessing(
      blanks.map(
        (blank, index) =>
          `<respcondition>\n<conditionvar>\n<varequal respident="response_${blank.id}">${blank.options[0].ident}</varequal>\n</conditionvar>\n<setvar varname="SCORE" action="Add">${shares[index]}</setvar>\n</respcondition>`,
      ),
    ),
    ...standardFeedback(draft.explanation),
  ])
}

// Each part of a matching or dropdowns question adds its share of 100 to
// SCORE. Equal shares rounded to hundredths add up to 99.99 for three parts
// and 100.03 for seven, so the last part takes what is left.
function scoreShares(parts: number): string[] {
  const share = Math.round(10000 / parts)
  return Array.from({ length: parts }, (_, index) => formatNumber((index === parts - 1 ? 10000 - share * (parts - 1) : share) / 100))
}

function essayItem(key: ItemKey, draft: DraftOf<'essay'>, points: number): string {
  return item(key, draft.title, 'essay_question', points, [
    presentation(
      draft.stem,
      '<response_str ident="response1" rcardinality="Single">\n<render_fib>\n<response_label ident="answer1" rshuffle="No"/>\n</render_fib>\n</response_str>',
    ),
    resprocessing(['<respcondition continue="No">\n<conditionvar>\n<other/>\n</conditionvar>\n</respcondition>']),
    itemFeedback('general_fb', `Sample answer: ${draft.model_answer}\n\n${draft.explanation}`),
  ])
}

// ------------------------------------------------------------------ builders

function item(key: ItemKey, title: string, questionType: string, points: number, body: string[]): string {
  return [
    `<item ident="${key.ident}" title="${xml(oneLine(title))}">`,
    '<itemmetadata>\n<qtimetadata>',
    metadataField('question_type', questionType),
    metadataField('points_possible', formatNumber(points)),
    metadataField('assessment_question_identifierref', `${key.ident}_aq`),
    '</qtimetadata>\n</itemmetadata>',
    ...body,
    '</item>',
  ].join('\n')
}

function metadataField(label: string, entry: string): string {
  return `<qtimetadatafield>\n<fieldlabel>${label}</fieldlabel>\n<fieldentry>${xml(entry)}</fieldentry>\n</qtimetadatafield>`
}

function presentation(stem: string, interaction: string): string {
  return `<presentation>\n<material>\n<mattext texttype="text/html">${xml(paragraphsHtml(stem))}</mattext>\n</material>\n${interaction}\n</presentation>`
}

function responseLabel(identifier: string, text: string): string {
  return `<response_label ident="${identifier}">\n<material>\n<mattext texttype="text/html">${xml(displayHtml(oneLine(text)))}</mattext>\n</material>\n</response_label>`
}

function resprocessing(conditions: string[]): string {
  return [
    '<resprocessing>',
    '<outcomes>\n<decvar maxvalue="100" minvalue="0" varname="SCORE" vartype="Decimal"/>\n</outcomes>',
    ...conditions,
    '</resprocessing>',
  ].join('\n')
}

function generalFeedbackCondition(): string {
  return '<respcondition continue="Yes">\n<conditionvar>\n<other/>\n</conditionvar>\n<displayfeedback feedbacktype="Response" linkrefid="general_fb"/>\n</respcondition>'
}

function incorrectFeedbackCondition(): string {
  return '<respcondition continue="Yes">\n<conditionvar>\n<other/>\n</conditionvar>\n<displayfeedback feedbacktype="Response" linkrefid="general_incorrect_fb"/>\n</respcondition>'
}

// Always three entries: ADAPT drops (MC) or crashes on (matching) a lone one.
function standardFeedback(explanation: string): string[] {
  return [
    itemFeedback('general_fb', explanation),
    itemFeedback('correct_fb', 'Correct.'),
    itemFeedback('general_incorrect_fb', 'Not quite. Review the explanation and the source section.'),
  ]
}

function itemFeedback(identifier: string, text: string): string {
  return `<itemfeedback ident="${identifier}">\n<flow_mat>\n<material>\n<mattext texttype="text/html">${xml(paragraphsHtml(text))}</mattext>\n</material>\n</flow_mat>\n</itemfeedback>`
}

// ------------------------------------------------------------------- helpers

// Canvas-style identifiers: "g" + 32 hex characters, stable per item. A UUID
// keeps its own hex; any other id (such as "<uuid>:v2") is hashed.
export function ident(id: string): string {
  const hex = id.toLowerCase().replace(/-/g, '')
  if (/^[0-9a-f]{32}$/.test(hex)) return 'g' + hex
  return 'g' + simpleHash(id)
}

// ADAPT imports a quiz's items in identifier order, not file order: its
// QtiJobController reads them back with no ORDER BY, and the unique index on
// (qti_job_id, identifier) returns them sorted. So an item's identifier starts
// with its zero-padded position ("q001_g…"). ADAPT dedupes a re-import by the
// item's whole XML, so an unchanged question dedupes only while it keeps its
// position; a moved one imports again as a new question.
export function itemIdent(id: string, position: number, count: number): string {
  const width = Math.max(3, String(count).length)
  return `q${String(position + 1).padStart(width, '0')}_${ident(id)}`
}

function seededShuffle<T>(values: T[], seed: string): void {
  let state = parseInt(simpleHash(seed).slice(0, 8), 16) || 1
  for (let i = values.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const j = state % (i + 1)
    ;[values[i], values[j]] = [values[j], values[i]]
  }
}

function simpleHash(value: string): string {
  let out = ''
  for (let seed = 0; out.length < 32; seed++) {
    let h = 2166136261 ^ seed
    for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619)
    out += (h >>> 0).toString(16).padStart(8, '0')
  }
  return out.slice(0, 32)
}

// Production ADAPT runs MathJax 3 with $…$ as an inline-math delimiter, so a
// literal dollar sign ("costs $5") would start a formula. MathJax skips
// elements with class tex2jax_ignore; other LMSs just render the span.
function displayHtml(value: string): string {
  return escapeHtml(value).replace(/\$/g, '<span class="tex2jax_ignore">$</span>')
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// XML 1.0 forbids most control characters, and one of them makes the whole
// quiz file unreadable, so ADAPT would import none of its questions.
// eslint-disable-next-line no-control-regex -- removing these is the point
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g

function xml(value: string): string {
  return value.replace(NOT_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function oneLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, ' ').trim()
}

// Plain text with blank-line paragraphs -> one <div> of <p>s, no raw newlines.
export function paragraphsHtml(value: string): string {
  const paragraphs = value
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${displayHtml(p).replace(/\s*\r?\n\s*/g, '<br>')}</p>`)
  return `<div>${paragraphs.join('')}</div>`
}
