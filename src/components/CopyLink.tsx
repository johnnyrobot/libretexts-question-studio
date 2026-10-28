import { useEffect, useRef, useState } from 'react'

// Copies a link to the clipboard and says so for a moment. Where the browser
// cannot copy (no Clipboard API, or permission refused), it shows the link
// selected instead, for the person to copy themselves.
export function CopyLink({ href }: { href: string }) {
  const [copied, setCopied] = useState(false)
  const [shown, setShown] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  useEffect(() => {
    if (!shown) return
    field.current?.focus()
    field.current?.select()
  }, [shown, href])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(href)
      setCopied(true)
    } catch {
      setShown(true)
    }
  }

  return (
    <span className="copy-link">
      <button type="button" onClick={copy}>
        Copy link
      </button>{' '}
      <span role="status" className="fine">
        {copied ? 'Link copied' : ''}
      </span>
      {shown && <input ref={field} readOnly aria-label="Link to this page" value={href} onFocus={(e) => e.target.select()} />}
    </span>
  )
}
