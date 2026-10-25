// Runs ADAPT's real PHP QTI importer (PHP 7.4, as WebAssembly) against a
// package this app generated, and checks what ADAPT would store.
//
//   npm install --prefix /tmp/php-wasm @php-wasm/node     # ~470 MB, once
//   PHP_WASM_DIR=/tmp/php-wasm npm run verify:adapt
//
// ADAPT_APP defaults to ../adapt/app (the LibreTexts dev workspace layout).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { unzipSync } from 'fflate'

const here = dirname(fileURLToPath(import.meta.url))
const phpWasmDir = process.env.PHP_WASM_DIR
if (!phpWasmDir) {
  console.error('Set PHP_WASM_DIR to a directory where @php-wasm/node is installed (see header).')
  process.exit(2)
}
const adaptApp = resolve(process.env.ADAPT_APP ?? join(here, '../../../adapt/app'))
const zipPath = resolve(process.argv[2] ?? join(here, 'out/sample.zip'))
const expectationsPath = process.argv[3] ?? join(here, 'out/expectations.json')

const modules = join(phpWasmDir, 'node_modules')
const { PHP } = await import(pathToFileURL(join(modules, '@php-wasm/universal/index.js')).href)
const { loadNodeRuntime, useHostFilesystem: mountHostFilesystem } = await import(pathToFileURL(join(modules, '@php-wasm/node/index.js')).href)

// Extract next to the harness: php-wasm sees /Users reliably, symlinked tmp dirs less so.
const workDir = join(here, 'out', 'unzipped')
rmSync(workDir, { recursive: true, force: true })
for (const [name, data] of Object.entries(unzipSync(readFileSync(zipPath)))) {
  const target = join(workDir, name)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, data)
}

const php = new PHP(await loadNodeRuntime('7.4', { emscriptenOptions: { processId: 1 } }))
mountHostFilesystem(php)
const response = await php.run({
  code: readFileSync(join(here, 'harness.php'), 'utf8').replace(
    '[$script, $adaptApp, $dir] = $argv;',
    `[$script, $adaptApp, $dir] = ['harness.php', ${JSON.stringify(adaptApp)}, ${JSON.stringify(workDir)}];`,
  ),
})
if (response.errors) console.error(response.errors)
let result
try {
  result = JSON.parse(response.text)
} catch {
  console.error(response.text)
  process.exit(1)
}

