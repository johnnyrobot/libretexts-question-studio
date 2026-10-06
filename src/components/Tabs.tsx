import type { KeyboardEvent, ReactNode } from 'react'

// The WAI-ARIA tabs pattern: the row is one Tab stop, and the arrow, Home, and
// End keys move between tabs and select them. <TabPanel> with the same panelId
// holds the selected tab's content.

export function Tabs<T extends string>({
  label,
  tabs,
  selected,
  onSelect,
  panelId,
}: {
  label: string
  tabs: readonly (readonly [value: T, text: string])[]
  selected: T
  onSelect: (value: T) => void
  panelId: string
}) {
  const onKeyDown = (event: KeyboardEvent) => {
    const index = tabs.findIndex(([value]) => value === selected)
    const moves: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }
    if (!(event.key in moves)) return
    event.preventDefault()
    const [next] = tabs[(moves[event.key] + tabs.length) % tabs.length]
    onSelect(next)
    document.getElementById(tabId(panelId, next))?.focus()
  }
  return (
    <div className="segmented" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map(([value, text]) => (
        <button
          key={value}
          type="button"
          role="tab"
          id={tabId(panelId, value)}
          aria-selected={value === selected}
          aria-controls={panelId}
          tabIndex={value === selected ? 0 : -1}
          onClick={() => onSelect(value)}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

export function TabPanel({
  panelId,
  selected,
  className,
  children,
}: {
  panelId: string
  selected: string
  className?: string
  children: ReactNode
}) {
  return (
    <div className={className} role="tabpanel" id={panelId} aria-labelledby={tabId(panelId, selected)}>
      {children}
    </div>
  )
}

function tabId(panelId: string, value: string): string {
  return `${panelId}-tab-${value}`
}
