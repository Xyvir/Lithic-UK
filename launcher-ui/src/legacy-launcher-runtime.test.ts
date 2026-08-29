import test from 'node:test';
import assert from 'node:assert/strict';

function candidates(href: string): string[] {
  const base = new URL('.', href);
  return [
    new URL('lithic.html', base).href,
    new URL('pre-launcher-engine.html', base).href,
    new URL('src/lithic.html', base).href
  ];
}

test('resolves lithic.html as a sibling for file URLs', () => {
  assert.deepEqual(candidates('file:///C:/Lithic/src/pre-launcher.html'), [
    'file:///C:/Lithic/src/lithic.html',
    'file:///C:/Lithic/src/pre-launcher-engine.html',
    'file:///C:/Lithic/src/src/lithic.html'
  ]);
});

test('resolves lithic.html as a sibling for hosted URLs', () => {
  assert.equal(candidates('https://example.test/src/pre-launcher.html')[0], 'https://example.test/src/lithic.html');
});

test('keeps the canonical online engine as the recovery source', () => {
  assert.equal('https://raw.githubusercontent.com/Xyvir/Lithic-UK/refs/heads/main/src/lithic.html'.endsWith('/src/lithic.html'), true);
});
