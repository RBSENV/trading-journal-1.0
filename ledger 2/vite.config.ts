import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Ledger — Trading Journal',
        short_name: 'Ledger',
        description: 'Private trading journal',
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0B1017',
        theme_color: '#0B1017',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
        ]
      },
      workbox: {
        // App shell only. Trade data is never cached by the service worker —
        // that is the sync layer's job, and mixing the two loses records.
        globPatterns: ['**/*.{js,css,html,svg}'],
        navigateFallback: '/index.html',
        runtimeCaching: [{
          urlPattern: ({ url }) => url.pathname.startsWith('/rest/'),
          handler: 'NetworkOnly'
        }]
      }
    })
  ],
  build: { target: 'es2022', sourcemap: true }
})
