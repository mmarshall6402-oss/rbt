import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In production CloudFront serves the build and routes /api/* to the API, so the app always calls same-origin /api.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
