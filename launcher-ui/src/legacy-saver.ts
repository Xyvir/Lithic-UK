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
  'xyvir/lithic-core',
  'xyvir/lithic-default-configs',
  'xyvir/lithic-patch-appear',
  'xyvir/lithic-patch-calendar',
  'xyvir/lithic-patch-comptext',
  'xyvir/lithic-patch-markdown',
  'xyvir/lithic-patch-streams',
  'xyvir/lithic-patch-whiteboard',
  'xyvir/lithic-pdf-to-whiteboard',
  'xyvir/lithic-python-codeblocks',
  'xyvir/lithic-richlinks',
  'xyvir/lithic-tweaks',
  'xyvir/lithic-wikitext-highlight',
  'xyvir/tw-jspython'
];

export const LITHIC_BASE_FILTER =
  '[all[tiddlers]!is[system]] [all[tiddlers]is[system]!prefix[$:/core]!prefix[$:/themes]!prefix[$:/temp]!prefix[$:/state]!prefix[$:/HistoryList]] [is[shadow]] -[prefix[$:/boot/]] -[[$:/isEncrypted]] -[[$:/library/sjcl.js]] -[[$:/status/RequireReloadDueToPluginChange]] -[[$:/StoryList]] -[[$:/config/PageControlButtons/Visibility/$:/core/ui/Buttons/new-journal]] -[[$:/lithic/startup/webdav-utils.js]]';

export function getLithicUserFilter(): string {
  const pluginExclusions = DEFAULT_PLUGINS.map((p) => `-[[$:/plugins/${p}]]`).join(' ');
  return `${LITHIC_BASE_FILTER} ${pluginExclusions}`;
}

export function normalizeLithName(name: string): string {
  const base = name.replace(/\.(?:html?|lith|json)$/i, '');
  return `${base || 'untitled'}.lith`;
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
            suggestedName: options?.suggestedName ?? 'new.lith',
            types: [{ description: 'Lithic Monolith', accept: { 'application/x-lith': ['.lith'] } }]
          }
        : {
            suggestedName: 'lith.html',
            types: [{ description: 'Lithic HTML File', accept: { 'text/html': ['.html', '.htm'] } }]
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
      if (activeHandle.name.endsWith('.lith')) {
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
