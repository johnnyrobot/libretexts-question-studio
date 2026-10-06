import katex from 'katex'
import 'katex/dist/katex.min.css'
import { Fragment, useMemo } from 'react'

// Renders plain text with \( \) / \[ \] math the way ADAPT's MathJax will.
// KaTeX output is escaped markup (trust: false), so this is safe for model text.

type Part = { kind: 'text'; text: string } | { kind: 'math'; tex: string; display: boolean }

const MATH = /\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g

function splitMath(text: string): Part[] {
  const parts: Part[] = []
  let last = 0
  for (const match of text.matchAll(MATH)) {
    if (match.index > last) parts.push({ kind: 'text', text: text.slice(last, match.index) })
    parts.push(match[1] !== undefined ? { kind: 'math', tex: match[1], display: false } : { kind: 'math', tex: match[2], display: true })
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) })
  return parts
}

export function MathText({ text, block = false }: { text: string; block?: boolean }) {
  const paragraphs = useMemo(() => (block ? text.split(/\n\s*\n/) : [text]), [text, block])
  const render = (value: string) =>
    splitMath(value).map((part, index) =>
      part.kind === 'text' ? (
        <Fragment key={index}>{part.text}</Fragment>
      ) : (
        <span
          key={index}
          dangerouslySetInnerHTML={{
            __html: katex.renderToString(part.tex, {
              displayMode: part.display,
              throwOnError: false,
              // KaTeX's default #cc0000 for unknown commands is 2.7:1 on the dark theme.
              errorColor: 'var(--danger)',
              trust: false,
              strict: 'ignore',
            }),
          }}
        />
      ),
    )
  if (!block) return <>{render(text)}</>
  return (
    <>
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="pre-line">
          {render(paragraph.trim())}
        </p>
      ))}
    </>
  )
}
