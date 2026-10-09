import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Icon } from './components/Icon'
import { localModel, useLoadedLocalModel } from './lib/llm/local-models'
import { db } from './lib/storage/db'
import { useSessionKey } from './lib/storage/secrets'
import { useRoute } from './router'
import { localModelId, useEngineSettings } from './state/engine'
import { useGeneration } from './state/generation'
import { TEXT_SIZES, setTextSize, useNarrowLayout, useTextSize } from './state/text-size'
import { setTheme, useTheme } from './state/theme'
import { Create } from './views/Create'
import { Library } from './views/Library'
import { SetView } from './views/SetView'
import { Settings, type SettingsSection } from './views/Settings'

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
}

type Page =
  | { name: 'create'; sourceId?: string }
  | { name: 'library' }
  | { name: 'set'; setId: string; tab: 'review' | 'export' }
  | { name: 'settings'; section: SettingsSection }

function pageFor(route: string): Page {
  const set = route.match(/^\/set\/([\w-]+)(\/export)?$/)
  if (set) return { name: 'set', setId: set[1], tab: set[2] ? 'export' : 'review' }
  if (route === '/library') return { name: 'library' }
  if (route === '/settings') return { name: 'settings', section: 'engine' }
  if (route === '/settings/data') return { name: 'settings', section: 'data' }
  return { name: 'create', sourceId: route.match(/^\/new\/([\w-]+)$/)?.[1] }
}

