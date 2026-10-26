import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm'

// Inference runs here so the UI thread stays responsive during generation.
const handler = new WebWorkerMLCEngineHandler()
self.onmessage = (message: MessageEvent) => handler.onmessage(message)

// Sent when WebGPU loses the device the model runs on.
export interface GpuLostMessage {
  kind: 'gpuLost'
  message: string
}

// Tells the page when WebGPU loses the device (a driver reset, the GPU process
// restarting), so the model stops counting as loaded even when the loss comes
// between runs. WebLLM only logs it, so every device it asks for is watched.
// A device destroyed on purpose is not a loss.
if (typeof GPUAdapter !== 'undefined') {
  const requestDevice = GPUAdapter.prototype.requestDevice
  GPUAdapter.prototype.requestDevice = async function (this: GPUAdapter, ...args) {
    const device = await requestDevice.apply(this, args)
    void device.lost.then((info) => {
      if (info.reason === 'destroyed') return
      const lost: GpuLostMessage = { kind: 'gpuLost', message: info.message || 'The GPU device was lost.' }
      self.postMessage(lost)
    })
    return device
  }
}
