<script lang="ts">
  /**
   * Device sync's panel, on a launcher built without device sync (`--sync=github`).
   *
   * The bundler's twin of this file is `device-sync-off.ts`: `vite.config.ts` aliases both
   * when the pin leaves device sync out, so the real panel and the engine behind it are not
   * in the bundle at all. Nothing renders, and nothing can: `App.svelte` draws the control
   * that opens this panel only when device sync is compiled in, so the panel is mounted
   * never, and the props it would be handed are not declared here because there is no shape
   * under the type checker's real component to keep.
   */
</script>
