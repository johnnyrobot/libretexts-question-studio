import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import { PageHeader } from '../components/Page'
import { LOCAL_MODEL, probeWebGPU, useLoadedLocalModel, type GpuSupport } from '../lib/llm/local-models'
import { checkOpenAIKey, OPENAI_MODELS, type ReasoningEffort } from '../lib/llm/openai'
import { createBackup, restoreBackup } from '../lib/storage/backup'
import { db, requestPersistentStorage } from '../lib/storage/db'
import { downloadBlob } from '../lib/qti/export'
import { forgetKey, getSessionKey, hasRememberedKey, rememberKey, setSessionKey } from '../lib/storage/secrets'
import { localModelId, saveEngineSettings, useEngineSettings } from '../state/engine'
import { useGeneration } from '../state/generation'

export type SettingsSection = 'engine' | 'data'

export function Settings({ section }: { section: SettingsSection }) {
  return section === 'data' ? <DataSettings /> : <EngineSettingsPage />
}

function EngineSettingsPage() {
  const engine = useEngineSettings()
  return (
    <>
      <PageHeader title="AI engine" lede="Choose the model that writes your questions." />
      <fieldset className="choice-cards">
        <legend className="sr-only">AI engine</legend>
        <label className="option">
          <input
            type="radio"
            name="provider"
            checked={engine.provider === 'local'}
            onChange={() => saveEngineSettings({ provider: 'local' })}
          />
          <span>
            <strong>In-browser model</strong>
            <span className="muted">Free and private. Textbook text never leaves this device. One-time download.</span>
          </span>
        </label>
        <label className="option">
          <input
            type="radio"
            name="provider"
            checked={engine.provider === 'openai'}
            onChange={() => saveEngineSettings({ provider: 'openai' })}
          />
          <span>
            <strong>OpenAI, with your API key</strong>
            <span className="muted">Highest quality, with GPT-6 Luna. Billed to your OpenAI account.</span>
          </span>
        </label>
      </fieldset>
      <section className="card section-gap">{engine.provider === 'local' ? <LocalSettings /> : <OpenAISettings />}</section>
    </>
  )
}

type WebLLM = typeof import('../lib/llm/local')

