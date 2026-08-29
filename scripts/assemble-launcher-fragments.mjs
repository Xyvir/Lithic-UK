import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const dir = resolve('launcher-fragments');
const files = ['document-head.html', 'runtime.js', 'document-body.html', 'document-tail.html'];
const contents = await Promise.all(files.map((file) => readFile(resolve(dir, file), 'utf8')));
const assembled = contents.join('');
await writeFile(resolve('src/launcher-fragments-assembled.html'), assembled);
console.log('Wrote src/launcher-fragments-assembled.html');