let failures = 0
if (result.error) {
  console.error(`PACKAGE REJECTED: ${result.error}`)
  process.exit(1)
}
// Without an expectations file (e.g. a package exported from the running app)
// only the import itself and the question-type mapping are checked.
const expectations = process.argv[3] === '--no-expectations' ? null : JSON.parse(readFileSync(expectationsPath, 'utf8'))
const ADAPT_TYPES = {
  // processCanvasImport returns these two with "_question" already stripped
  multiple_choice: 'multiple_choice',
  true_false: 'true_false',
  multiple_answers_question: 'multiple_answers',
  numerical_question: 'numerical',
  matching_question: 'matching',
  short_answer_question: 'fill_in_the_blank',
  multiple_dropdowns_question: 'select_choice',
}
console.log(`Quiz: ${result.quizzes.map((q) => q.title).join(', ')}`)
for (const [index, item] of result.items.entries()) {
  const expected = expectations?.[index]
  const problems = []
  if (item.status !== 'success') problems.push(item.error)
  else if (expected) problems.push(...check(item, expected))
  else if (item.message) problems.push(item.message)
  else if (item.question_type === 'essay_question' ? item.technology !== 'text' : item.qti_json?.questionType !== ADAPT_TYPES[item.question_type]) {
    problems.push(`stored as ${item.qti_json?.questionType ?? item.technology}`)
  }
  failures += problems.length ? 1 : 0
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${(expected?.item_type ?? '').padEnd(16)} -> ${item.question_type ?? '?'} "${item.title}"`)
  for (const problem of problems) console.log(`       ${problem}`)
}
if (process.env.VERBOSE) console.log(JSON.stringify(result, null, 2))
process.exit(failures ? 1 : 0)

function check(item, expected) {
  const q = item.qti_json
  const problems = []
  const expect = (condition, message) => condition || problems.push(message)
  switch (expected.item_type) {
    case 'multiple_choice':
    case 'true_false': {
      expect(q.questionType === expected.item_type, `questionType ${q.questionType}`)
      const correct = q.simpleChoice.filter((c) => c.correctResponse)
      expect(q.simpleChoice.length === expected.choices.length, 'choice count')
      expect(correct.length === 1 && correct[0].value === expected.correctHtml, `correct choice ${JSON.stringify(correct)}`)
      if (expected.item_type === 'multiple_choice') {
        expect(q.feedback?.any === expected.explanationHtml, `feedback.any ${JSON.stringify(q.feedback)}`)
        for (const [ident, html] of Object.entries(expected.choiceFeedback)) {
          expect(q.feedback?.[ident] === html, `feedback for ${ident}`)
        }
      }
      break
    }
    case 'multiple_answers': {
      expect(q.questionType === 'multiple_answers', `questionType ${q.questionType}`)
      const correct = q.simpleChoice.filter((c) => c.correctResponse).map((c) => c.value).sort()
      expect(JSON.stringify(correct) === JSON.stringify([...expected.correctHtml].sort()), `correct ${correct}`)
      break
    }
    case 'numerical':
      expect(q.questionType === 'numerical', `questionType ${q.questionType}`)
      expect(Number(q.correctResponse.value) === expected.answer, `value ${q.correctResponse.value}`)
      expect(Math.abs(Number(q.correctResponse.marginOfError) - expected.tolerance) < 1e-9, `margin ${q.correctResponse.marginOfError}`)
      expect(q.feedback?.any === expected.explanationHtml, 'feedback.any')
      break
    case 'matching': {
      expect(q.questionType === 'matching', `questionType ${q.questionType}`)
      const byId = Object.fromEntries(q.possibleMatches.map((m) => [m.identifier, m.matchingTerm]))
      const pairs = q.termsToMatch.map((t) => [t.termToMatch, byId[t.matchingTermIdentifier]])
      expect(JSON.stringify(pairs) === JSON.stringify(expected.pairsHtml), `pairs ${JSON.stringify(pairs)}`)
      expect(q.possibleMatches.length === expected.optionCount, 'distractors kept')
      expect(item.score_hundredths === 10000, `shares add up to ${item.score_hundredths / 100}, not 100`)
      break
    }
    case 'fill_in_blank':
      expect(q.questionType === 'fill_in_the_blank', `questionType ${q.questionType}`)
      expect(q.itemBody.textEntryInteraction.split('<u></u>').length === 2, 'exactly one blank')
      expect(q.responseDeclaration.correctResponse[0].value === expected.answer, 'answer')
      break
    case 'dropdowns': {
      expect(q.questionType === 'select_choice', `questionType ${q.questionType}`)
      expect(!item.message, item.message)
      for (const blank of expected.blanks) {
        const options = q.inline_choice_interactions[blank.id] ?? []
        const correct = options.filter((o) => o.correctResponse).map((o) => o.text)
        expect(JSON.stringify(correct) === JSON.stringify([blank.correctHtml]), `[${blank.id}] correct ${correct}`)
        expect(options.length === blank.optionCount, `[${blank.id}] option count`)
      }
      expect(item.score_hundredths === 10000, `shares add up to ${item.score_hundredths / 100}, not 100`)
      break
    }
    case 'essay':
      expect(item.technology === 'text' && item.qti_json === null, 'imported as open-ended text question')
      expect(item.non_technology_html === expected.stemHtml, `prompt ${item.non_technology_html}`)
      break
  }
  return problems
}
