import { useEffect, useState } from 'react'
import { localModelLabel, useLoadedLocalModel } from './lib/llm/local-models'
import { getSessionKey } from './lib/storage/secrets'
import { useRoute } from './router'
import { useEngineSettings } from './state/engine'
import { useGeneration } from './state/generation'
import { Create } from './views/Create'
import { Library } from './views/Library'
import { SetView } from './views/SetView'
import { Settings } from './views/Settings'

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
}

export default function App({ updateReady, applyUpdate }: { updateReady: boolean; applyUpdate: () => void }) {
  const route = useRoute()
  const generation = useGeneration()
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)
  const [online, setOnline] = useState(navigator.onLine)

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

  // Warn before closing mid-generation; finished questions are already saved.
  useEffect(() => {
    if (!generation.running) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [generation.running])

  const setMatch = route.match(/^\/set\/([\w-]+)$/)
  const newMatch = route.match(/^\/new\/([\w-]+)$/)
  let view
  if (setMatch) view = <SetView setId={setMatch[1]} />
  else if (route === '/library') view = <Library />
  else if (route === '/settings') view = <Settings />
  else view = <Create key={newMatch?.[1] ?? 'new'} reuseSourceId={newMatch?.[1]} />

  const section = setMatch || route === '/library' ? 'library' : route === '/settings' ? 'settings' : 'create'

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <a href="#/" className="brand">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={28} height={28} />
          <span>
            LibreTexts <strong>Question Studio</strong>
          </span>
        </a>
        <nav aria-label="Main">
          <a href="#/" aria-current={section === 'create' ? 'page' : undefined}>
            Create
          </a>
          <a href="#/library" aria-current={section === 'library' ? 'page' : undefined}>
            Library
          </a>
          <a href="#/settings" aria-current={section === 'settings' ? 'page' : undefined}>
            Settings
          </a>
        </nav>
        <div className="header-status">
          <EngineStatus />
          {installPrompt && (
            <button type="button" onClick={() => installPrompt.prompt().then(() => setInstallPrompt(null))}>
              Install app
            </button>
          )}
        </div>
      </header>
      {!online && <div className="banner">You are offline. Saved sets and exports still work; generating needs a connection unless the in-browser model is loaded and the source is already cached.</div>}
      {updateReady && (
        <div className="banner">
          A new version is available.{' '}
          <button type="button" className="link" onClick={applyUpdate}>
            Reload to update
          </button>
        </div>
      )}
      {generation.running && setMatch?.[1] !== generation.setId && (
        <div className="banner">
          Generating: {generation.status} ({generation.done}/{generation.total}){' '}
          <a href={`#/set/${generation.setId}`}>View</a>
        </div>
      )}
      <main id="main">{view}</main>
      <footer className="app-footer">
        Content from <a href="https://libretexts.org">LibreTexts</a> remains under its original license. Generated questions
        need instructor review before use.
      </footer>
    </>
  )
}

function EngineStatus() {
  const engine = useEngineSettings()
  const loaded = useLoadedLocalModel()
  if (engine.provider === 'openai') {
    return <a href="#/settings" className={`pill ${getSessionKey() ? 'ready' : 'warn'}`}>{getSessionKey() ? `OpenAI · ${engine.openaiModel}` : 'OpenAI · no key'}</a>
  }
  return <a href="#/settings" className={`pill ${loaded ? 'ready' : 'warn'}`}>{loaded ? `In-browser · ${localModelLabel(loaded)}` : 'In-browser · not loaded'}</a>
}
