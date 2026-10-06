import { Fragment } from 'react'
import { BLANK_RUN, DROPDOWN_PLACEHOLDER, type QuestionDraft } from '../lib/generation/schema'
import { MathText } from './MathText'

// Instructor-facing preview: shows the answer key, not a student view.
export function ItemPreview({ draft }: { draft: QuestionDraft }) {
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
