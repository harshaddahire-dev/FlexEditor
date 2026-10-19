import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = `http://127.0.0.1:${process.env.CUTROOM_PORT ?? 3001}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API },
      '/ws': { target: API, ws: true },
    },
  },
  build: { target: 'es2022', sourcemap: true },
});
