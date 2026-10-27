import { StrictMode, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App.tsx'
import { loadRememberedKey } from './lib/storage/secrets'
import { pageLinkAddress } from './router'
import { markInterruptedSets } from './state/generation'
import './styles.css'

// The service worker reports a waiting update once; remember it until the
// React tree subscribes.
let updateWaiting = false
const updateListeners = new Set<() => void>()
const updateServiceWorker = registerSW({
  onNeedRefresh: () => {
    updateWaiting = true
    updateListeners.forEach((listener) => listener())
  },
})

// eslint-disable-next-line react/only-export-components -- the entry module is never hot-swapped
function Root() {
  const updateReady = useSyncExternalStore(
    (listener) => {
      updateListeners.add(listener)
      return () => updateListeners.delete(listener)
    },
    () => updateWaiting,
  )
  return <App updateReady={updateReady} applyUpdate={() => updateServiceWorker(true)} />
}

await Promise.all([markInterruptedSets(), loadRememberedKey()]).catch(() => undefined)

// A link such as ?page=human-378488 opens Create on that page. The query leaves
// the address bar, and the page link wins over any route in the hash.
const pageLinkTarget = pageLinkAddress(location.href)
if (pageLinkTarget) history.replaceState(null, '', pageLinkTarget)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
