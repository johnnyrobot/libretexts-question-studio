import { useSyncExternalStore } from 'react'

// Text size scales the root font size, so every rem in styles.css (text,
// spacing, controls) grows together, and it is remembered per device. The
// narrow layout's breakpoint grows with it (900px at 100%, 1800px at 200%), so
// large text gets the full-width layout that browser zoom would give instead
// of a wide sidebar squeezing the page. Both apply when this module loads,
// before React's first render; the page is empty until then, so index.html
// has nothing to apply early.

export const TEXT_SIZES = [0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

const KEY = 'question-studio-text-size'
const NARROW_AT = 900
const listeners = new Set<() => void>()

function stored(): number {
  try {
    const size = Number(localStorage.getItem(KEY))
    return TEXT_SIZES.includes(size) ? size : 1
  } catch {
    return 1
  }
}

let size = stored()
let narrowQuery: MediaQueryList | undefined
let narrow = false

function onNarrowChange(): void {
  narrow = !!narrowQuery?.matches
  document.documentElement.toggleAttribute('data-narrow', narrow)
  listeners.forEach((listener) => listener())
}

function apply(): void {
  document.documentElement.style.setProperty('--text-scale', String(size))
  narrowQuery?.removeEventListener('change', onNarrowChange)
  narrowQuery = window.matchMedia(`(max-width: ${NARROW_AT * size}px)`)
  narrowQuery.addEventListener('change', onNarrowChange)
  onNarrowChange()
}

apply()

export function setTextSize(next: number): void {
  if (!TEXT_SIZES.includes(next) || next === size) return
  size = next
  try {
    localStorage.setItem(KEY, String(size))
  } catch {
    // Storage blocked (private window): the choice lasts for this visit.
  }
  apply()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useTextSize(): number {
  return useSyncExternalStore(subscribe, () => size)
}

/** True while the sidebar is a drawer behind the Menu button. */
export function useNarrowLayout(): boolean {
  return useSyncExternalStore(subscribe, () => narrow)
}
