/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'LibreTexts Question Studio',
        short_name: 'Question Studio',
        description:
          'Generate ADAPT-ready QTI question banks from LibreTexts textbooks, entirely in your browser.',
        theme_color: '#127bc4',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: './',
        scope: './',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        // catalog.json is the bundled LibreTexts book catalog: precaching it
        // lets instructors browse books offline.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,json}'],
        // The in-browser model runtime (WebLLM, ~6 MB per chunk) is only needed
        // by people who use it, so it is cached on first use instead of being
        // precached for everyone.
        globIgnores: ['**/local-*.js', '**/local.worker-*.js'],
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            // Hashed build assets never change, so cache-first is safe.
            urlPattern: ({ sameOrigin, url }) => sameOrigin && url.pathname.includes('/assets/'),
            handler: 'CacheFirst',
            options: { cacheName: 'app-assets', expiration: { maxEntries: 40 } },
          },
          // Model weights are cached by WebLLM itself (Cache API); LibreTexts and
          // OpenAI requests always go to the network.
        ],
      },
    }),
  ],
  worker: { format: 'es' },
  test: {
    environment: 'node',
  },
})
