import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import headers from './security-headers.json';

// In production CloudFront serves the build and routes /api/* to the API, so the app always calls same-origin /api.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Fieldtrack', short_name: 'Fieldtrack', description: 'BCBA fieldwork hour tracker',
        theme_color: '#0b0b0b', background_color: '#ffffff', display: 'standalone', start_url: '/app',
        icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }],
      },
      // Cache the app shell only. API responses are cached by the app itself (IndexedDB), never by the service worker.
      workbox: { navigateFallback: '/index.html', navigateFallbackDenylist: [/^\/api\//], globPatterns: ['**/*.{js,css,html,svg,png}'] },
    }),
  ],
  server: { proxy: { '/api': 'http://localhost:3000' } },
  // Same security headers as CloudFront (minus HSTS on plain http), so e2e tests catch anything the policy would break.
  preview: {
    proxy: { '/api': 'http://localhost:3000' },
    headers: {
      'Content-Security-Policy': headers.csp.join('; ').replace(' {connect}', '').replace(' {auth}', ''),
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Referrer-Policy': headers.referrerPolicy, 'Permissions-Policy': headers.permissionsPolicy,
    },
  },
});
