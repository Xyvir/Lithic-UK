import { serializeJsonToLith } from './lithic-format.ts';

export type SaverTiddler = Record<string, unknown>;
export type SaveCallback = (error?: unknown) => void;
export type SaveFilePicker = (options: {
  suggestedName: string;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<{
  name: string;
  createWritable(): Promise<{ write(value: string): Promise<void>; close(): Promise<void> }>;
}>;

export function normalizeLithName(name: string): string {
  return `${name.replace(/\.(?:html?|lith)$/i, '') || 'untitled'}.lith`;
}

export function createLithSaver(
  getJson: () => string,
  picker: SaveFilePicker,
  onFile?: (file: { name: string }) => void
) {
  let fileHandle: Awaited<ReturnType<SaveFilePicker>> | undefined;
  let pickerPromise: ReturnType<SaveFilePicker> | undefined;

  const write = async (jsonText: string, callback: SaveCallback) => {
    if (!fileHandle) {
      pickerPromise ??= picker({
        suggestedName: 'new.lith',
        types: [{ description: 'Lithic Monolith', accept: { 'application/x-lith': ['.lith'] } }]
      });
      try {
        fileHandle = await pickerPromise;
      } finally {
        pickerPromise = undefined;
      }
      onFile?.(fileHandle);
    }
    const writable = await fileHandle.createWritable();
    await writable.write(serializeJsonToLith(jsonText));
    await writable.close();
    callback(null);
  };

  return (_text: string, _method: string, callback: SaveCallback) => {
    void write(getJson(), callback).catch((error) => callback(error));
    return true;
  };
}

export function installLegacyLithSaver(): void {
  const root = window as typeof window & { $tw?: { wiki?: { getTiddlersAsJson?: (filter: string) => string }; customSaver?: { save: Function } }; showSaveFilePicker?: SaveFilePicker };
  if (!root.showSaveFilePicker || !root.$tw?.wiki?.getTiddlersAsJson) return;

  root.$tw.customSaver = {
    save: createLithSaver(
      () => root.$tw?.wiki?.getTiddlersAsJson?.('[all[tiddlers]]') ?? '[]',
      root.showSaveFilePicker,
      () => { /* TiddlyWiki owns subsequent save callbacks. */ }
    )
  };
}
