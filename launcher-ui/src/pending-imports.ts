import { parseLithToJSON } from './lithic-format.ts';
import { EPHEMERAL_INTEGRATION_JSON } from './ephemeral-integration.ts';

export type PendingTiddler = Record<string, string>;

/**
 * Queue of tiddlers that should be injected into the next engine mount
 * (shared payloads from URL params, dropped .lith/.json files, the intro,
 * and the Ephemeral integration). Mirrors window.pendingImports in the
 * legacy launcher.
 */
export function ephemeralIntegrationTiddlers(): PendingTiddler[] {
  return EPHEMERAL_INTEGRATION_JSON.map((tiddler) => ({ ...tiddler }));
}

/**
 * Tag the root parent tiddler with Dogear so a shared payload opens at the
 * top of the story river (legacy behavior for ?json= / ?url= / intro).
 */
export function tagRootDogear(tiddlers: PendingTiddler[]): PendingTiddler[] {
  if (tiddlers.length === 0) return tiddlers;
  const root = { ...tiddlers[0] };
  const existing = Array.isArray(root.tags) ? root.tags : typeof root.tags === 'string' ? root.tags.split(' ') : [];
  root.tags = [...new Set([...existing, 'Dogear'])].join(' ');
  return [root, ...tiddlers.slice(1)];
}

/**
 * Parse a payload blob that may be either a JSON tiddler array or a .lith
 * monolith. Used for remote (?url=) payloads and the intro.
 */
export function parsePayloadText(text: string): PendingTiddler[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed as PendingTiddler[];
    } catch {
      // Fall through to the lith parser.
    }
  }
  return parseLithToJSON(text);
}

/**
 * Parse dropped data files: .lith uses the lith parser, .json must already
 * be a JSON array (legacy behavior).
 */
export function parseDroppedData(text: string, isLith: boolean): PendingTiddler[] {
  if (!isLith) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed as PendingTiddler[];
      return [];
    } catch {
      return [];
    }
  }
  return parseLithToJSON(text);
}

/**
 * Decode a ?json= / ?lith= URL param. Supports both raw JSON arrays and
 * base64-encoded payloads, then tags the root with Dogear. Returns null when
 * the value does not decode to a non-empty tiddler array.
 */
export function decodePayloadParam(value: string): PendingTiddler[] | null {
  let jsonString = value;
  if (!value.trim().startsWith('[')) {
    try {
      jsonString = decodeURIComponent(escape(atob(value)));
    } catch {
      return null;
    }
  }
  const parsed = parsePayloadText(jsonString);
  return parsed.length > 0 ? tagRootDogear(parsed) : null;
}

/**
 * Fetch a remote payload URL (?url= param) and parse it as JSON or lith.
 * Tags the root with Dogear and returns null on any failure.
 */
export async function fetchRemotePayload(url: string): Promise<PendingTiddler[] | null> {
  let target = url;
  if (!target.toLowerCase().startsWith('http') && !target.toLowerCase().startsWith('file:') && !target.startsWith('/')) {
    try {
      target = decodeURIComponent(escape(atob(target)));
    } catch {
      // Keep the original value; the fetch below will surface the error.
    }
  }
  try {
    const response = await fetch(target);
    if (!response.ok) return null;
    const text = await response.text();
    const parsed = parsePayloadText(text);
    return parsed.length > 0 ? tagRootDogear(parsed) : null;
  } catch {
    return null;
  }
}

/** Concatenate pending imports without mutating the existing queue. */
export function mergePendingImports(existing: PendingTiddler[], incoming: PendingTiddler[]): PendingTiddler[] {
  return [...existing, ...incoming];
}

/**
 * True when a dropped string looks like a Lithic share URL carrying a
 * payload (?json=, ?lith=, or ?url=).
 */
export function isPayloadShareUrl(text: string): boolean {
  return text.includes('?json=') || text.includes('?lith=') || text.includes('?url=');
}
