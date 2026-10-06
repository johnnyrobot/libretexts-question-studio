import { useState } from 'react'
import {
  BLOOM_LEVELS,
  DIFFICULTIES,
  parseDraft,
  type DraftOf,
  type QuestionDraft,
} from '../lib/generation/schema'

// Edits a draft in place and re-validates it against the same rules the
// model's output had to pass, so an edited item still imports into ADAPT.

export function ItemEditor({
  draft,
  onSave,
  onCancel,
}: {
  draft: QuestionDraft
  onSave: (draft: QuestionDraft) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState<QuestionDraft>(() => structuredClone(draft))
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<QuestionDraft>) => setValue((current) => ({ ...current, ...patch }) as QuestionDraft)

  const save = () => {
    const { item_type, ...payload } = value
    try {
      onSave(parseDraft(item_type, payload))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <form
      className="editor"
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
    >
      <label>
        Title
        <input value={value.title} onChange={(e) => set({ title: e.target.value })} />
      </label>
      <label>
        Question
        <textarea rows={4} value={value.stem} onChange={(e) => set({ stem: e.target.value })} />
        <StemHint draft={value} />
      </label>
      <TypeFields value={value} set={set} />
      <label>
        {value.item_type === 'essay' ? 'Grading notes' : 'Explanation (shown as feedback)'}
        <textarea rows={3} value={value.explanation} onChange={(e) => set({ explanation: e.target.value })} />
      </label>
      <div className="row">
        <label>
          Bloom level
          <select value={value.bloom} onChange={(e) => set({ bloom: e.target.value as QuestionDraft['bloom'] })}>
            {BLOOM_LEVELS.map((level) => (
              <option key={level}>{level}</option>
            ))}
          </select>
        </label>
        <label>
          Difficulty
          <select
            value={value.difficulty}
            onChange={(e) => set({ difficulty: e.target.value as QuestionDraft['difficulty'] })}
          >
            {DIFFICULTIES.map((level) => (
              <option key={level}>{level}</option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="primary">
          Save changes
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function StemHint({ draft }: { draft: QuestionDraft }) {
  if (draft.item_type === 'fill_in_blank') return <small>Mark the single blank with four underscores: ____</small>
  if (draft.item_type === 'dropdowns') {
    return <small>Place each dropdown as [id] (e.g. [b1]). No other square brackets or \[ \] math.</small>
  }
  return <small>Math: \( inline \) or \[ display \].</small>
}

type Setter = (patch: Partial<QuestionDraft>) => void

function TypeFields({ value, set }: { value: QuestionDraft; set: Setter }) {
  switch (value.item_type) {
    case 'multiple_choice':
    case 'multiple_answers':
      return <ChoiceFields value={value} set={set} />
    case 'true_false':
      return (
        <fieldset>
          <legend>Correct answer</legend>
          <label className="inline">
            <input type="radio" checked={value.answer} onChange={() => set({ answer: true } as Partial<QuestionDraft>)} />{' '}
            True
          </label>
          <label className="inline">
            <input type="radio" checked={!value.answer} onChange={() => set({ answer: false } as Partial<QuestionDraft>)} />{' '}
            False
          </label>
        </fieldset>
      )
    case 'numerical':
      return (
        <div className="row">
          <label>
            Answer
            <input
              type="number"
              step="any"
              value={value.answer}
              onChange={(e) => set({ answer: Number(e.target.value) } as Partial<QuestionDraft>)}
            />
          </label>
          <label>
            ± tolerance
            <input
              type="number"
              step="any"
              min={0}
              value={value.tolerance}
              onChange={(e) => set({ tolerance: Number(e.target.value) } as Partial<QuestionDraft>)}
            />
          </label>
          <label>
            Units
            <input
              value={value.units ?? ''}
              onChange={(e) => set({ units: e.target.value.trim() ? e.target.value : null } as Partial<QuestionDraft>)}
            />
          </label>
        </div>
      )
    case 'matching':
      return <MatchingFields value={value} set={set} />
    case 'fill_in_blank':
      return (
        <div className="row">
          <label>
            Answer
            <input value={value.answer} onChange={(e) => set({ answer: e.target.value } as Partial<QuestionDraft>)} />
          </label>
          <label>
            Also accept (comma separated)
            <input
              value={value.alternates.join(', ')}
              onChange={(e) =>
                set({
                  alternates: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                } as Partial<QuestionDraft>)
              }
            />
          </label>
        </div>
      )
    case 'dropdowns':
      return <DropdownFields value={value} set={set} />
    case 'essay':
      return (
        <label>
          Sample answer
          <textarea
            rows={4}
            value={value.model_answer}
            onChange={(e) => set({ model_answer: e.target.value } as Partial<QuestionDraft>)}
          />
        </label>
      )
  }
}

function ChoiceFields({ value, set }: { value: DraftOf<'multiple_choice'> | DraftOf<'multiple_answers'>; set: Setter }) {
  const single = value.item_type === 'multiple_choice'
  const update = (index: number, patch: Partial<(typeof value.choices)[number]>) =>
    set({
      choices: value.choices.map((choice, i) => {
        if (single && patch.correct) return i === index ? { ...choice, ...patch } : { ...choice, correct: false }
        return i === index ? { ...choice, ...patch } : choice
      }),
    } as Partial<QuestionDraft>)
  return (
    <fieldset>
      <legend>Choices ({single ? 'exactly four, one correct' : 'three to six, mark every correct one'})</legend>
      {value.choices.map((choice, index) => (
        <div key={index} className="choice-row">
          <input
            type={single ? 'radio' : 'checkbox'}
            name="correct"
            aria-label={`Choice ${index + 1} is correct`}
            checked={choice.correct}
            onChange={(e) => update(index, { correct: e.target.checked })}
          />
          <input aria-label={`Choice ${index + 1}`} value={choice.text} onChange={(e) => update(index, { text: e.target.value })} />
          <input
            aria-label={`Feedback for choice ${index + 1}`}
            placeholder="Feedback (optional)"
            value={choice.feedback ?? ''}
            onChange={(e) => update(index, { feedback: e.target.value.trim() ? e.target.value : null })}
          />
          {!single && value.choices.length > 3 && (
            <button
              type="button"
              aria-label={`Remove choice ${index + 1}`}
              onClick={() => set({ choices: value.choices.filter((_, i) => i !== index) } as Partial<QuestionDraft>)}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      {!single && value.choices.length < 6 && (
        <button
          type="button"
          onClick={() =>
            set({ choices: [...value.choices, { text: '', correct: false, feedback: null }] } as Partial<QuestionDraft>)
          }
        >
          Add choice
        </button>
      )}
    </fieldset>
  )
}

function MatchingFields({ value, set }: { value: DraftOf<'matching'>; set: Setter }) {
  const pairs = value.pairs
  return (
    <fieldset>
      <legend>Pairs (two to eight)</legend>
      {pairs.map((pair, index) => (
        <div key={index} className="choice-row">
          <input
            aria-label={`Prompt ${index + 1}`}
            value={pair.prompt}
            onChange={(e) =>
              set({ pairs: pairs.map((p, i) => (i === index ? { ...p, prompt: e.target.value } : p)) } as Partial<QuestionDraft>)
            }
          />
          <span aria-hidden>→</span>
          <input
            aria-label={`Match ${index + 1}`}
            value={pair.match}
            onChange={(e) =>
              set({ pairs: pairs.map((p, i) => (i === index ? { ...p, match: e.target.value } : p)) } as Partial<QuestionDraft>)
            }
          />
          {pairs.length > 2 && (
            <button
              type="button"
              aria-label={`Remove pair ${index + 1}`}
              onClick={() => set({ pairs: pairs.filter((_, i) => i !== index) } as Partial<QuestionDraft>)}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      {pairs.length < 8 && (
        <button type="button" onClick={() => set({ pairs: [...pairs, { prompt: '', match: '' }] } as Partial<QuestionDraft>)}>
          Add pair
        </button>
      )}
      <label>
        Extra matches that pair with nothing (comma separated)
        <input
          value={value.distractors.join(', ')}
          onChange={(e) =>
            set({
              distractors: e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            } as Partial<QuestionDraft>)
          }
        />
      </label>
    </fieldset>
  )
}

function DropdownFields({ value, set }: { value: DraftOf<'dropdowns'>; set: Setter }) {
  const blanks = value.blanks
  const update = (index: number, patch: Partial<(typeof blanks)[number]>) =>
    set({ blanks: blanks.map((b, i) => (i === index ? { ...b, ...patch } : b)) } as Partial<QuestionDraft>)
  return (
    <fieldset>
      <legend>Dropdowns (two to five)</legend>
      {blanks.map((blank, index) => (
        <div key={index} className="choice-row">
          <code>[{blank.id}]</code>
          <input aria-label={`Correct option for ${blank.id}`} value={blank.correct} onChange={(e) => update(index, { correct: e.target.value })} />
          <input
            aria-label={`Other options for ${blank.id}`}
            placeholder="Other options, comma separated"
            value={blank.distractors.join(', ')}
            onChange={(e) =>
              update(index, {
                distractors: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
        </div>
      ))}
    </fieldset>
  )
}
