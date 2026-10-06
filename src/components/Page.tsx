import { useEffect, type ReactNode } from 'react'

// The top of every main view: an optional breadcrumb trail, the task heading,
// one supporting sentence, and at most one action beside the heading.

export function PageHeader({
  crumbs,
  eyebrow,
  title,
  lede,
  action,
}: {
  crumbs?: [label: string, href?: string][]
  eyebrow?: string
  title: string
  lede?: ReactNode
  action?: ReactNode
}) {
  // Each view is a page of its own for browser tabs, history, and screen readers.
  useEffect(() => {
    document.title = `${title} · LibreTexts Question Studio`
  }, [title])
  return (
    <>
      {crumbs && (
        <nav aria-label="Breadcrumb" className="crumbs">
          <ol>
            {crumbs.map(([label, href], index) => (
              <li key={index}>{href ? <a href={href}>{label}</a> : <span aria-current="page">{label}</span>}</li>
            ))}
          </ol>
        </nav>
      )}
      <header className={`page-header ${action ? 'with-action' : ''}`}>
        <div>
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h1>{title}</h1>
          {lede && <p className="lede">{lede}</p>}
        </div>
        {action}
      </header>
    </>
  )
}
