import { useEffect, useState } from 'react'
import {
  LOCAL_MODELS,
  probeWebGPU,
  useLoadedLocalModel,
  type GpuSupport,
  type LocalModelInfo,
  type LocalModelKey,
} from '../lib/llm/local-models'
import { checkOpenAIKey, OPENAI_MODELS, type ReasoningEffort } from '../lib/llm/openai'
import { createBackup, restoreBackup } from '../lib/storage/backup'
import { db, requestPersistentStorage } from '../lib/storage/db'
import { downloadBlob } from '../lib/qti/export'
import { forgetKey, getSessionKey, hasRememberedKey, rememberKey, setSessionKey } from '../lib/storage/secrets'
import { localModelId, saveEngineSettings, useEngineSettings } from '../state/engine'
import { useGeneration } from '../state/generation'

export function Settings() {
  const engine = useEngineSettings()
  return (
    <div className="page">
      <h1>Settings</h1>
      <section className="card">
        <h2>AI engine</h2>
        <div className="engine-choice">
          <label className={`option ${engine.provider === 'local' ? 'selected' : ''}`}>
            <input
              type="radio"
              name="provider"
              checked={engine.provider === 'local'}
              onChange={() => saveEngineSettings({ provider: 'local' })}
            />
            <span>
              <strong>In-browser model</strong>
              <span className="muted">Free and private: textbook text never leaves this device. One-time model download.</span>
            </span>
          </label>
          <label className={`option ${engine.provider === 'openai' ? 'selected' : ''}`}>
            <input
              type="radio"
              name="provider"
              checked={engine.provider === 'openai'}
              onChange={() => saveEngineSettings({ provider: 'openai' })}
            />
            <span>
              <strong>OpenAI (your API key)</strong>
              <span className="muted">Highest quality with GPT-6 Luna. Billed to your OpenAI account.</span>
            </span>
          </label>
        </div>
      </section>
      {engine.provider === 'local' ? <LocalSettings /> : <OpenAISettings />}
      <StorageSettings />
    </div>
  )
}

// One shape for both runtimes, so the panel does not care which one a model uses.
interface Runtime {
  isCached: () => Promise<boolean>
  downloadBytes: () => Promise<number | null>
  vramMB: () => number | null
  load: (onProgress: (report: { progress: number; text: string }) => void) => Promise<void>
  unload: () => void
  remove: () => Promise<void>
}

async function runtimeFor(info: LocalModelInfo, modelId: string): Promise<Runtime> {
  if (info.runtime === 'gguf') {
    const gguf = await import('../lib/llm/local-gguf')
    return {
      isCached: () => gguf.isGgufCached(info),
      downloadBytes: async () => info.bytes,
      vramMB: () => info.vramMB,
      load: (onProgress) => gguf.loadGgufModel(info, onProgress),
      unload: gguf.unloadGgufModel,
      remove: () => gguf.deleteGgufModel(info),
    }
  }
  const webllm = await import('../lib/llm/local')
  return {
    isCached: () => webllm.isModelCached(modelId),
    downloadBytes: () => webllm.downloadBytes(modelId),
    vramMB: () => webllm.vramRequiredMB(modelId),
    load: (onProgress) => webllm.loadLocalModel(modelId, (r) => onProgress({ progress: r.progress, text: r.text })),
    unload: webllm.unloadLocalModel,
    remove: async () => {
      webllm.unloadLocalModel()
      await webllm.deleteCachedModel(modelId)
    },
  }
}

// Unloading must use the runtime that holds the model, which may differ from
// the one selected now.
async function unloadAll() {
  const [webllm, gguf] = await Promise.all([import('../lib/llm/local'), import('../lib/llm/local-gguf')])
  webllm.unloadLocalModel()
  gguf.unloadGgufModel()
}

