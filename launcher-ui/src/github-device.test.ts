import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseDeviceCode,
  parseDevicePoll,
  pollDelayMs,
  formatUserCode,
  generateRepoName,
  partitionRepos
} from './github-device.ts';

test('parseDeviceCode extracts the code pair and timing fields', () => {
  const parsed = parseDeviceCode({
    device_code: 'd123',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    interval: 7,
    expires_in: 900
  });
  assert.equal(parsed?.device_code, 'd123');
  assert.equal(parsed?.user_code, 'ABCD-1234');
  assert.equal(parsed?.interval, 7);
});

test('parseDeviceCode rejects malformed payloads', () => {
  assert.equal(parseDeviceCode(null), null);
  assert.equal(parseDeviceCode('nope'), null);
  assert.equal(parseDeviceCode({ device_code: 'only-one' }), null);
});

test('parseDevicePoll recognizes authorized, pending, and failure shapes', () => {
  assert.deepEqual(parseDevicePoll({ access_token: 'tok' }), { kind: 'authorized', token: 'tok' });
  assert.deepEqual(parseDevicePoll({ pending: true }), { kind: 'pending', slowDown: false });
  assert.deepEqual(parseDevicePoll({ pending: true, slow_down: true }), { kind: 'pending', slowDown: true });
  const failed = parseDevicePoll({ pending: false });
  assert.equal(failed.kind, 'failed');
  assert.match(failed.kind === 'failed' ? failed.message : '', /failed or expired/i);
  assert.equal(parseDevicePoll(null).kind, 'failed');
});

test('pollDelayMs honors the interval and the slow_down penalty', () => {
  assert.equal(pollDelayMs(undefined, false), 5000);
  assert.equal(pollDelayMs(7, false), 7000);
  assert.equal(pollDelayMs(5, true), 10000);
  assert.equal(pollDelayMs(0, false), 1000);
});

test('formatUserCode groups the code for readability', () => {
  assert.equal(formatUserCode('ABCD-1234'), 'ABCD-1234');
  assert.equal(formatUserCode('abcd1234'), 'ABCD-1234');
  assert.equal(formatUserCode('ABC'), 'ABC');
  assert.equal(formatUserCode('a b c d 1'), 'ABCD-1');
});

test('generateRepoName uses the lithic-sync prefix without ambiguous characters', () => {
  const name = generateRepoName(() => 0); // deterministic: first char of the alphabet
  assert.match(name, /^lithic-sync-[a-z2-9]{4}$/);
  assert.ok(!/[0o1il]/.test(name.slice('lithic-sync-'.length)));
});

test('partitionRepos splits Lithic-managed repos from the rest', () => {
  const { managed, other } = partitionRepos([
    { full_name: 'octocat/lithic-sync-ab2d' },
    { full_name: 'octocat/lithic-backup-old' },
    { full_name: 'octocat/my-notes' },
    { full_name: '' },
    { full_name: 'octo/lithic-custom-tool' }
  ]);
  assert.deepEqual(managed, ['octocat/lithic-sync-ab2d', 'octocat/lithic-backup-old', 'octo/lithic-custom-tool']);
  assert.deepEqual(other, ['octocat/my-notes']);
});
