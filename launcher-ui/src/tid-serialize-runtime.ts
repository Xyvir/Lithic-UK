/**
 * ES5 runtime injected into the mounted engine for scratch-mode saves of
 * `.tid` files: mirrors serializeTidFile (scratch-wiki.ts) — quoted multi-line
 * field values are JSON-stringified, `text` becomes the body after the blank
 * separator, and every non-text field serializes in its stored order.
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
    var fields = [];
    for (var key in docTiddler) {
      if (!Object.prototype.hasOwnProperty.call(docTiddler, key)) continue;
      if (key === 'title' || key === 'text') continue;
      var value = docTiddler[key];
      if (value === undefined || value === null || value === '') continue;
      fields.push(key + ': ' + stringifyValue(String(value)));
    }
    var text = docTiddler.text === undefined || docTiddler.text === null ? '' : String(docTiddler.text);
    return fields.join('\\n') + '\\n\\n' + text;
  }
  root.__LITHIC_TID_SERIALIZE__ = serializeTid;
})(typeof window !== 'undefined' ? window : globalThis);
`;