function LocalSettings() {
  const engine = useEngineSettings()
  const generation = useGeneration()
  const loadedModel = useLoadedLocalModel()
  const [gpu, setGpu] = useState<GpuSupport | null>(null)
  const [runtime, setRuntime] = useState<{ modelId: string; runtime: Runtime } | null>(null)
  const [info, setInfo] = useState<{ modelId: string; cached: boolean; bytes: number | null } | null>(null)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<{ value: number; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const model = LOCAL_MODELS[engine.localModel]
  const modelId = localModelId(engine)
  const loaded = loadedModel === modelId
  const needsWebGPU = model.runtime === 'webllm'

  useEffect(() => {
    probeWebGPU().then(setGpu)
  }, [])

  useEffect(() => {
    if (gpu?.webgpu && gpu.f16 !== engine.localF16) void saveEngineSettings({ localF16: gpu.f16 })
  }, [gpu, engine.localF16])

  useEffect(() => {
    let current = true
    runtimeFor(model, modelId)
      .then(async (rt) => {
        if (!current) return
        setRuntime({ modelId, runtime: rt })
        const [cached, bytes] = await Promise.all([rt.isCached().catch(() => false), rt.downloadBytes()])
        if (current) setInfo({ modelId, cached, bytes })
      })
      .catch((e) => current && setError(`Could not load the model runtime: ${e.message}`))
    return () => {
      current = false
    }
  }, [model, modelId])

  const active = runtime?.modelId === modelId ? runtime.runtime : null
  const status = info?.modelId === modelId ? info : null

  const load = async () => {
    if (!active) return
    setError(null)
    setLoading(true)
    await requestPersistentStorage()
    try {
      await unloadAll()
      await active.load((report) => setProgress({ value: report.progress, text: report.text }))
      setInfo({ modelId, cached: true, bytes: status?.bytes ?? null })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
      setProgress(null)
    }
  }

  return (
    <section className="card">
      <h2>In-browser model</h2>
      {gpu && !gpu.webgpu && (
        <p className="error">
          {gpu.reason} MiniCPM5 can still run on the CPU, but expect minutes per question.
        </p>
      )}
      {gpu?.webgpu && !gpu.f16 && (
        <p className="notice">This GPU lacks 16-bit shader support, so the larger 32-bit Qwen builds are used.</p>
      )}
      <fieldset disabled={loading || generation.running}>
        <legend>Model</legend>
        {(Object.keys(LOCAL_MODELS) as LocalModelKey[]).map((key) => {
          const option = LOCAL_MODELS[key]
          return (
            <label key={key} className={`option ${engine.localModel === key ? 'selected' : ''}`}>
              <input
                type="radio"
                name="local-model"
                checked={engine.localModel === key}
                onChange={() => saveEngineSettings({ localModel: key })}
              />
              <span>
                <strong>
                  {option.label}
                  {key === 'qwen3.5-4b' && ' (recommended)'}
                </strong>
                <span className="muted">
                  {option.note} {option.license}.
                </span>
              </span>
            </label>
          )
        })}
      </fieldset>
      <p>
        <code>{modelId}</code> ·{' '}
        {!status
          ? 'checking…'
          : status.cached
            ? 'downloaded'
            : status.bytes
              ? `${formatBytes(status.bytes)} download`
              : 'not downloaded'}
        {active?.vramMB() ? ` · needs about ${((active.vramMB() ?? 0) / 1024).toFixed(1)} GB of GPU memory` : ''}
        {loaded && ' · loaded and ready'}
      </p>
      {progress && (
        <div aria-live="polite">
          <progress max={1} value={progress.value} />
          <p className="muted">{progress.text}</p>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <div className="actions">
        {!loaded && (
          <button
            type="button"
            className="primary"
            disabled={loading || !active || (needsWebGPU && !gpu?.webgpu)}
            onClick={load}
          >
            {loading
              ? 'Loading…'
              : status?.cached
                ? 'Load model'
                : `Download and load${status?.bytes ? ` (${formatBytes(status.bytes)})` : ''}`}
          </button>
        )}
        {loaded && active && (
          <button type="button" disabled={generation.running} onClick={() => active.unload()}>
            Unload (free GPU memory)
          </button>
        )}
        {status?.cached && !loading && active && (
          <button
            type="button"
            className="danger-link"
            disabled={generation.running}
            onClick={async () => {
              await active.remove()
              setInfo({ modelId, cached: false, bytes: status.bytes })
            }}
          >
            Delete downloaded model
          </button>
        )}
      </div>
      <p className="fine">
        Models download from Hugging Face once and stay in this browser. They must be loaded again each time the app is
        opened (from disk, which is quick). Qwen3.5 runs on WebLLM; MiniCPM5 runs on wllama (llama.cpp). Works in recent
        Chrome, Edge, and Safari 26 on desktop; phones are not supported.
      </p>
    </section>
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
    <section className="card">
      <h2>OpenAI</h2>
      <form
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
        </label>
        <label className="inline">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember on this device
          (encrypted in this browser’s storage)
        </label>
        <div className="actions">
          <button type="submit" className="primary" disabled={!key.trim() || checking}>
            {checking ? 'Checking…' : 'Save and test key'}
          </button>
          {(remembered || getSessionKey()) && (
            <button
              type="button"
              className="danger-link"
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
      {status && <p className="notice">{status}</p>}
      <div className="row">
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
      <p className="fine">
        Your key is sent only to api.openai.com, directly from this browser, with <code>store: false</code>. The selected
        textbook text and prompts go to OpenAI under your account’s data policy (OpenAI keeps abuse-monitoring logs for up
        to 30 days). For safety, create a dedicated project key with a monthly budget.
      </p>
    </section>
  )
}

function StorageSettings() {
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null)
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [backupStatus, setBackupStatus] = useState<string | null>(null)
  useEffect(() => {
    navigator.storage?.estimate?.().then((e) => setEstimate({ usage: e.usage ?? 0, quota: e.quota ?? 0 }))
    navigator.storage?.persisted?.().then(setPersisted)
  }, [])
  return (
    <section className="card">
      <h2>Storage</h2>
      <p>
        {estimate ? `${formatBytes(estimate.usage)} used of ${formatBytes(estimate.quota)} available to this app.` : '…'}{' '}
        {persisted === true && 'Storage is persistent (the browser will not clear it automatically).'}
        {persisted === false && (
          <button
            type="button"
            className="link"
            onClick={async () => setPersisted(await requestPersistentStorage())}
          >
            Ask the browser to keep this data
          </button>
        )}
      </p>
      <p className="fine">
        Question sets, exports, and cached textbook pages live in this browser only. Install the app (browser menu → Install)
        so Safari does not clear it after a week of inactivity.
      </p>
      <h3>Backup</h3>
      <p className="fine">
        Move your question sets to another browser or computer, or keep a copy. The backup is a JSON file with your sources and
        questions (not your API key).
      </p>
      <div className="actions">
        <button
          type="button"
          onClick={async () =>
            downloadBlob(await createBackup(), `question-studio-backup-${new Date().toISOString().slice(0, 10)}.json`)
          }
        >
          Download backup
        </button>
        <label className="inline file-button">
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
      {backupStatus && <p className="notice">{backupStatus}</p>}
      <h3>Reset</h3>
      <button
        type="button"
        className="danger-link"
        onClick={async () => {
          if (!confirm('Delete every question set, export, and cached page from this browser?')) return
          await Promise.all([db.items.clear(), db.sets.clear(), db.sources.clear(), db.exports.clear(), db.pages.clear()])
        }}
      >
        Delete all question sets and cached pages
      </button>
    </section>
  )
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}
