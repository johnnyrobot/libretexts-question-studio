// What the Transformers.js worker reported when Windows lost the GPU under
// Gemma 4 E4B during a second generation in one session (LT-60, 2026-10-25),
// as the instructor's console showed it.
export const DEVICE_LOST_ERROR =
  'failed to call OrtRun(). ERROR_CODE: 1, ERROR_MESSAGE: /mnt/azure_nvme_temp/_work/1/s/onnxruntime/core/providers/webgpu/buffer_manager.cc:643 ' +
  'void onnxruntime::webgpu::BufferManager::Download(WGPUBuffer, void *, size_t) const map_async_result.status == wgpu::MapAsyncStatus::Success was false. ' +
  "Failed to download data from buffer. wgpu::MapAsyncStatus value: 4, message: Failed to execute 'mapAsync' on 'GPUBuffer': [Device] is lost."
