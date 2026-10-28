import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/healthz': {
        target: process.env.API_TARGET ?? 'http://127.0.0.1:3088',
        changeOrigin: false,
      },
      '/api': {
        target: process.env.API_TARGET ?? 'http://127.0.0.1:3088',
        changeOrigin: false,
      },
    },
  },
});
