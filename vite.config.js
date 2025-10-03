// vite.config.js (ESM)
import { defineConfig } from 'vite';
import fs from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname; // adjust if your html files live elsewhere

export default defineConfig({
  // Explicitly set the public directory to ensure generated docs are included
  publicDir: 'public',
  esbuild: {
    keepNames: true,
  },
  build: {
    minify: 'esbuild',
    terserOptions: {
      keep_fnames: true,
    },
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        randomTests: resolve(root, 'offsetSurfaceMeshTest.html'),
        // Note: docs are served as static files from public/docs
      },
    },
  },
});
