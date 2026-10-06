import { useEffect, useMemo, useRef, useState } from 'react'
import { isLikelyContentPage, leafPages, type TocNode } from '../lib/content/libretexts'
import { Icon } from './Icon'

// Pick any mix of chapters, sections, and pages from a book or chapter tree.
// Selection is tracked on leaf pages; parents show checked / mixed state.

export function TocPicker({
  tree,
  selectAll,
  onConfirm,
  busy,
  progress,
}: {
  tree: TocNode
  selectAll: boolean
  onConfirm: (pages: TocNode[]) => void
  busy: boolean
  progress: string
}) {
  const leaves = useMemo(() => leafPages(tree), [tree])
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(selectAll ? leaves.filter(isLikelyContentPage).map((leaf) => leaf.id) : []),
  )
  const toggle = (node: TocNode, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      for (const leaf of leafPages(node)) {
        if (on) next.add(leaf.id)
        else next.delete(leaf.id)
      }
      return next
    })
  const chosen = leaves.filter((leaf) => selected.has(leaf.id))

  return (
    <div className="toc">
      <div className="toc-summary">
        <span className="muted">Tick the chapters or pages to use.</span>
        <button type="button" className="link" onClick={() => setSelected(new Set(leaves.filter(isLikelyContentPage).map((l) => l.id)))}>
          Select all content
        </button>
        {chosen.length > 0 && (
          <button type="button" className="link" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        )}
      </div>
      <ul className="toc-tree">
        {tree.children.length === 0 ? (
          <TocRow node={tree} selected={selected} toggle={toggle} depth={0} />
        ) : (
          tree.children.map((child) => (
            <TocRow key={child.id} node={child} selected={selected} toggle={toggle} depth={0} />
          ))
        )}
      </ul>
      <div className="action-bar">
        <p className="muted" aria-live="polite">
          {progress || `${chosen.length} of ${leaves.length} page${leaves.length === 1 ? '' : 's'} selected`}
        </p>
        <button type="button" className="primary" disabled={chosen.length === 0 || busy} onClick={() => onConfirm(chosen)}>
          {busy ? 'Loading pages…' : `Continue with ${chosen.length} page${chosen.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  )
}

function TocRow({
  node,
  selected,
  toggle,
  depth,
}: {
  node: TocNode
  selected: Set<string>
  toggle: (node: TocNode, on: boolean) => void
  depth: number
}) {
  const leaves = useMemo(() => leafPages(node), [node])
  const count = leaves.filter((leaf) => selected.has(leaf.id)).length
  const checked = count === leaves.length
  const mixed = count > 0 && !checked
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (box.current) box.current.indeterminate = mixed
  }, [mixed])
  const [open, setOpen] = useState(depth === 0 && leaves.length <= 12)
  const label = (
    <label className="toc-label">
      <input ref={box} type="checkbox" checked={checked} onChange={(e) => toggle(node, e.target.checked)} />
      <span>
        {node.title}
        {node.children.length > 0 && (
          <span className="muted">
            {' '}
            {leaves.length} page{leaves.length === 1 ? '' : 's'}
          </span>
        )}
      </span>
    </label>
  )
  if (node.children.length === 0) return <li className="toc-leaf">{label}</li>
  return (
    <li>
      <div className="toc-branch">
        <button
          type="button"
          className="disclosure"
          aria-expanded={open}
          aria-label={`Pages in ${node.title}`}
          onClick={() => setOpen(!open)}
        >
          <Icon name="chevron-right" />
        </button>
        {label}
      </div>
      {open && (
        <ul>
          {node.children.map((child) => (
            <TocRow key={child.id} node={child} selected={selected} toggle={toggle} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}