function LocalSettings() {
  const engine = useEngineSettings()
  const generation = useGeneration()
  const loadedModel = useLoadedLocalModel()
  const [gpu, setGpu] = useState<GpuSupport | null>(null)
  const [webllm, setWebllm] = useState<WebLLM | null>(null)
  const [info, setInfo] = useState<{ modelId: string; cached: boolean; bytes: number | null } | null>(null)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<{ value: number; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const modelId = localModelId(engine)
  const loaded = loadedModel === modelId

  useEffect(() => {
    probeWebGPU().then(setGpu)
  }, [])

  useEffect(() => {
    if (gpu?.webgpu && gpu.f16 !== engine.localF16) void saveEngineSettings({ localF16: gpu.f16 })
  }, [gpu, engine.localF16])

  useEffect(() => {
    let current = true
    import('../lib/llm/local')
      .then(async (runtime) => {
        if (!current) return
        setWebllm(runtime)
        const [cached, bytes] = await Promise.all([
          runtime.isModelCached(modelId).catch(() => false),
          runtime.downloadBytes(modelId),
        ])
        if (current) setInfo({ modelId, cached, bytes })
      })
      .catch((e) => current && setError(`Could not load the model runtime: ${e.message}`))
    return () => {
      current = false
    }
  }, [modelId])

  const status = info?.modelId === modelId ? info : null
  const vramMB = webllm?.vramRequiredMB(modelId) ?? null

  const load = async () => {
    if (!webllm) return
    setError(null)
    setLoading(true)
    await requestPersistentStorage()
    try {
      await webllm.loadLocalModel(modelId, (report) => setProgress({ value: report.progress, text: report.text }))
      setInfo({ modelId, cached: true, bytes: status?.bytes ?? null })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
      setProgress(null)
    }
  }

  return (
    <>
      <h2>{LOCAL_MODEL.label}</h2>
      {gpu && !gpu.webgpu && <p className="error">{gpu.reason}</p>}
      {gpu?.webgpu && !gpu.f16 && (
        <p className="notice">This GPU lacks 16-bit shader support, so the larger 32-bit build of the model is used.</p>
      )}
      <dl className="facts">
        <dt>Status</dt>
        <dd>
          {loaded ? (
            <span className="status approved">
              <Icon name="check" size={18} /> Loaded and ready
            </span>
          ) : !status ? (
            'Checking…'
          ) : status.cached ? (
            'Downloaded, not loaded'
          ) : (
            'Not downloaded'
          )}
        </dd>
        {!!status && !status.cached && !!status.bytes && (
          <>
            <dt>Download</dt>
            <dd>{formatBytes(status.bytes)}, once</dd>
          </>
        )}
        {!!vramMB && (
          <>
            <dt>GPU memory</dt>
            <dd>About {(vramMB / 1024).toFixed(1)} GB</dd>
          </>
        )}
        <dt>License</dt>
        <dd>{LOCAL_MODEL.license}</dd>
      </dl>
      {progress && (
        <div aria-live="polite" className="mt">
          <progress max={1} value={progress.value} aria-label="Model loading progress" />
          <p className="fine">{progress.text}</p>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        {!loaded && (
          <button type="button" className="primary" disabled={loading || !webllm || !gpu?.webgpu} onClick={load}>
            {loading
              ? 'Loading…'
              : status?.cached
                ? 'Load model'
                : `Download and load${status?.bytes ? ` (${formatBytes(status.bytes)})` : ''}`}
          </button>
        )}
        {loaded && webllm && (
          <button type="button" disabled={generation.running} onClick={() => webllm.unloadLocalModel()}>
            Unload (free GPU memory)
          </button>
        )}
        {status?.cached && !loading && webllm && (
          <button
            type="button"
            className="danger-link push-right"
            disabled={generation.running}
            onClick={async () => {
              webllm.unloadLocalModel()
              await webllm.deleteCachedModel(modelId)
              setInfo({ modelId, cached: false, bytes: status.bytes })
            }}
          >
            Delete downloaded model
          </button>
        )}
      </div>
      <p className="fine mt">
        The model downloads from Hugging Face once and stays in this browser. Load it each time you open the app (from disk,
        which is quick). It runs on recent desktop Chrome, Edge, and Safari 26, not on phones. Build: <code>{modelId}</code>
      </p>
    </>
  )
}

function OpenAISettings() {
  const engine = useEngineSettings()
  const [key, setKey] = useState(getSessionKey() ?? '')
  const [remember, setRemember] = useState(false)
  const [remembered, setRemembered] = useState(false)
  const [status, setStatus] = useState<string | null>(getSessionKey() ? 'A key is set for this session.' : null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    hasRememberedKey().then((value) => {
      setRemembered(value)
      setRemember(value)
    })
  }, [])

  const save = async () => {
    setChecking(true)
    const result = await checkOpenAIKey(key.trim())
    setChecking(false)
    setStatus(result.message)
    if (!result.ok) return
    if (remember) {
      await rememberKey(key)
      setRemembered(true)
    } else {
      setSessionKey(key)
      await forgetKey()
      setSessionKey(key)
      setRemembered(false)
    }
  }

  return (
    <>
      <h2>OpenAI</h2>
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label>
          API key
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <small>Create a dedicated project key with a monthly budget.</small>
        </label>
        <label className="inline">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>
            Remember on this device
            <small>Encrypted in this browser’s storage.</small>
          </span>
        </label>
        <div className="actions">
          <button type="submit" className="primary" disabled={!key.trim() || checking}>
            {checking ? 'Checking…' : 'Save and test key'}
          </button>
          {(remembered || getSessionKey()) && (
            <button
              type="button"
              className="danger-link push-right"
              onClick={async () => {
                await forgetKey()
                setKey('')
                setRemembered(false)
                setStatus('Key removed from this browser.')
              }}
            >
              Forget key
            </button>
          )}
        </div>
      </form>
      {status && (
        <p className="notice mt" role="status">
          {status}
        </p>
      )}
      <div className="field-row mt-lg">
        <label>
          Model
          <select value={engine.openaiModel} onChange={(e) => saveEngineSettings({ openaiModel: e.target.value })}>
            {OPENAI_MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reasoning effort
          <select value={engine.effort} onChange={(e) => saveEngineSettings({ effort: e.target.value as ReasoningEffort })}>
            <option value="low">Low (fastest)</option>
            <option value="medium">Medium</option>
            <option value="high">High (recommended)</option>
            <option value="xhigh">Extra high (slowest)</option>
          </select>
        </label>
      </div>
      <p className="fine mt-lg">
        Your key is sent only to api.openai.com, directly from this browser, with <code>store: false</code>. The textbook
        text and prompts go to OpenAI under your account’s data policy (OpenAI keeps abuse-monitoring logs for up to 30
        days).
      </p>
    </>
  )
}

function DataSettings() {
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null)
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [backupStatus, setBackupStatus] = useState<string | null>(null)
  useEffect(() => {
    navigator.storage?.estimate?.().then((e) => setEstimate({ usage: e.usage ?? 0, quota: e.quota ?? 0 }))
    navigator.storage?.persisted?.().then(setPersisted)
  }, [])
  return (
    <>
      <PageHeader title="Data and backup" lede="Question sets, downloads, and saved textbook pages live only in this browser." />
      <section className="section">
        <h2>Storage</h2>
        <p>
          {estimate ? `${formatBytes(estimate.usage)} used of ${formatBytes(estimate.quota)} available.` : '…'}{' '}
          {persisted === true && 'The browser will not clear this data on its own.'}
        </p>
        {persisted === false && (
          <p>
            <button type="button" className="link" onClick={async () => setPersisted(await requestPersistentStorage())}>
              Ask the browser to keep this data
            </button>
          </p>
        )}
        <p className="fine">Install the app (browser menu → Install) so Safari does not clear it after a week without use.</p>
      </section>
      <section className="section">
        <h2>Backup</h2>
        <p className="muted">
          Move your question sets to another browser or computer, or keep a copy. The backup is a JSON file with your pages
          and questions, not your API key.
        </p>
        <div className="actions">
          <button
            type="button"
            onClick={async () =>
              downloadBlob(await createBackup(), `question-studio-backup-${new Date().toISOString().slice(0, 10)}.json`)
            }
          >
            <Icon name="download" /> Download backup
          </button>
          <label className="file-button">
            Restore from backup
            <input
              type="file"
              accept="application/json,.json"
              onChange={async (e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (!file) return
                try {
                  const result = await restoreBackup(file)
                  setBackupStatus(`Restored ${result.sets} set(s) and ${result.items} question(s).`)
                } catch (error) {
                  setBackupStatus(error instanceof Error ? error.message : String(error))
                }
              }}
            />
          </label>
        </div>
        {backupStatus && (
          <p className="notice mt" role="status">
            {backupStatus}
          </p>
        )}
      </section>
      <section className="section">
        <h2>Delete everything</h2>
        <p className="muted">Removes every question set, download, and saved page from this browser.</p>
        <button
          type="button"
          className="danger"
          onClick={async () => {
            if (!confirm('Delete every question set, export, and cached page from this browser?')) return
            await Promise.all([db.items.clear(), db.sets.clear(), db.sources.clear(), db.exports.clear(), db.pages.clear()])
          }}
        >
          Delete all question sets and saved pages
        </button>
      </section>
    </>
  )
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}
