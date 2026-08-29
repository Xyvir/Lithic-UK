import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = await readFile(resolve('src/launcher.html'), 'utf8');
const lines = source.split(/(?<=\n)/);
const markers = [
  ['head/bootstrap', '    <script type="module">'],
  ['head/after-runtime', '  </script>\n\n  <script>'],
  ['body', '  <div class="container">']
];

const output = resolve('launcher-fragments');
await mkdir(output, { recursive: true });

function lineIndex(needle, start = 0) {
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    if (offset >= start && lines[i].includes(needle)) return { index: i, offset };
    offset += lines[i].length;
  }
  return null;
}

const firstScript = source.indexOf('  <script type="module">');
const body = source.indexOf('  <div class="container">');
const endHead = source.indexOf('</head>');
const endBody = source.lastIndexOf('</body>');

await writeFile(resolve(output, 'document-head.html'), source.slice(0, firstScript));
await writeFile(resolve(output, 'runtime.js'), source.slice(firstScript, endHead));
await writeFile(resolve(output, 'document-body.html'), source.slice(body, endBody));
await writeFile(resolve(output, 'document-tail.html'), source.slice(endBody));
await writeFile(resolve(output, 'README.md'), [
  '# Legacy launcher fragments',
  '',
  'These files are extracted verbatim from src/launcher.html by scripts/extract-launcher-fragments.mjs.',
  '',
  '- document-head.html: document metadata and styles',
  '- runtime.js: the legacy runtime, including local saver, engine loading, WebDAV, and startup logic',
  '- document-body.html: launcher markup and modal markup',
  '- document-tail.html: trailing scripts and closing tags',
  '',
  'Do not hand-edit these fragments. Re-run the extractor after changing the canonical legacy launcher.',
  ''
].join('\\n'));
console.log(`Extracted launcher fragments to ${output}`);
