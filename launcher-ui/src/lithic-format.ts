export type LithicTiddler = Record<string, string>;

export function parseLithToJSON(lithText: string): LithicTiddler[] {
  const blocks = lithText.split(/(?:\r?\n)*⁂⁂⁂(?:\r?\n)*/);
  const tiddlers: LithicTiddler[] = [];

  for (const block of blocks) {
    if (!block.trim()) continue;

    let delimiterIdx = block.indexOf('\n\n');
    let delimiterLen = 2;
    const altRN = block.indexOf('\r\n\r\n');
    if (altRN !== -1 && (delimiterIdx === -1 || altRN < delimiterIdx)) {
      delimiterIdx = altRN;
      delimiterLen = 4;
    }

    let fieldsStr = '';
    let text = '';
    if (delimiterIdx !== -1) {
      fieldsStr = block.substring(0, delimiterIdx);
      text = block.substring(delimiterIdx + delimiterLen);
    } else {
      fieldsStr = block;
    }

    const tiddler: LithicTiddler = {};
    if (text) tiddler.text = text;

    for (const line of fieldsStr.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon !== -1) {
        const key = line.substring(0, colon).trim();
        const value = line.substring(colon + 1).trim();
        if (key) tiddler[key] = value;
      }
    }

    if (Object.keys(tiddler).length > 0) tiddlers.push(tiddler);
  }

  return tiddlers;
}

export function serializeJsonToLith(jsonArrayText: string): string {
  try {
    const tiddlers = JSON.parse(jsonArrayText) as LithicTiddler[];
    tiddlers.sort((a, b) => {
      const isBulky = (tiddler: LithicTiddler) =>
        (tiddler.type?.startsWith('image/') || tiddler.type === 'application/pdf' || tiddler.type === 'application/tldr' ||
          (tiddler.text?.length ?? 0) > 50000) ?? false;
      const bulkyDifference = Number(isBulky(a)) - Number(isBulky(b));
      if (bulkyDifference) return bulkyDifference;
      return (a.title || '').localeCompare(b.title || '');
    });

    return tiddlers.map((tiddler) => {
      let text = '';
      for (const key of Object.keys(tiddler).filter((key) => key !== 'text').sort()) {
        const value = tiddler[key];
        if (value !== undefined && value !== null && value !== '') text += `${key}: ${value}\n`;
      }
      return text + (tiddler.text ? `\n${tiddler.text}` : '\n');
    }).join('\n⁂⁂⁂\n');
  } catch (error) {
    console.error('Failed to serialize array to .lith format:', error);
    return '';
  }
}
