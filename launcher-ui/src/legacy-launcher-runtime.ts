import { parseLithToJSON } from './lithic-format';

export type LauncherHandoff = {
  name: string;
  path?: string;
  text: string;
};

const HANDOFF_KEY = 'lithic-launcher-file';
const ONLINE_ENGINE_URL = 'https://raw.githubusercontent.com/Xyvir/Lithic-UK/refs/heads/main/src/lithic.html';
const CACHED_ENGINE_KEY = 'cachedOnlineCoreEngine';

function getTodayTitle(): string {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const date = new Date();
  const day = date.getDate();
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  return `${day}${suffix} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

function getTwTime(): string {
  const date = new Date();
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}${String(date.getUTCSeconds()).padStart(2, '0')}${String(date.getUTCMilliseconds()).padStart(3, '0')}`;
}

async function fetchEngine(): Promise<string> {
  const base = new URL('.', window.location.href);
  const candidates = [
    new URL('lithic.html', base),
    new URL('pre-launcher-engine.html', base),
    new URL('src/lithic.html', base),
    new URL('/lithic.html', window.location.origin),
    new URL('/src/lithic.html', window.location.origin)
  ];

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate.href);
      if (response.ok) return response.text();
    } catch {
      // Try the next deployment-relative path.
    }
  }

  // Prefer a previously downloaded engine so local launches remain stable and
  // do not unexpectedly switch to a newer online build.
  try {
    const cached = localStorage.getItem(CACHED_ENGINE_KEY);
    if (cached) return cached;
  } catch {
    // Storage may be unavailable in restricted browser contexts.
  }

  // Local file launches commonly reject all file:// fetches as a null-origin
  // CORS violation. Only use the canonical online engine as the last resort.
  try {
    const response = await fetch(ONLINE_ENGINE_URL);
    if (response.ok) {
      const text = await response.text();
      try { localStorage.setItem(CACHED_ENGINE_KEY, text); } catch { /* storage may be unavailable */ }
      return text;
    }
  } catch {
    // Report the actionable error below.
  }

  throw new Error('Could not load the Lithic engine locally, from the offline cache, or online.');
}

function injectTiddlers(html: string, tiddlers: Array<Record<string, string>>): string {
  const script = `<script class="tiddlywiki-tiddler-store" type="application/json">${JSON.stringify(tiddlers)}</script>`;
  const store = /(<script class="tiddlywiki-tiddler-store" type="application\/json">\[)([\s\S]*?)(\]\s*<\/script>)/i;
  if (store.test(html)) {
    return html.replace(store, (_, start, existing, end) => `${start}${existing.trim() ? `${existing},` : ''}${JSON.stringify(tiddlers).slice(1, -1)}${end}`);
  }
  // A TiddlyWiki store must be available before the boot scripts execute.
  // Insert immediately before the first boot script, falling back to body.
  const firstBootScript = html.search(/<script[^>]+src=["'][^"']*boot[^"']*["'][^>]*>/i);
  if (firstBootScript >= 0) {
    const tag = html.lastIndexOf('<script', firstBootScript);
    return `${html.slice(0, tag)}${script}\n${html.slice(tag)}`;
  }
  return html.replace(/<\/body>/i, `${script}</body>`);
}

export async function bootLegacyWiki(handoff: LauncherHandoff): Promise<void> {
  const engine = await fetchEngine();
  const imported = handoff.text ? parseLithToJSON(handoff.text) : [];
  const today = getTodayTitle();
  if (!imported.some((tiddler) => tiddler.title === today)) {
    imported.push({ created: getTwTime(), modified: getTwTime(), tags: 'Journal', title: today, type: '' });
  }
  imported.push({ title: '$:/state/DisableAutoSaver', text: 'yes' });
  imported.push({ title: '$:/config/OfficialPluginLibrary', text: 'yes' });

  // TiddlyWiki's boot script is usually present in lithic.html. Keep this
  // guard so a future engine build without an initial store still boots.
  const html = injectTiddlers(engine, imported);

  sessionStorage.setItem('lithic-active-file', JSON.stringify(handoff));
  document.open();
  document.write(html);
  document.close();
  // The injected bootstrap script installs the saver after TiddlyWiki creates
  // $tw; this marker is consumed by the engine-startup hook below.
}

export function readHandoff(): LauncherHandoff | null {
  try {
    const raw = sessionStorage.getItem(HANDOFF_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(HANDOFF_KEY);
    return JSON.parse(raw) as LauncherHandoff;
  } catch {
    return null;
  }
}
