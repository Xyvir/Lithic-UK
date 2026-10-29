import assert from 'node:assert/strict';
import test from 'node:test';
import { createFileBridge, saveTextVerifiably } from './file-bridge.ts';

/**
 * A page whose address decides what the bridge may do, with everything the download path touches
 * faked around it.
 *
 * `location` and `document` are read through the global on every call, so installing them here is
 * the whole of the setup. The anchor is recorded rather than clicked for real: what matters is
 * that a download was started, and a started download is the one outcome a browser cannot confirm.
 */
interface Harness {
  /** Every command the bridge sent, in order. */
  asked: string[];
  /** Every anchor the download path made, as `{ href, download }`. */
  anchors: { href: string; download: string }[];
  /** Whether the Chromium save picker was offered at all. */
  pickerCalls: number;
}

interface Address {
  protocol: string;
  hostname: string;
  pathname?: string;
  search?: string;
}

async function onPage(
  origin: Address,
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
  run: (harness: Harness) => Promise<void>
): Promise<void> {
  const globals = globalThis as Record<string, unknown>;
  const harness: Harness = { asked: [], anchors: [], pickerCalls: 0 };
  const saved = {
    location: globals.location,
    document: globals.document,
    bridge: globals.__TAURI__,
    createObjectURL: (URL as unknown as { createObjectURL?: unknown }).createObjectURL,
    revokeObjectURL: (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL,
    showSaveFilePicker: (globals as { showSaveFilePicker?: unknown }).showSaveFilePicker
  };

  globals.location = { pathname: '/launcher.html', search: '', ...origin };
  globals.document = {
    querySelector: () => null,
    body: { appendChild() {} },
    createElement: () => ({
      href: '',
      download: '',
      click() {
        harness.anchors.push({ href: this.href, download: this.download });
      },
      remove() {}
    })
  };
  globals.__TAURI__ = {
    core: {
      invoke: (command: string, args?: Record<string, unknown>) => {
        harness.asked.push(command);
        return invoke(command, args);
      }
    }
  };
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = () => 'blob:download';
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = () => {};
  // Offered, and must go unused: a save dialog in front of an export is the thing being removed.
  (globals as { showSaveFilePicker?: unknown }).showSaveFilePicker = () => {
    harness.pickerCalls += 1;
    throw new Error('the save picker must not be offered for a download');
  };

  try {
    await run(harness);
  } finally {
    for (const [key, value] of Object.entries({
      location: saved.location,
      document: saved.document,
      __TAURI__: saved.bridge,
      showSaveFilePicker: saved.showSaveFilePicker
    })) {
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = saved.createObjectURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = saved.revokeObjectURL;
  }
}

const appPage: Address = { protocol: 'https:', hostname: 'tauri.localhost' };
const instancePage: Address = { protocol: 'https:', hostname: 'personal.example.uk' };
// The shape the smoke harness stands the app up in: the artifact on disk, told that it is the
// app. It is the app's own page for every purpose here, and is the reason the predicate asks
// `resolveMode` rather than the address alone.
const harnessPage: Address = { protocol: 'file:', hostname: '', search: '?mode=tauri' };

test("a page the app did not serve never sends the app's commands", async () => {
  // The regression this exists for: `withGlobalTauri` injects the global into every document the
  // window loads, so an instance's own launcher holds one too. Its origin is outside the
  // capability that answers a command, so an invoke from there could only be refused, and the
  // buttons it powered did nothing at all.
  await onPage(
    instancePage,
    async () => {
      throw new Error('an instance page must not invoke anything');
    },
    async (harness) => {
      const outcome = await saveTextVerifiably('backup.lith', 'bytes', true);
      assert.equal(outcome, 'started', 'the browser download is the answer on a page the app did not serve');
      assert.deepEqual(harness.asked, []);
      assert.equal(harness.anchors.length, 1, 'the copy left as a download');
      assert.equal(harness.anchors[0].download, 'backup.lith');
      assert.equal(harness.pickerCalls, 0);
    }
  );
});

test('the same gate covers the file bridge, which is the mount and save route', async () => {
  // A save of the wiki itself, which is the other thing this door answers. On an instance page it
  // is the browser's copy that is written, and no command is sent on the way there.
  await onPage(
    instancePage,
    async () => {
      throw new Error('an instance page must not invoke anything');
    },
    async (harness) => {
      const saved = await createFileBridge(true).save('bytes', 'notes.lith');
      assert.deepEqual(harness.asked, []);
      assert.equal(harness.anchors.length, 1, 'the browser took the file');
      assert.equal(saved.name, 'notes.lith');
    }
  );

  // And on the app's own page it is the app's own write, through the command the bridge is for.
  await onPage(
    appPage,
    async (command) => {
      assert.equal(command, 'save_lith_file');
      return { name: 'notes.lith', path: '/home/u/notes.lith' };
    },
    async (harness) => {
      const saved = await createFileBridge(true).save('bytes', 'notes.lith', '/home/u/notes.lith');
      assert.deepEqual(harness.asked, ['save_lith_file']);
      assert.equal(saved.path, '/home/u/notes.lith');
    }
  );
});

test('a page told it is the app is the app, which is how the harness stands one up', async () => {
  await onPage(
    harnessPage,
    async (command) => {
      assert.equal(command, 'save_lith_download');
      return { name: 'backup.lith', path: '/home/u/Downloads/backup.lith' };
    },
    async (harness) => {
      assert.equal(await saveTextVerifiably('backup.lith', 'bytes', true), 'saved');
      assert.deepEqual(harness.asked, ['save_lith_download']);
    }
  );
});

test("the app's own page writes the copy into Downloads, with no dialog", async () => {
  await onPage(
    appPage,
    async (command) => {
      assert.equal(command, 'save_lith_download');
      return { name: 'backup.lith', path: '/home/u/Downloads/backup.lith' };
    },
    async (harness) => {
      const outcome = await saveTextVerifiably('backup.lith', 'bytes', true);
      assert.equal(outcome, 'saved', 'a path from Rust is the write being confirmed');
      assert.deepEqual(harness.asked, ['save_lith_download'], 'the save dialog is not a rung on this page');
      assert.equal(harness.anchors.length, 0);
    }
  );
});

test('a platform with no Downloads folder falls back to the dialog, and a dismissal is a cancellation', async () => {
  // A phone: its storage is app-private, so `save_lith_download` refuses and the picker, whose
  // grant is the only route there, is the answer.
  await onPage(
    appPage,
    async (command) => {
      if (command === 'save_lith_download') throw new Error('This platform has no Downloads folder to write to');
      return { name: 'backup.lith', path: 'content://downloads/1' };
    },
    async (harness) => {
      assert.equal(await saveTextVerifiably('backup.lith', 'bytes', true), 'saved');
      assert.deepEqual(harness.asked, ['save_lith_download', 'save_lith_file']);
    }
  );

  await onPage(
    appPage,
    async (command) => {
      if (command === 'save_lith_download') throw new Error('no Downloads folder');
      throw new Error('Save cancelled');
    },
    async () => {
      assert.equal(await saveTextVerifiably('backup.lith', 'bytes', true), 'cancelled');
    }
  );
});

test('a process without documents of its own never asks the app either', async () => {
  // `documents` is `Capabilities::local_files`, and a build that answers false has nothing to
  // write to: its own commands would be an invoke for a file it cannot hold.
  await onPage(
    appPage,
    async () => {
      throw new Error('a build with no documents must not be asked to write one');
    },
    async (harness) => {
      assert.equal(await saveTextVerifiably('backup.lith', 'bytes', false), 'started');
      assert.deepEqual(harness.asked, []);
    }
  );
});
