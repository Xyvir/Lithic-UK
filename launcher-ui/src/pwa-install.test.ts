import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { captureInstallPrompt, listenForPwaInstallEvents, pwaInstall, promptPwaInstall, shouldRestoreInstallOfferOnReset } from './pwa-install.ts';

class EventTargetStub extends EventTarget {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
}

function installEvent(prompt: () => Promise<void | { outcome: 'accepted' | 'dismissed' }>, userChoice?: Promise<{ outcome: 'accepted' | 'dismissed' }>) {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: typeof prompt;
    userChoice?: typeof userChoice;
  };
  event.prompt = prompt;
  event.userChoice = userChoice;
  return event;
}

test('Reset Recents restores browser offers, but leaves Tauri recents.txt alone', () => {
  assert.equal(shouldRestoreInstallOfferOnReset('webapp'), true);
  assert.equal(shouldRestoreInstallOfferOnReset('self-host'), true);
  assert.equal(shouldRestoreInstallOfferOnReset('tauri'), false);
});

test('the browser install listener captures the prompt for the UI and removes it after use', async () => {
  const target = new EventTargetStub();
  let prompts = 0;
  const stop = listenForPwaInstallEvents(target);
  const event = installEvent(async () => {
    prompts += 1;
    assert.equal(get(pwaInstall).installable, true, 'prompt starts while the click still has the install offer');
    return { outcome: 'accepted' };
  });

  target.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, 'keep Chrome from showing the prompt before the button click');
  assert.equal(get(pwaInstall).installable, true);
  assert.equal(await promptPwaInstall(), 'accepted');
  assert.equal(prompts, 1, 'the saved browser event is actually prompted');
  assert.equal(get(pwaInstall).installable, false, 'a one-use event is not offered again');
  assert.equal(await promptPwaInstall(), 'unavailable', 'the browser event cannot be reused');

  stop();
  const ignored = installEvent(async () => ({ outcome: 'accepted' }));
  target.dispatchEvent(ignored);
  assert.equal(ignored.defaultPrevented, false, 'removed listeners leave the next browser event alone');
});

test('a Tauri event is not intercepted as a browser PWA install', () => {
  const event = installEvent(async () => ({ outcome: 'accepted' }));
  assert.equal(captureInstallPrompt(event, true), false);
  assert.equal(event.defaultPrevented, false);
});

test('prompt results can come from userChoice when prompt returns no outcome', async () => {
  const event = installEvent(async () => undefined, Promise.resolve({ outcome: 'dismissed' }));
  captureInstallPrompt(event);
  assert.equal(await promptPwaInstall(), 'dismissed');
});

test('a rejected native prompt is reported as unavailable rather than hanging the offer', async () => {
  captureInstallPrompt(installEvent(async () => { throw new Error('prompt failed'); }));
  assert.equal(await promptPwaInstall(), 'unavailable');
});

test('appinstalled clears any pending prompt and marks the app installed', () => {
  const target = new EventTargetStub();
  const stop = listenForPwaInstallEvents(target);
  target.dispatchEvent(installEvent(async () => ({ outcome: 'accepted' })));
  target.dispatchEvent(new Event('appinstalled'));
  assert.deepEqual(get(pwaInstall), { installable: false, installed: true });
  stop();
});
