import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [svelte()],
  base: './',
  build: {
    outDir: resolve(__dirname, '../src'),
    emptyOutDir: false,
    assetsInlineLimit: Infinity,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'pre-launcher.js',
        assetFileNames: 'pre-launcher.[ext]'
      }
    }
  }
});
