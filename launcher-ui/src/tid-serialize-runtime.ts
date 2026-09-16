/**
 * ES5 runtime injected into the mounted engine for scratch-mode saves of
 * `.tid` files: mirrors serializeTidFile (scratch-wiki.ts) — quoted multi-line
 * field values are JSON-stringified, `text` becomes the body after the blank
 * separator, and every non-text field serializes in its stored order.
 *
 * Mount-injected plumbing never reaches the file: the `lithic-tid` marker,
 * the `lithic-tid-injected` bookkeeping field, and every field it lists
 * (fields the mount added for editor UX, e.g. a Dogear tags entry) are
 * skipped, so saves round-trip the authored header exactly.
 */
export const TID_SERIALIZE_RUNTIME = `(function (root) {
  'use strict';
  function stringifyValue(value) {
    if (/[\\n"\\\\]/.test(value)) return JSON.stringify(value);
    return value;
  }
  /**
   * Serialize a .tid document from wiki field maps.
   * docTiddler: field map of the document root (title excluded from output).
   * Returns the .tid file text.
   */
  function serializeTid(docTiddler) {
    var injected = (docTiddler['lithic-tid-injected'] || '').split(' ');
    var skip = { 'title': 1, 'text': 1, 'lithic-tid': 1, 'lithic-tid-injected': 1 };
    for (var n = 0; n < injected.length; n++) skip[injected[n]] = 1;
    var fields = [];
    for (var key in docTiddler) {
      if (!Object.prototype.hasOwnProperty.call(docTiddler, key)) continue;
      var value = docTiddler[key];
      // Injected-for-UX fields get value-level handling so user edits made
      // in the editor still persist: 'tags' drops only the injected Dogear
      // token, 'type' persists once it differs from the injected default.
      if (skip[key] && key === 'tags' && typeof value === 'string') {
        var kept = value.split(/\\s+/).filter(function(token) { return token && token !== 'Dogear'; });
        if (kept.length > 0) fields.push('tags: ' + kept.join(' '));
        continue;
      }
      if (skip[key] && key === 'type' && typeof value === 'string' && value !== 'text/markdown') {
        fields.push('type: ' + value);
        continue;
      }
      if (skip[key]) continue;
      if (value === undefined || value === null || value === '') continue;
      fields.push(key + ': ' + stringifyValue(String(value)));
    }
    var text = docTiddler.text === undefined || docTiddler.text === null ? '' : String(docTiddler.text);
    return fields.join('\\n') + '\\n\\n' + text;
  }
  root.__LITHIC_TID_SERIALIZE__ = serializeTid;
})(typeof window !== 'undefined' ? window : globalThis);
`;
