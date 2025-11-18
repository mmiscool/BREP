// vite.config.js (ESM)
import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname; // adjust if your html files live elsewhere

const htmlEntries = {
  main: resolve(root, 'index.html'),
  about: resolve(root, 'about.html'),
  featureDialogs: resolve(root, 'feature-dialog-capture.html'),
  pmiDialogs: resolve(root, 'pmi-dialog-capture.html'),
  assemblyConstraintDialogs: resolve(root, 'assembly-constraint-capture.html'),
};

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
      input: htmlEntries,
    },
  },
});
