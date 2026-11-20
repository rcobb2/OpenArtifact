import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Code Apps are served as a normal static bundle (unlike Apps Script, no
// single-file inlining needed). `base: './'` keeps asset paths relative so the
// bundle works wherever Power Apps mounts it.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { target: 'es2020', outDir: 'dist' },
  server: { port: 3000 },
});
