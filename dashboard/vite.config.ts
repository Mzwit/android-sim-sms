import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API runs on :8443 and Vite proxies /api to it (same-origin cookies).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8443', '/docs': 'http://127.0.0.1:8443' } },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 800 },
});
