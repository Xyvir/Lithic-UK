import { copy } from './copy.ts';
import { DOCUMENT_FORMAT, documentPickerTypes, normalizeDocumentName } from './document-format.ts';
import { serializeJsonToLith } from './lithic-format.ts';

export type SaverTiddler = Record<string, unknown>;
export type SaveCallback = (error?: unknown) => void;

export type LocalFileHandle = {
  name: string;
  createWritable(): Promise<{ write(value: string): Promise<void>; close(): Promise<void> }>;
};

export type SaveFilePicker = (options: {
  suggestedName: string;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<LocalFileHandle>;

/**
 * The plugin roots a save excludes when the base declares nothing: the committed fallback.
 *
 * This literal is the *fallback*, not the source. A mount reads the plugin roots out of the
 * base it is mounting (`readEnginePluginRoots` in `legacy-launcher-runtime.ts`), and
 * `scripts/build-launcher.mjs` bakes the flattened staging tree's list in beside it through
 * `resolveDefaultPlugins`. It stays here, and stays 42 names long, because a checkout with no
 * staging tree still has to build a launcher, and because the engine-store parity test below
 * needs something committed to police: a fallback that has rotted is exactly how a plugin
 * bundle ends up inside a saved one-tiddler wiki.
 */
export const DEFAULT_PLUGINS: string[] = [
  'ahanniga/context-menu-plugin',
  'bj/Calendar',
  'bj/unieditor',
  'byper/advanced-search',
  'flibbles/relink',
  'flibbles/relink-markdown',
  'flibbles/relink-titles',
  'kebi/relink-tweaks',
  'kebi/tiddlystudy',
  'kebi/tiddlystudy-references',
  'kookma/quickview',
  'linonetwo/tw-react',
  'linonetwo/tw-whiteboard',
  'mklauber/aliases',
  'nico/notebook-mobile',
  'oeyoews/notebook-theme-sidebar-resizer',
  'orange/mermaid-tw5',
  'snowgoon88/edit-comptext',
  'sq/streams',
  'tiddlywiki/dynaview',
  'tiddlywiki/freelinks',
  'tiddlywiki/highlight',
  'tiddlywiki/katex',
  'tiddlywiki/markdown',
  'xyvir/anchors-for-streams',
  'xyvir/ephemeral-runner',
  'xyvir/lithic-core',
  'xyvir/lithic-default-configs',
  'xyvir/lithic-patch-appear',
  'xyvir/lithic-patch-calendar',
  'xyvir/lithic-patch-comptext',
  'xyvir/lithic-patch-markdown',
  'xyvir/lithic-patch-mermaid',
  'xyvir/lithic-patch-streams',
  'xyvir/lithic-patch-whiteboard',
  'xyvir/lithic-import-handler',
  'xyvir/lithic-python-codeblocks',
  'xyvir/lithic-richlinks',
  'xyvir/lithic-save',
  'xyvir/lithic-tweaks',
  'xyvir/lithic-wikitext-highlight',
  'xyvir/tw-jspython'
];

/**
 * The plugin list a build carries, which CI generates from the tree the wiki build loads.
 *
 * `VITE_LITHIC_BASE_PLUGINS` is set by `scripts/build-launcher.mjs` from
 * `scripts/generate-default-plugins.mjs`. It is absent in a checkout with no staging tree and
 * in every unit test, which is why `DEFAULT_PLUGINS` remains the answer there.
 */
export function resolveDefaultPlugins(): string[] {
  // Guarded on `import.meta.env` rather than on `location`, and this is the difference between
  // working and throwing: Vite substitutes the literal below at build time, while Node leaves
  // `import.meta.env` undefined, and a unit test that stubs a `location` global would make a
  // `location`-based guard read a property of undefined and fail the whole mount.
  const injected =
    typeof import.meta.env === 'undefined' ? undefined : import.meta.env.VITE_LITHIC_BASE_PLUGINS;
  if (!injected) return DEFAULT_PLUGINS;
  try {
    const parsed = JSON.parse(injected);
    return Array.isArray(parsed) && parsed.length ? (parsed as string[]) : DEFAULT_PLUGINS;
  } catch {
    return DEFAULT_PLUGINS;
  }
}

/**
 * Tiddlers the launcher itself puts into every mounted wiki: the shared widget
 * override and the Ephemeral API integration, plus the plugin-library flag the
 * engine bootstrap sets. They are part of how Lithic runs, not the user's
 * content, so a save must not write them into a .lith. The next mount injects
 * them again on top, and the copy in the file goes stale. `~` is the launcher's
 * own marking for an injected override, which is why a prefix rule covers the
 * whole class.
 */
export const LITHIC_INJECTED_EXCLUSIONS =
  '-[prefix[~]] -[prefix[$:/plugins/lithic/ephemeral/]] -[[$:/config/OfficialPluginLibrary]]';

export const LITHIC_BASE_FILTER =
  `[all[tiddlers]!is[system]] [all[tiddlers]is[system]!prefix[$:/core]!prefix[$:/themes]!prefix[$:/temp]!prefix[$:/state]!prefix[$:/HistoryList]] [is[shadow]] -[prefix[$:/boot/]] -[[$:/isEncrypted]] -[[$:/library/sjcl.js]] -[[$:/status/RequireReloadDueToPluginChange]] -[[$:/StoryList]] -[[$:/config/PageControlButtons/Visibility/$:/core/ui/Buttons/new-journal]] -[[$:/lithic/startup/webdav-utils.js]] ${LITHIC_INJECTED_EXCLUSIONS}`;

/**
 * The filter a save runs over the wiki: what is the user's document and what is the base's.
 *
 * `plugins` is the set the *mounted base* ships, which the caller reads out of the engine it
 * is mounting. It is an argument rather than a constant because that is the whole point of
 * the white-label work: a base ships whatever it ships, and a hardcoded Lithic list would
 * either miss a plugin (writing the base's own tiddlers into a user's file) or name one that
 * is not there (harmless, but a lie in the filter). `DEFAULT_PLUGINS` is the fallback for a
 * caller that has nothing better, and the generated list is what ships.
 *
 * `patch` is the base's own declaration of what its documents contain, appended to the
 * filter. Lithic declares one (`$:/lithic/config/PublishFilterPatch`), and appending it is a
 * no-op for Lithic's own saves because everything it subtracts is already excluded; the seam
 * exists so a base whose documents should hold a different set can say so.
 */
export function getLithicUserFilter(options: { plugins?: readonly string[]; patch?: string } = {}): string {
  const roots = options.plugins?.length ? options.plugins : DEFAULT_PLUGINS;
  const pluginExclusions = pluginExclusionFilter(roots);
  const patch = options.patch?.trim();
  return `${LITHIC_BASE_FILTER} ${pluginExclusions}${patch ? ` ${patch}` : ''}`;
}

/** The `-[[$:/plugins/...]]` exclusions for a set of plugin roots. */
export function pluginExclusionFilter(roots: readonly string[]): string {
  return roots.map((p) => `-[[$:/plugins/${p}]]`).join(' ');
}

/**
 * The filter fragment a base declares for its own documents, or an empty string.
 *
 * Two shapes are accepted, in order of preference: a plain tiddler holding the fragment
 * (`$:/config/lithic/document-filter`), which is the shape a base author should reach for,
 * and the macro Lithic already declares (`$:/lithic/config/PublishFilterPatch`), whose body
 * is extracted because it is the same fragment in a wrapper. A base that declares neither
 * contributes nothing, which is byte-for-byte today's filter.
 */
export function readBaseDocumentFilter(getText: (title: string, fallback?: string) => string): string {
  const plain = getText('$:/config/lithic/document-filter', '').trim();
  if (plain) return plain;
  const macro = getText('$:/lithic/config/PublishFilterPatch', '');
  const body = /\\define\s+publishFilter\s*\(\)\s*\r?\n([\s\S]*?)\r?\n\\end/.exec(macro);
  return body ? body[1].trim() : '';
}

export function normalizeLithName(name: string): string {
  return normalizeDocumentName(name, DOCUMENT_FORMAT);
}

export function createLithSaver(options?: {
  getJson?: () => string;
  picker?: SaveFilePicker;
  initialHandle?: LocalFileHandle;
  onFile?: (file: LocalFileHandle) => void;
  isJsonMode?: boolean;
  suggestedName?: string;
}) {
  let fileHandle: LocalFileHandle | undefined = options?.initialHandle;
  let pickerPromise: Promise<LocalFileHandle> | undefined;
  const isJsonMode = options?.isJsonMode !== false;

  const write = async (
    text: string,
    callback: SaveCallback,
    runtimeTw?: { wiki?: { getTiddlersAsJson?: (filter: string) => string; deleteTiddler?: (title: string) => void } },
    runtimePicker?: SaveFilePicker
  ) => {
    if (!fileHandle) {
      const picker = options?.picker ?? runtimePicker ?? (globalThis as any).showSaveFilePicker;
      if (!picker) {
        throw new Error('Native file picker is not available');
      }
      const saveOptions = isJsonMode
        ? {
            suggestedName: options?.suggestedName ?? normalizeDocumentName('new'),
            types: documentPickerTypes()
          }
        : {
            suggestedName: 'lith.html',
            types: [{ description: copy.fileTypes.html, accept: { 'text/html': ['.html', '.htm'] } }]
          };

      pickerPromise ??= picker(saveOptions);
      let selectedHandle: LocalFileHandle;
      try {
        selectedHandle = await pickerPromise!;
      } finally {
        pickerPromise = undefined;
      }
      fileHandle = selectedHandle;
      options?.onFile?.(selectedHandle);
    }

    const activeHandle = fileHandle;
    if (!activeHandle) throw new Error('No save file handle available');

    let textToWrite = text;
    if (isJsonMode) {
      const jsonText =
        options?.getJson?.() ??
        runtimeTw?.wiki?.getTiddlersAsJson?.(getLithicUserFilter()) ??
        '[]';
      // The file's own name decides the shape, never the build's pin: a `.lith` a user
      // already has must still be written as a `.lith`, whatever this build produces by
      // default. The pin governs the *suggested* names and the offered types above.
      if (activeHandle.name.toLowerCase().endsWith('.lith')) {
        textToWrite = serializeJsonToLith(jsonText);
      } else {
        textToWrite = jsonText;
      }
    }

    const writable = await activeHandle.createWritable();
    await writable.write(textToWrite);
    await writable.close();

    if (runtimeTw?.wiki?.deleteTiddler) {
      runtimeTw.wiki.deleteTiddler('$:/state/DisableAutoSaver');
    }

    callback(null);
  };

  return (text: string, _method: string, callback: SaveCallback) => {
    const root = globalThis as any;
    const runtimeTw = root.$tw;
    const runtimePicker = root.showSaveFilePicker;
    void write(text, callback, runtimeTw, runtimePicker).catch((error) => {
      if (error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError') {
        console.log('Save As dialog cancelled by user');
        callback(null);
      } else {
        callback(error);
      }
    });
    return true;
  };
}

export function installLegacyLithSaver(
  targetWindow?: typeof window,
  options?: {
    initialHandle?: LocalFileHandle;
    isJsonMode?: boolean;
    suggestedName?: string;
  }
): void {
  const root = (targetWindow ?? (typeof window !== 'undefined' ? window : globalThis)) as any;
  root.$tw = root.$tw || {};
  root.$tw.customSaver = {
    save: createLithSaver({
      initialHandle: options?.initialHandle ?? root.__LITHIC_FILE_HANDLE__,
      isJsonMode: options?.isJsonMode ?? true,
      ...(options?.suggestedName ? { suggestedName: options.suggestedName } : {})
    })
  };
}
