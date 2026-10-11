import assert from 'node:assert/strict';
import test from 'node:test';
import { readPlatformCapabilities } from './platform-capabilities.ts';

/**
 * Run with a Tauri bridge in place, and take it away again.
 *
 * The bridge is read from the global on every call (`tauriApi` in `file-bridge.ts`), so
 * installing one here is the whole of the setup, and the original is put back even when the
 * body throws: the rest of the suite runs in the same process.
 */
async function withBridge(
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
  run: () => Promise<void>
): Promise<void> {
  const globals = globalThis as { __TAURI__?: unknown };
  const original = globals.__TAURI__;
  globals.__TAURI__ = { core: { invoke } };
  try {
    await run();
  } finally {
    if (original === undefined) delete globals.__TAURI__;
    else globals.__TAURI__ = original;
  }
}

test('the app asks the platform, and reads every answer it gives', async () => {
  const asked: string[] = [];
  await withBridge(
    async (command) => {
      asked.push(command);
      return { install: false, launch_entry: null, git_sync: false, credentials: false, local_files: false };
    },
    async () => {
      const capabilities = await readPlatformCapabilities('tauri');
      assert.equal(asked[0], 'platform_capabilities');
      assert.equal(capabilities?.install, false);
      assert.equal(capabilities?.launch_entry, null);
      assert.equal(capabilities?.git_sync, false);
      assert.equal(capabilities?.credentials, false);
      // The one answer that decides where a save lands on a phone.
      assert.equal(capabilities?.local_files, false);
    }
  );
});

test('every page with no process behind it is never asked', async () => {
  let calls = 0;
  await withBridge(
    async () => {
      calls += 1;
      return {};
    },
    async () => {
      for (const mode of ['webapp', 'self-host'] as const) {
        assert.equal(await readPlatformCapabilities(mode), null);
      }
    }
  );
  assert.equal(calls, 0, 'a browser page has no command to send');
  // And a page with no bridge at all, which is the state the global is back in here,
  // answers the same way rather than throwing on a missing API.
  assert.equal(await readPlatformCapabilities('tauri'), null);
});

test('a bridge that refuses reads as no answer rather than as a refusal', async () => {
  await withBridge(
    async () => {
      throw new Error('command missing');
    },
    async () => {
      // Null is what keeps a control the platform does have: every caller treats a missing
      // field as the old behaviour, so an unreadable report cannot take a capability away.
      assert.equal(await readPlatformCapabilities('tauri'), null);
    }
  );
  await withBridge(
    async () => undefined,
    async () => {
      assert.equal(await readPlatformCapabilities('tauri'), null);
    }
  );
});
