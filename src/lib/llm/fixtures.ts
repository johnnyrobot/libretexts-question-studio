// What the Transformers.js worker reported when Windows lost the GPU under
// Gemma 4 E4B during a second generation in one session (LT-60, 2026-10-25),
// as the instructor's console showed it.
export const DEVICE_LOST_ERROR =
  'failed to call OrtRun(). ERROR_CODE: 1, ERROR_MESSAGE: /mnt/azure_nvme_temp/_work/1/s/onnxruntime/core/providers/webgpu/buffer_manager.cc:643 ' +
  'void onnxruntime::webgpu::BufferManager::Download(WGPUBuffer, void *, size_t) const map_async_result.status == wgpu::MapAsyncStatus::Success was false. ' +
  "Failed to download data from buffer. wgpu::MapAsyncStatus value: 4, message: Failed to execute 'mapAsync' on 'GPUBuffer': [Device] is lost."

// What WebLLM 0.2.85 reported when Chrome's GPU process crashed under a
// loaded model (LT-62, reproduced in Chrome for Testing 155 on Apple silicon
// with the DevTools command Browser.crashGpuProcess). The device's lost
// message, then what its worker sent back for the call the crash interrupted
// and for every call after it: plain strings, not Errors.
export const WEBGPU_LOST_MESSAGE = 'A valid external Instance reference no longer exists.'
export const WEBLLM_INTERRUPTED_ERROR = 'Error: Object has already been disposed'
export const WEBLLM_DISPOSED_ERROR = 'Error: The current Object has already been disposed'
// What it sent back after the device was destroyed instead.
export const WEBLLM_NOT_LOADED_ERROR =
  'ModelNotLoadedError: Model not loaded before trying to complete ChatCompletionRequest. Please ensure you have called ' +
  'MLCEngine.reload(model) to load the model before initiating APIs, or initialize your engine using CreateMLCEngine() ' +
  'with a valid model configuration.'
