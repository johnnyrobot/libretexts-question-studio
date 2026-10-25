import type { DraftOf, QuestionDraft } from '../generation/schema'
import { compileMath } from '../math/spec'
import { escapeHtml, formatNumber, mathVersion, paragraphsHtml } from './canvas'

// What ADAPT should store for each exported draft, checked by
// tests/adapt-parser/run.mjs. Used by tests only, like fixtures.ts.
export function adaptExpectation(draft: QuestionDraft) {
  const base = { item_type: draft.item_type, explanationHtml: paragraphsHtml(draft.explanation) }
  switch (draft.item_type) {
    case 'multiple_choice':
      return {
        ...base,
        choices: draft.choices,
        correctHtml: escapeHtml(draft.choices.find((c) => c.correct)!.text),
        choiceFeedback: Object.fromEntries(
          draft.choices.flatMap((c, i) => (c.feedback ? [[String(1000 + i), paragraphsHtml(c.feedback)]] : [])),
        ),
      }
    case 'true_false':
      return { ...base, choices: [1, 2], correctHtml: draft.answer ? 'True' : 'False' }
    case 'multiple_answers':
      return { ...base, correctHtml: draft.choices.filter((c) => c.correct).map((c) => escapeHtml(c.text)) }
    case 'numerical':
      return numericalExpectation(draft)
    case 'math':
      return numericalExpectation(mathVersion(draft, compileMath(draft).variants[0]))
    case 'matching':
      return {
        ...base,
        pairsHtml: draft.pairs.map((p) => [escapeHtml(p.prompt), escapeHtml(p.match)]),
        optionCount: draft.pairs.length + draft.distractors.length,
      }
    case 'fill_in_blank':
      return { ...base, answer: draft.answer }
    case 'dropdowns':
      return {
        ...base,
        blanks: draft.blanks.map((b) => ({ id: b.id, correctHtml: escapeHtml(b.correct), optionCount: 1 + b.distractors.length })),
      }
    case 'essay':
      return { ...base, stemHtml: paragraphsHtml(draft.stem) }
  }
}

// ADAPT stores value = midpoint and margin = half-width (rounded to 5
// decimals) of the exported range. numericRange picks the range so that the
// midpoint is the answer itself, even when a plain decimal range would not be.
export function numericalExpectation(draft: DraftOf<'numerical'>) {
  return {
    item_type: 'numerical' as const,
    explanationHtml: paragraphsHtml(draft.explanation),
    answer: Number(formatNumber(draft.answer)),
    tolerance: Math.round(draft.tolerance * 1e5) / 1e5,
  }
}
