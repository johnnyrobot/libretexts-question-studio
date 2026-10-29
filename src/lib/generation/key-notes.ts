import type { StoredItem, StoredSet } from '../storage/db'

// The answer check's notes are the ones most likely to mean a wrong answer
// key (LT-135), so the question card lists them apart, under "Check the
// answer key" (LT-136). Each begins with one of these openings, which the
// check has used since it was written, so saved questions are told apart
// from their text alone, with nothing stored beside it.
export const KEY_CHECK_OPENING = 'An automatic answer check disagrees with the answer key'
export const ARITHMETIC_CHECK_OPENING = 'An automatic arithmetic check disagrees with the explanation'
export const BLANK_CHECK_OPENING = 'An automatic check filled the blank with “'

const OPENINGS = [KEY_CHECK_OPENING, ARITHMETIC_CHECK_OPENING, BLANK_CHECK_OPENING]

// About 2 in 5 of the in-browser model's matching keys were wrong in testing,
// most of them with no note from the check, so every such question is listed.
export const MATCHING_IN_BROWSER_NOTE = 'Matching answer keys from the in-browser model are often wrong: check each pair.'

export interface SplitNotes {
  keyChecks: string[]
  notes: string[]
}

// The set records the engine that wrote it, its questions don't; a set
// without one is taken as written in the browser.
export function splitNotes(item: Pick<StoredItem, 'draft' | 'critique'>, provider: StoredSet['provider'] | undefined): SplitNotes {
  const isKeyCheck = (note: string) => OPENINGS.some((opening) => note.startsWith(opening))
  const keyChecks = item.critique.filter(isKeyCheck)
  if (item.draft.item_type === 'matching' && provider !== 'openai') keyChecks.push(MATCHING_IN_BROWSER_NOTE)
  return { keyChecks, notes: item.critique.filter((note) => !isKeyCheck(note)) }
}
