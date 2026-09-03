export interface FileBridge {
  open(): Promise<{ name: string; path?: string; text: string; handle?: unknown } | null>;
  save(text: string, suggestedName: string, path?: string): Promise<{ name: string; path?: string }>;
  loadUrl(url: string): Promise<string>;
}

type TauriApi = { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };

/**
 * Resolve the Tauri invoke function across versions: Tauri v1 exposes
 * window.__TAURI__.tauri.invoke (withGlobalTauri), while Tauri v2 exposes
 * window.__TAURI__.invoke directly. The repo's Tauri app is currently v1.
 */
function tauriApi(): TauriApi | null {
  const root = (globalThis as typeof globalThis & {
    __TAURI__?: { invoke?: TauriApi['invoke']; tauri?: { invoke?: TauriApi['invoke'] } }
  }).__TAURI__;
  if (root?.invoke) return { invoke: root.invoke };
  if (root?.tauri?.invoke) return { invoke: root.tauri.invoke };
  return null;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load wiki engine (${response.status})`);
  return response.text();
}

function browserBridge(): FileBridge {
  return {
    loadUrl: fetchText,
    async save(text, suggestedName) {
      if (typeof window !== 'undefined' && (window as any).showSaveFilePicker) {
        try {
          const handle = await (window as any).showSaveFilePicker({
            suggestedName: suggestedName.toLowerCase().endsWith('.lith') ? suggestedName : `${suggestedName}.lith`,
            types: [{ description: 'Lithic Monolith', accept: { 'application/x-lith': ['.lith'] } }]
          });
          const writable = await handle.createWritable();
          await writable.write(text);
          await writable.close();
          return { name: handle.name };
        } catch (err: any) {
          if (err && typeof err === 'object' && err.name === 'AbortError') {
            return { name: suggestedName };
          }
          // Fall back to blob anchor download below
        }
      }
      const blob = new Blob([text], { type: 'application/x-lith' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = suggestedName.toLowerCase().endsWith('.lith') ? suggestedName : `${suggestedName}.lith`;
      anchor.click();
      URL.revokeObjectURL(url);
      return { name: anchor.download };
    },
    async open() {
      if (typeof window !== 'undefined' && (window as any).showOpenFilePicker) {
        try {
          const openOptions = {
            types: [
              { description: 'Lithic Monolith', accept: { 'application/x-lith': ['.lith'] } },
              { description: 'Lithic JSON Backups', accept: { 'application/json': ['.json'] } },
              { description: 'Lithic HTML Files', accept: { 'text/html': ['.html', '.htm'] } }
            ]
          };
          const [fileHandle] = await (window as any).showOpenFilePicker(openOptions);
          const file = await fileHandle.getFile();
          const text = await file.text();
          return { name: file.name, text, handle: fileHandle };
        } catch (err: any) {
          if (err && typeof err === 'object' && err.name === 'AbortError') {
            return null;
          }
          // Fall back to standard file input
        }
      }
      return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.lith,.html,.htm,text/plain,text/html';
        input.onchange = () => {
          const file = input.files?.[0];
          if (!file) return resolve(null);
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error ?? new Error('Unable to read file'));
          reader.onload = () => resolve({ name: file.name, text: String(reader.result ?? '') });
          reader.readAsText(file);
        };
        input.click();
      });
    }
  };
}

export function createFileBridge(): FileBridge {
  const invoke = tauriApi()?.invoke;
  if (!invoke) return browserBridge();
  return {
    loadUrl: fetchText,
    async save(text, suggestedName, path) {
      const result = await invoke('save_lith_file', { text, suggestedName, path });
      return result as { name: string; path?: string };
    },
    async open() {
      const result = await invoke('open_lith_file');
      return (result as { name: string; path: string; text: string } | null) ?? null;
    }
  };
}
