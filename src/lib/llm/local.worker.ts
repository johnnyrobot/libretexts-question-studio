import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm'

// Inference runs here so the UI thread stays responsive during generation.
const handler = new WebWorkerMLCEngineHandler()
self.onmessage = (message: MessageEvent) => handler.onmessage(message)
