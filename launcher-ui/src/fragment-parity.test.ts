import test from 'node:test';
import assert from 'node:assert/strict';
import { launcherFragments } from './legacy-fragments.ts';

test('launcher fragments have unique ids and source files', () => {
  const ids = launcherFragments.map((fragment) => fragment.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(launcherFragments.every((fragment) => fragment.source.endsWith('.html') || fragment.source.endsWith('.js')));
});

test('launcher foundations precede launch integrations', () => {
  const ids = launcherFragments.map((fragment) => fragment.id);
  assert.ok(ids.indexOf('runtime.format') < ids.indexOf('runtime.launch'));
  assert.ok(ids.indexOf('runtime.engine') < ids.indexOf('runtime.launch'));
});

test('all legacy responsibilities have an explicit migration state', () => {
  assert.ok(launcherFragments.length >= 10);
  assert.ok(launcherFragments.some((fragment) => fragment.id === 'runtime.local-saver'));
  assert.ok(launcherFragments.some((fragment) => fragment.id === 'runtime.webdav'));
  assert.ok(launcherFragments.some((fragment) => fragment.id === 'ui.pwa'));
});
