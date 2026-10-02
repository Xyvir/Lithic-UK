import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyText } from './clipboard.ts';

/** The textarea the fallback makes, recording what was done to it. */
class FakeArea {
  value = '';
  readonly attributes: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  selected = false;
  removed = false;
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  select() {
    this.selected = true;
  }
  remove() {
    this.removed = true;
  }
}

/** A document that answers `execCommand` however the test asks and remembers its textarea. */
function fakeDoc(exec: (command: string) => boolean) {
  const areas: FakeArea[] = [];
  const appended: FakeArea[] = [];
  const doc = {
    createElement: () => {
      const area = new FakeArea();
      areas.push(area);
      return area;
    },
    execCommand: (command: string) => exec(command),
    body: { appendChild: (node: FakeArea) => appended.push(node) }
  } as unknown as Document;
  return { doc, areas, appended };
}

test('the modern route carries the text when the page has it', async () => {
  const written: string[] = [];
  const ok = await copyText('ABCD-1234', {
    clipboard: {
      writeText: async (text: string) => {
        written.push(text);
      }
    }
  });
  assert.equal(ok, true);
  assert.deepEqual(written, ['ABCD-1234']);
});

test('the helper carries the text, it does not format it', async () => {
  // The code reached the clipboard exactly as given. Formatting is `formatUserCode`'s
  // business, upstream of this, and a second spelling here would be a second answer.
  const written: string[] = [];
  await copyText('abcd1234', {
    clipboard: {
      writeText: async (text: string) => {
        written.push(text);
      }
    }
  });
  assert.deepEqual(written, ['abcd1234']);
});

test('a refused async write falls back to the selection rather than giving up', async () => {
  const { doc, areas, appended } = fakeDoc(() => true);
  const ok = await copyText('ABCD-1234', {
    clipboard: {
      writeText: async () => {
        throw new Error('NotAllowedError');
      }
    },
    doc
  });
  assert.equal(ok, true, 'the fallback needs no permission, so a blocked API is not the end');
  assert.equal(areas.length, 1);
  const area = areas[0];
  assert.equal(area.value, 'ABCD-1234');
  assert.equal(area.attributes.readonly, '', 'readonly keeps a mobile keyboard out of the way');
  assert.equal(area.style.position, 'fixed', 'off screen rather than hidden, so it can be selected');
  assert.equal(area.selected, true);
  assert.deepEqual(appended, [area], 'the textarea has to be in the document to be copied');
  assert.equal(area.removed, true, 'and out of it again whatever the copy answered');
});

test('a page with no clipboard at all is what the fallback is for', async () => {
  const { doc, areas, appended } = fakeDoc((command) => command === 'copy');
  const ok = await copyText('ABCD-1234', { clipboard: undefined, doc });
  assert.equal(ok, true);
  assert.equal(areas.length, 1);
  assert.deepEqual(appended, areas);
});

test('a refused selection copy answers false and leaves nothing behind', async () => {
  const { doc, areas } = fakeDoc(() => false);
  const ok = await copyText('ABCD-1234', { clipboard: undefined, doc });
  assert.equal(ok, false);
  assert.equal(areas[0].removed, true);
});

test('a selection copy that throws is a false rather than a failed click', async () => {
  const { doc, areas } = fakeDoc(() => {
    throw new Error('execCommand is gone');
  });
  const ok = await copyText('ABCD-1234', { clipboard: undefined, doc });
  assert.equal(ok, false);
  assert.equal(areas[0].removed, true, 'the textarea is removed in a finally, not on the way out');
});

test('a page with neither route answers false instead of throwing', async () => {
  assert.equal(await copyText('ABCD-1234', { clipboard: undefined, doc: undefined }), false);
  assert.equal(await copyText('ABCD-1234', { clipboard: undefined, doc: {} as Document }), false);
});

test('an empty string is not a copy, so an empty code cannot claim one', async () => {
  const written: string[] = [];
  const ok = await copyText('', {
    clipboard: {
      writeText: async (text: string) => {
        written.push(text);
      }
    }
  });
  assert.equal(ok, false);
  assert.deepEqual(written, []);
});