export default function App({ updateReady, applyUpdate }: { updateReady: boolean; applyUpdate: () => void }) {
  const route = useRoute()
  const page = pageFor(route)
  const generation = useGeneration()
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const [navOpen, setNavOpen] = useState(false)
  const [navRoute, setNavRoute] = useState(route)
  const narrow = useNarrowLayout()
  const main = useRef<HTMLElement>(null)
  const shownRoute = useRef(route)

  // Choosing a destination closes the narrow-screen menu.
  if (navRoute !== route) {
    setNavRoute(route)
    setNavOpen(false)
  }

  // The menu also closes if the window widens, or the text shrinks, to the
  // two-column layout (where the content must not stay inert).
  if (navOpen && !narrow) setNavOpen(false)

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as InstallPromptEvent)
    }
    const onOnline = () => setOnline(navigator.onLine)
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOnline)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOnline)
    }
  }, [])

  // A new destination starts at the top, with focus on the new view unless
  // the view already focused one of its own fields.
  useEffect(() => {
    if (shownRoute.current === route) return
    shownRoute.current = route
    window.scrollTo(0, 0)
    if (!main.current?.contains(document.activeElement)) main.current?.focus({ preventScroll: true })
  }, [route])

  // The narrow-screen menu closes with Escape.
  useEffect(() => {
    if (!navOpen) return
    const close = (event: KeyboardEvent) => event.key === 'Escape' && setNavOpen(false)
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [navOpen])

  // Warn before closing mid-generation; finished questions are already saved.
  useEffect(() => {
    if (!generation.running) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [generation.running])

  let view
  if (page.name === 'set') view = <SetView key={page.setId} setId={page.setId} tab={page.tab} />
  else if (page.name === 'library') view = <Library />
  else if (page.name === 'settings') view = <Settings section={page.section} />
  else view = <Create key={page.sourceId ?? 'new'} sourceId={page.sourceId} />

  const watchingRun = page.name === 'set' && page.setId === generation.setId

  return (
    <div className="shell">
      <a
        className="skip"
        href="#main"
        onClick={(event) => {
          event.preventDefault()
          main.current?.focus()
        }}
      >
        Skip to content
      </a>
      <div className="topbar">
        <Brand />
        <button type="button" aria-expanded={navOpen} aria-controls="sidebar" onClick={() => setNavOpen(!navOpen)}>
          <Icon name="menu" /> Menu
        </button>
      </div>
      {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}
      <header id="sidebar" className={`sidebar ${navOpen ? 'open' : ''}`}>
        <Brand />
        <nav aria-label="Main" className="nav">
          <a href="#/" aria-current={page.name === 'create' ? 'page' : undefined}>
            <Icon name="plus" /> New question set
          </a>
          <a
            href="#/library"
            aria-current={page.name === 'library' ? 'page' : undefined}
            className={page.name === 'set' ? 'ancestor' : undefined}
          >
            <Icon name="list" /> Question sets
          </a>
          {page.name === 'set' && <SetNav setId={page.setId} tab={page.tab} />}
          <a href="#/settings" className={page.name === 'settings' ? 'ancestor' : undefined}>
            <Icon name="sliders" /> Settings
          </a>
          {page.name === 'settings' && (
            <div className="subnav">
              <a href="#/settings" aria-current={page.section === 'engine' ? 'page' : undefined}>
                AI engine
              </a>
              <a href="#/settings/data" aria-current={page.section === 'data' ? 'page' : undefined}>
                Data and backup
              </a>
            </div>
          )}
        </nav>
        {generation.running && !watchingRun && <RunStatus />}
        <div className="sidebar-foot">
          <EngineStatus />
          <ThemeSwitch />
          <TextSize />
          {installPrompt && (
            <button type="button" onClick={() => installPrompt.prompt().then(() => setInstallPrompt(null))}>
              Install app
            </button>
          )}
          <p className="fine">
            Content from <a href="https://libretexts.org">LibreTexts</a> keeps its original license. Review generated
            questions before use.
          </p>
        </div>
      </header>
      <div className="workspace" inert={navOpen}>
        {!online && (
          <p className="banner">
            You are offline. Saved sets and exports still work. Generating needs a connection, unless the in-browser model
            is loaded and the source is already saved.
          </p>
        )}
        {updateReady && (
          <p className="banner">
            A new version is available.{' '}
            <button type="button" className="link" onClick={applyUpdate}>
              Reload to update
            </button>
          </p>
        )}
        {generation.running && !watchingRun && (
          <p className="banner narrow-only" role="status">
            Writing questions: {generation.done} of {generation.total}.{' '}
            <a href={`#/set/${generation.setId}`}>View</a>
          </p>
        )}
        <main id="main" ref={main} tabIndex={-1}>
          {view}
        </main>
      </div>
    </div>
  )
}

function Brand() {
  return (
    <a href="#/" className="brand">
      <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={36} height={36} />
      <span>
        <small>LibreTexts</small>
        <strong>Question Studio</strong>
      </span>
    </a>
  )
}

function SetNav({ setId, tab }: { setId: string; tab: 'review' | 'export' }) {
  const set = useLiveQuery(() => db.sets.get(setId), [setId])
  const toReview = useLiveQuery(
    () => db.items.where('setId').equals(setId).filter((item) => item.status === 'draft').count(),
    [setId],
  )
  if (!set) return null
  return (
    <div className="subnav">
      <span className="subnav-label" title={set.title}>
        {set.title}
      </span>
      <a href={`#/set/${setId}`} aria-current={tab === 'review' ? 'page' : undefined}>
        Review questions
        {!!toReview && (
          <span className="count">
            <span className="sr-only">(</span>
            {toReview}
            <span className="sr-only"> need review)</span>
          </span>
        )}
      </a>
      <a href={`#/set/${setId}/export`} aria-current={tab === 'export' ? 'page' : undefined}>
        Export to ADAPT
      </a>
    </div>
  )
}

function RunStatus() {
  const generation = useGeneration()
  return (
    <a href={`#/set/${generation.setId}`} className="run-status">
      <span>
        <strong>Writing questions</strong>
        <span className="fine">
          {generation.done} of {generation.total || '…'} · View
        </span>
      </span>
      <progress max={generation.total || 1} value={generation.done} aria-label="Generation progress" />
    </a>
  )
}

function EngineStatus() {
  const engine = useEngineSettings()
  const loaded = useLoadedLocalModel() === localModelId(engine)
  const key = useSessionKey()
  const [ready, label] =
    engine.provider === 'openai'
      ? [!!key, `OpenAI · ${key ? engine.openaiModel : 'no key'}`]
      : [loaded, `${localModel(engine.localModel).label} · ${loaded ? 'ready' : 'not loaded'}`]
  return (
    <a href="#/settings" className="engine-status">
      <span className={`dot ${ready ? 'ready' : 'waiting'}`} aria-hidden="true" />
      <span>
        <span className="fine">AI engine</span>
        {label}
      </span>
    </a>
  )
}

function ThemeSwitch() {
  const dark = useTheme() === 'dark'
  return (
    <button type="button" role="switch" aria-checked={dark} className="theme-switch" onClick={() => setTheme(dark ? 'light' : 'dark')}>
      <Icon name="moon" />
      Dark mode
      <span className="track" aria-hidden="true">
        <span className="thumb" />
      </span>
    </button>
  )
}

// The slider is the control (arrow keys, or a click anywhere on the track);
// the two A's are a pointer shortcut for one step and are hidden from screen
// readers, which hear the slider's value instead.
function TextSize() {
  const size = useTextSize()
  const index = TEXT_SIZES.indexOf(size)
  const percent = `${Math.round(size * 100)}%`
  const step = (by: number) => {
    const next = TEXT_SIZES[index + by]
    if (next) setTextSize(next)
  }
  return (
    <div className="text-size">
      <div className="text-size-head">
        <label htmlFor="text-size">Text size</label>
        <span aria-hidden="true">{percent}</span>
      </div>
      <div className="text-size-row">
        <span className="text-size-a smaller" aria-hidden="true" onClick={() => step(-1)}>
          A
        </span>
        <input
          id="text-size"
          type="range"
          min={0}
          max={TEXT_SIZES.length - 1}
          step={1}
          value={index}
          aria-valuetext={percent}
          onChange={(event) => setTextSize(TEXT_SIZES[Number(event.target.value)])}
          style={{ '--fill': `${(index / (TEXT_SIZES.length - 1)) * 100}%` } as CSSProperties}
        />
        <span className="text-size-a larger" aria-hidden="true" onClick={() => step(1)}>
          A
        </span>
      </div>
    </div>
  )
}
