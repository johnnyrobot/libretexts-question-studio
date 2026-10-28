import { useEffect, useRef, useState } from 'react'

// Copies a link to the clipboard and says so for a moment. Where the browser
// cannot copy (no Clipboard API, or permission refused), it shows the link
// selected instead, for the person to copy themselves.
export function CopyLink({ href }: { href: string }) {
  // How many copies the note is showing for (0 when hidden): each copy
  // changes it, so a second copy shows the note for the full time again.
  const [copies, setCopies] = useState(0)
  const [showField, setShowField] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (copies === 0) return
    const timer = setTimeout(() => setCopies(0), 2000)
    return () => clearTimeout(timer)
  }, [copies])

  const selectField = () => {
    field.current?.focus()
    field.current?.select()
  }

  useEffect(() => {
    if (showField) selectField()
  }, [showField, href])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(href)
      setShowField(false)
      setCopies((n) => n + 1)
    } catch {
      setShowField(true)
      // Already showing: select it again, since the click moved focus.
      selectField()
    }
  }

  return (
    <span className="copy-link">
      <button type="button" onClick={copy}>
        Copy link
      </button>{' '}
      <span role="status" className="fine">
        {copies > 0 ? 'Link copied' : ''}
      </span>
      {showField && <input ref={field} readOnly aria-label="Link to this page" value={href} onFocus={(e) => e.target.select()} />}
    </span>
  )
}
