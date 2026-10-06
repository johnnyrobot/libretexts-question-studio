import { Fragment, useMemo, useState, type InputHTMLAttributes } from 'react'
import { formatNumber } from '../lib/math/format'
import { compileMath, MathSpecError, MAX_TOLERANCE_PERCENT } from '../lib/math/spec'
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
        {value.item_type === 'essay'
          ? 'Grading notes'
          : value.item_type === 'math'
            ? 'Worked solution (shown as feedback; may use {{answer}} and {{expressions}})'
            : 'Explanation (shown as feedback)'}
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
  if (draft.item_type === 'math') return <small>Show every variable as {'{{name}}'}. Math: \( inline \) or \[ display \].</small>
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
    case 'math':
      return <MathFields value={value} set={set} />
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

function MathFields({ value, set }: { value: DraftOf<'math'>; set: Setter }) {
  const variables = value.variables
  const update = (index: number, patch: Partial<(typeof variables)[number]>) =>
    set({ variables: variables.map((v, i) => (i === index ? { ...v, ...patch } : v)) } as Partial<QuestionDraft>)
  const [constraintsText, setConstraintsText] = useState(() => value.constraints.join('\n'))
  const check = useMemo(() => {
    try {
      return compileMath(value)
    } catch (error) {
      if (error instanceof MathSpecError) return error
      throw error
    }
  }, [value])
  return (
    <>
      <fieldset>
        <legend>Variables (one to six)</legend>
        <div className="variable-grid">
          <span aria-hidden>Name</span>
          <span aria-hidden>Min</span>
          <span aria-hidden>Max</span>
          <span aria-hidden>Step</span>
          <span />
          {variables.map((variable, index) => (
            <Fragment key={index}>
              <input
                aria-label={`Variable ${index + 1} name`}
                value={variable.name}
                onChange={(e) => update(index, { name: e.target.value.trim() })}
              />
              {(['min', 'max', 'step'] as const).map((field) => (
                <NumberField
                  key={field}
                  aria-label={`Variable ${index + 1} ${field}`}
                  value={variable[field]}
                  onValue={(n) => update(index, { [field]: n })}
                />
              ))}
              {variables.length > 1 ? (
                <button
                  type="button"
                  aria-label={`Remove variable ${index + 1}`}
                  onClick={() => set({ variables: variables.filter((_, i) => i !== index) } as Partial<QuestionDraft>)}
                >
                  ✕
                </button>
              ) : (
                <span />
              )}
            </Fragment>
          ))}
        </div>
        {variables.length < 6 && (
          <button
            type="button"
            onClick={() =>
              set({ variables: [...variables, { name: '', min: 1, max: 10, step: 1 }] } as Partial<QuestionDraft>)
            }
          >
            Add variable
          </button>
        )}
      </fieldset>
      <label>
        Answer formula
        <input value={value.answer_formula} onChange={(e) => set({ answer_formula: e.target.value } as Partial<QuestionDraft>)} />
        <small>+ - * / ^ ( ), sqrt abs exp ln log10 sin cos tan (radians), sind cosd tand (degrees), min max round, pi</small>
      </label>
      <label>
        Constraints (one per line, e.g. a &lt; b)
        <textarea
          rows={2}
          value={constraintsText}
          onChange={(e) => {
            setConstraintsText(e.target.value)
            set({ constraints: e.target.value.split('\n').map((line) => line.trim()).filter(Boolean) } as Partial<QuestionDraft>)
          }}
        />
      </label>
      <div className="row">
        <label>
          ± tolerance (%)
          <NumberField
            value={value.tolerance_percent}
            onValue={(n) => set({ tolerance_percent: Math.min(MAX_TOLERANCE_PERCENT, Math.max(0, n)) } as Partial<QuestionDraft>)}
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
      {check instanceof MathSpecError ? (
        <p className="error" role="status">
          {check.message}
        </p>
      ) : (
        <p className="fine" role="status">
          ✓ Valid. Version 1 answer: {formatNumber(Number(check.variants[0].answer.toPrecision(6)))}
          {value.units ? ` ${value.units}` : ''}
        </p>
      )}
    </>
  )
}

// Keeps the typed text, so "-" or "0." can be typed on the way to a number;
// only complete numbers reach the draft.
function NumberField({
  value,
  onValue,
  ...props
}: { value: number; onValue: (value: number) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [text, setText] = useState(String(value))
  const [shown, setShown] = useState(value)
  if (value !== shown) {
    setShown(value)
    setText(String(value))
  }
  return (
    <input
      {...props}
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        const parsed = Number(e.target.value)
        if (e.target.value.trim() && Number.isFinite(parsed)) {
          setShown(parsed)
          onValue(parsed)
        }
      }}
    />
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
