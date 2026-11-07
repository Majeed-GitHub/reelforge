import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

/**
 * Reelforge dashboard.
 *
 * In dev, Vite serves the SPA at / and proxies /api to the API process, so the
 * API client can always use relative URLs (no CORS, no base-URL config).
 * In build, assets are emitted under /app/ because the API mounts
 * packages/web/dist at http://127.0.0.1:4400/app. Routing is hash-based, so no
 * history fallback is required from the server.
 */
export default defineConfig(({ command }) => ({
  root: here,
  base: command === 'build' ? '/app/' : '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@core': path.resolve(repoRoot, 'packages', 'core', 'src', 'index.ts')
    }
  },
  server: {
    port: 4401,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4400',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    reportCompressedSize: true
  }
}));
