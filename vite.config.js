// vite.config.js (ESM)
import { defineConfig } from 'vite';
import fs from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname; // adjust if your html files live elsewhere

export default defineConfig({
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
        licenses: resolve(root, 'licenses.html'),
        randomTests: resolve(root, 'offsetSurfaceMeshTest.html'),
      },
    },
  },
});
