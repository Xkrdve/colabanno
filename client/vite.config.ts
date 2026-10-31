import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: { outDir: '../dist/client' },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4000',
      '/uploads': 'http://127.0.0.1:4000',
      '/ws': { target: 'ws://127.0.0.1:4000', ws: true },
    },
  },
});
