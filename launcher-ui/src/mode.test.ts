import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMode } from './mode.ts';

function location(url: string): Location {
  return new URL(url) as unknown as Location;
}

test('query parameter forces each supported mode', () => {
  assert.equal(resolveMode(location('https://lithic.uk/?mode=webapp')), 'webapp');
  assert.equal(resolveMode(location('https://lithic.uk/?mode=tauri')), 'tauri');
  assert.equal(resolveMode(location('https://lithic.uk/?mode=self-host')), 'self-host');
});

test('query parameter matching is case insensitive', () => {
  assert.equal(resolveMode(location('https://lithic.uk/?launcher-mode=SELF-HOST')), 'self-host');
});

test('invalid query values fall back to environment detection', () => {
  assert.equal(resolveMode(location('https://lithic.uk/?mode=invalid')), 'webapp');
  assert.equal(resolveMode(location('http://localhost/?mode=invalid')), 'self-host');
  assert.equal(resolveMode(location('https://example.local/?mode=invalid')), 'self-host');
});

test('sync paths resolve to self-host mode', () => {
  assert.equal(resolveMode(location('https://example.com/sync/wiki')), 'self-host');
});
