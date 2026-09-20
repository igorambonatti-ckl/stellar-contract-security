import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single-file build: the report is published as an artifact behind a CSP that
// blocks every external host, so the JS and CSS have to be inlined rather than
// loaded as sibling assets.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  base: './',
  build: { outDir: 'dist', assetsInlineLimit: 100000000, cssCodeSplit: false },
});
