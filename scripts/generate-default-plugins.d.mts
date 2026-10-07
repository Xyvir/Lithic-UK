/**
 * Types for `generate-default-plugins.mjs`, which the launcher build imports and a
 * `launcher-ui` unit test imports. It is JavaScript rather than TypeScript because
 * `scripts/build-launcher.mjs` runs under plain Node, where a `.ts` import is not available.
 */

/** The build config the wiki will be built from, preferring the one CI generated. */
export declare function defaultConfigPath(root?: string): string;

/** Every plugin root a save must exclude, sorted, with build-only tooling removed. */
export declare function collectDefaultPlugins(options?: {
  root?: string;
  configPath?: string;
}): string[];
