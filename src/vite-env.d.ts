/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />
/// <reference types="@webgpu/types" />

interface ImportMetaEnv {
  // A local mirror of the site's /models/ folder, for development (LT-237).
  readonly VITE_MODEL_BASE?: string
}
