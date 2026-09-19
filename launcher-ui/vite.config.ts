import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const sourceDir = resolve(currentDir, '../src');
const archiveDir = resolve(currentDir, '../assets');

/**
 * Dev/preview-only mirrors of the deployment-relative files the launcher
 * fetches while it runs: the TiddlyWiki engine, and the frozen legacy launcher
 * kept for side-by-side parity checks.
 */
function legacySourcePlugin(): Plugin {
  const files: Record<string, { path: string; contentType: string }> = {
    '/legacy-launcher.html': { path: resolve(archiveDir, 'legacy-launcher.html'), contentType: 'text/html; charset=utf-8' },
    '/src/lithic.html': { path: resolve(sourceDir, 'lithic.html'), contentType: 'text/html; charset=utf-8' }
  };

  return {
    name: 'serve-legacy-lithic-source',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = request.url?.split('?')[0] ?? '';
        const file = files[pathname];
        if (!file) {
          next();
          return;
        }

        try {
          const contents = await readFile(file.path);
          response.statusCode = 200;
          response.setHeader('Content-Type', file.contentType);
          response.setHeader('Cache-Control', 'no-store');
          response.end(contents);
        } catch (error) {
          next(error);
        }
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = request.url?.split('?')[0] ?? '';
        const file = files[pathname];
        if (!file) {
          next();
          return;
        }

        try {
          const contents = await readFile(file.path);
          response.statusCode = 200;
          response.setHeader('Content-Type', file.contentType);
          response.end(contents);
        } catch (error) {
          next(error);
        }
      });
    }
  };
}

export default defineConfig({
  plugins: [legacySourcePlugin(), svelte({ configFile: false })],
  base: './',
  build: {
    outDir: resolve(currentDir, '../src'),
    emptyOutDir: false,
    assetsInlineLimit: Infinity,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'launcher.js',
        assetFileNames: 'launcher.[ext]'
      }
    }
  }
});
