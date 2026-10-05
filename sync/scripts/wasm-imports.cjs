#!/usr/bin/env node
// Checks what the generated browser module asks of its host.
//
// A browser wasm module may only import from the wasm-bindgen glue module
// that the bundler supplies. Anything else, `env` first of all, means a
// native dependency leaked into the browser build.
//
// Run after wasm-bindgen, with Node 22 or newer:
//
//   node scripts/wasm-imports.cjs [path/to/lithic_sync_bg.wasm]

const fs = require('node:fs');
const path = require('node:path');

const wasmPath =
  process.argv[2] ||
  path.join(__dirname, '..', 'target', 'wasm-node', 'lithic_sync_bg.wasm');
const glueModule = process.env.LITHIC_WASM_GLUE_MODULE || './lithic_sync_bg.js';

const wasmModule = new WebAssembly.Module(fs.readFileSync(wasmPath));
const imports = WebAssembly.Module.imports(wasmModule);
const modules = [...new Set(imports.map((entry) => entry.module))];
const unexpected = modules.filter((name) => name !== glueModule);

console.log(`${path.relative(process.cwd(), wasmPath)}: ${imports.length} imports`);
for (const name of modules) console.log(`  ${name}`);

if (unexpected.length > 0) {
  console.error(`FAIL: imports outside the allowed surface: ${unexpected.join(', ')}`);
  process.exit(1);
}
console.log(`IMPORTS OK: only ${glueModule}`);
