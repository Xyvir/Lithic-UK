export interface FileBridge {
  open(): Promise<{ name: string; path?: string; text: string } | null>;
  save(text: string, suggestedName: string, path?: string): Promise<{ name: string; path?: string }>;
  loadUrl(url: string): Promise<string>;
}

type TauriApi = { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriApi(): TauriApi | null {
  const candidate = (globalThis as typeof globalThis & { __TAURI__?: { invoke?: TauriApi['invoke'] } }).__TAURI__;
  return candidate?.invoke ? { invoke: candidate.invoke } : null;
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
