import test from 'node:test';
import assert from 'node:assert/strict';
import { createLithSaver, normalizeLithName } from './legacy-saver.ts';

test('normalizes launcher names to one lith extension', () => {
  assert.equal(normalizeLithName('new'), 'new.lith');
  assert.equal(normalizeLithName('new.html'), 'new.lith');
  assert.equal(normalizeLithName('new.lith'), 'new.lith');
  assert.equal(normalizeLithName('.html'), 'untitled.lith');
});

test('opens one Lithic picker and reuses the selected handle', async () => {
  let pickerCalls = 0;
  const writes: string[] = [];
  const picker = async (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => {
    pickerCalls++;
    assert.equal(options.suggestedName, 'new.lith');
    assert.deepEqual(options.types[0].accept, { 'application/x-lith': ['.lith'] });
    return {
      name: 'new.lith',
      async createWritable() {
        return {
          async write(value: string) { writes.push(value); },
          async close() {}
        };
      }
    };
  };
  const saver = createLithSaver(() => '[{"title":"Today","text":"hello"}]', picker);
  const callbackErrors: unknown[] = [];
  saver('', '', (error) => callbackErrors.push(error));
  saver('', '', (error) => callbackErrors.push(error));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(pickerCalls, 1);
  assert.equal(writes.length, 2);
  assert.match(writes[0], /title: Today/);
  assert.deepEqual(callbackErrors, [null, null]);
});
