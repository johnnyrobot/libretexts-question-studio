import { Fragment, useMemo } from 'react'
import { BLANK_RUN, DROPDOWN_PLACEHOLDER, type DraftOf, type QuestionDraft } from '../lib/generation/schema'
import { toTex } from '../lib/math/expr'
import { formatNumber } from '../lib/math/format'
import { compileMath, MathSpecError } from '../lib/math/spec'
import { MathText } from './MathText'

// Instructor-facing preview: shows the answer key, not a student view.
export function ItemPreview({ draft }: { draft: QuestionDraft }) {
  if (draft.item_type === 'math') return <MathPreview draft={draft} />
  return (
    <div className="preview">
      <Stem draft={draft} />
      <AnswerKey draft={draft} />
      <div className="explanation">
        <span className="label">{draft.item_type === 'essay' ? 'Grading notes' : 'Explanation'}</span>
        <MathText text={draft.explanation} block />
      </div>
    </div>
  )
}

function Stem({ draft }: { draft: QuestionDraft }) {
  if (draft.item_type === 'fill_in_blank') {
    const [before, after] = draft.stem.split(BLANK_RUN)
    return (
      <p className="stem">
        <MathText text={before} />
        <span className="blank">{draft.answer}</span>
        <MathText text={after ?? ''} />
      </p>
    )
  }
  if (draft.item_type === 'dropdowns') {
    const pieces = draft.stem.split(DROPDOWN_PLACEHOLDER)
    // split() with a capture group alternates text, id, text, id, …
    return (
      <p className="stem">
        {pieces.map((piece, index) =>
          index % 2 === 0 ? (
            <MathText key={index} text={piece} />
          ) : (
            <span key={index} className="blank" title={`[${piece}]`}>
              {draft.blanks.find((b) => b.id === piece)?.correct ?? `[${piece}]`} ▾
            </span>
          ),
        )}
      </p>
    )
  }
  return (
    <div className="stem">
      <MathText text={draft.stem} block />
    </div>
  )
}

function AnswerKey({ draft }: { draft: QuestionDraft }) {
  switch (draft.item_type) {
    case 'multiple_choice':
    case 'multiple_answers':
      return (
        <ol className="choices" type="A">
          {draft.choices.map((choice, index) => (
            <li key={index} className={choice.correct ? 'correct' : undefined}>
              <span className="mark" aria-label={choice.correct ? 'correct' : 'incorrect'}>
                {choice.correct ? '✓' : '✗'}
              </span>
              <MathText text={choice.text} />
              {choice.feedback && (
                <div className="feedback">
                  <MathText text={choice.feedback} />
                </div>
              )}
            </li>
          ))}
        </ol>
      )
    case 'true_false':
      return (
        <p className="answer">
          Answer: <strong>{draft.answer ? 'True' : 'False'}</strong>
        </p>
      )
    case 'numerical':
      return (
        <p className="answer">
          Answer: <strong>{draft.answer}</strong>
          {draft.tolerance > 0 && <> ± {draft.tolerance}</>}
          {draft.units && <> {draft.units}</>}
        </p>
      )
    case 'matching':
      return (
        <table className="pairs">
          <tbody>
            {draft.pairs.map((pair, index) => (
              <tr key={index}>
                <td>
                  <MathText text={pair.prompt} />
                </td>
                <td aria-hidden>→</td>
                <td>
                  <MathText text={pair.match} />
                </td>
              </tr>
            ))}
            {draft.distractors.map((distractor, index) => (
              <tr key={`d${index}`} className="muted">
                <td>(no match)</td>
                <td aria-hidden>→</td>
                <td>
                  <MathText text={distractor} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )
    case 'fill_in_blank':
      return draft.alternates.length ? (
        <p className="answer muted">Also accepted (Canvas only; ADAPT grades the first answer): {draft.alternates.join(', ')}</p>
      ) : null
    case 'dropdowns':
      return (
        <ul className="dropdown-options">
          {draft.blanks.map((blank) => (
            <li key={blank.id}>
              <code>[{blank.id}]</code> <strong>{blank.correct}</strong>
              <span className="muted"> · also offered: {blank.distractors.join(', ')}</span>
            </li>
          ))}
        </ul>
      )
    case 'essay':
      return (
        <div className="answer">
          <span className="label">Sample answer</span>
          <MathText text={draft.model_answer} block />
        </div>
      )
  }
}

// Version 1 as students see it, then how every version is computed.
function MathPreview({ draft }: { draft: DraftOf<'math'> }) {
  const compiled = useMemo(() => {
    try {
      return compileMath(draft)
    } catch (error) {
      if (error instanceof MathSpecError) return error
      throw error
    }
  }, [draft])
  if (compiled instanceof MathSpecError) {
    return (
      <div className="preview">
        <p className="error">This math question no longer validates: {compiled.message}</p>
      </div>
    )
  }
  const [first] = compiled.variants
  return (
    <div className="preview">
      <div className="stem">
        <MathText text={first.stem} block />
      </div>
      <p className="answer">
        Answer: <strong>{formatNumber(first.answer)}</strong>
        {first.margin > 0 && <> ± {formatNumber(first.margin)}</>}
        {draft.units && <> {draft.units}</>}
        <span className="muted"> · version 1 of {compiled.variants.length} shown</span>
      </p>
      <div className="math-spec">
        <span className="label">How the answer is computed</span>
        <p>
          <MathText text={`\\(\\text{answer} = ${toTex(compiled.answer)}\\)`} />
          {draft.tolerance_percent > 0 ? `, accepted within ±${draft.tolerance_percent}%` : ', exact'}
        </p>
        {compiled.constraints.length > 0 && (
          <p>
            Only numbers where{' '}
            {compiled.constraints.map((node, index) => (
              <Fragment key={index}>
                {index > 0 && ', '}
                <MathText text={`\\(${toTex(node)}\\)`} />
              </Fragment>
            ))}
          </p>
        )}
        <div className="table-scroll">
          <table className="versions">
            <thead>
              <tr>
                <th scope="col">Version</th>
                {draft.variables.map((v) => (
                  <th key={v.name} scope="col" title={`${formatNumber(v.min)} to ${formatNumber(v.max)}, step ${formatNumber(v.step)}`}>
                    <code>{v.name}</code>
                  </th>
                ))}
                <th scope="col">Answer</th>
              </tr>
            </thead>
            <tbody>
              {compiled.variants.map((variant, index) => (
                <tr key={index}>
                  <td>{index + 1}</td>
                  {draft.variables.map((v) => (
                    <td key={v.name}>{formatNumber(variant.values[v.name])}</td>
                  ))}
                  <td>
                    {formatNumber(Number(variant.answer.toPrecision(6)))}
                    {variant.margin > 0 && <span className="muted"> ± {formatNumber(variant.margin)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="explanation">
        <span className="label">Explanation (version 1)</span>
        <MathText text={first.explanation} block />
      </div>
    </div>
  )
}

export function SourceCitations({
  paragraphs,
  cited,
}: {
  paragraphs: { index: number; text: string }[]
  cited: number[]
}) {
  const wanted = new Set(cited)
  return (
    <div className="citations">
      {paragraphs
        .filter((p) => wanted.has(p.index))
        .map((p) => (
          <Fragment key={p.index}>
            <blockquote>
              <MathText text={p.text} />
            </blockquote>
          </Fragment>
        ))}
    </div>
  )
}
