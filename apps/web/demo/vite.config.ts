import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Static demo build: no service worker, hash routes, relative asset paths, API answered in the browser (shim.ts).
const require = createRequire(import.meta.url), rr = createRequire(require.resolve('react-router-dom')).resolve('react-router');
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  publicDir: '../public',
  plugins: [react(), {
    name: 'demo-signout',
    transform: (code, id) => (id.endsWith('/src/auth.ts') ? code.replace("location.assign('/')", "(location.hash = '#/', location.reload())") : undefined),
  }],
  resolve: { alias: [{ find: /^react-router-dom$/, replacement: fileURLToPath(new URL('./router.ts', import.meta.url)) }, { find: /^react-router$/, replacement: rr }] },
  build: { outDir: '../dist-demo', emptyOutDir: true },
});
