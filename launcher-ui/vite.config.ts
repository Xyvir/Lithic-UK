import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinSurface, resolveSyncPin } from './src/sync-pin.ts';

const currentDir = dirname(fileURLToPath(import.meta.url));
const sourceDir = resolve(currentDir, '../src');
const archiveDir = resolve(currentDir, '../assets');

/**
 * The sync prongs this build was asked for.
 *
 * `scripts/build-launcher.mjs` reads the flag (`--sync=`) and sets `VITE_LITHIC_SYNC` for
 * this process, so the environment is the single input both halves of the build read: the
 * bundle, through `sync-pin.ts`, and the aliases below.
 *
 * Aliasing is what makes a pin a fact about the *bundle* rather than a label the page
 * carries. A `github` build resolves `device-sync` to the stand-in module, so the real one
 * (and the wasm glue it imports when it loads) is never resolved and never emitted; a page
 * can only draw what it carries. The substitute has no twin on the GitHub side: that prong's
 * weight lives in the process behind the page (Rust's `git2`, gated by cargo features), so
 * a launcher pinned to `iroh` leaves GitHub's *controls* out and carries nothing extra for
 * having done so.
 */
const syncSurface = pinSurface(resolveSyncPin(process.env.VITE_LITHIC_SYNC));

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
  /**
   * The pin, as literals rather than as a variable the page reads.
   *
   * A substituted literal is what lets the bundle *shed* a prong instead of hiding it: every
   * `{#if SHOWS_GITHUB_SYNC}` in `App.svelte` compiles to a branch on this constant, and a
   * folded `false` takes the repository dialogs, their setup screens and the modules only they
   * import out of the artifact with it (37 kB of the 429 kB `iroh` bundle is the engine half
   * that the device pin sheds the same way, by resolution rather than by folding). The values
   * come from `syncSurface` above, so a build that folds `false` here and resolves the real
   * `device-sync` there is impossible: both read the one environment variable.
   */
  define: {
    __LITHIC_SYNC_GITHUB__: JSON.stringify(syncSurface.github)
  },
  resolve: {
    alias: syncSurface.device
      ? []
      : [
          { find: /^\.\/device-sync(\.ts)?$/, replacement: resolve(currentDir, 'src/device-sync-off.ts') },
          { find: /^\.\/DeviceSyncPanel\.svelte$/, replacement: resolve(currentDir, 'src/DeviceSyncPanelOff.svelte') }
        ]
  },
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
