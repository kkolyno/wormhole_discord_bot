'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../../src/features/local-transcription/store');
const U = '111111111111111111', V = '222222222222222222';
const ids = n => Array.from({ length: n }, (_, i) => String(100000000000000000n + BigInt(i)));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'standing-store-'));
  fs.chmodSync(root, 0o700); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: new Store({ root }), file: path.join(root, '.control.json') };
}

test('session policy is persisted, defaults manual, accepts legacy absence and rejects invalid optional policy', t => {
  const { root, store } = fixture(t);
  const manual = store.createSession({ startedAt: 1 }), channel = store.createSession({ startedAt: 2, consentMode: 'channel' });
  assert.equal(manual.consentMode, 'manual'); assert.equal(new Store({ root }).getSession(channel.id).consentMode, 'channel');
  for (const mode of ['', ' channel', 'CHANNEL', false, null, 1]) {
    assert.throws(() => store.createSession({ startedAt: 3, consentMode: mode }), /SESSION_CORRUPT/);
    assert.throws(() => store.patchSession(channel.id, { consentMode: mode }), /SESSION_CORRUPT/);
  }
  const legacy = { ...manual }; delete legacy.consentMode;
  fs.writeFileSync(store.file('s', manual.id), JSON.stringify(legacy));
  assert.equal(new Store({ root }).getSession(manual.id).consentMode, undefined);
  fs.writeFileSync(store.file('s', manual.id), JSON.stringify({ ...legacy, consentMode: 'invalid' }));
  assert.throws(() => new Store({ root }), /SESSION_CORRUPT/);
});

test('old control migrates privately; optouts survive hold changes, restart and metadata pruning', t => {
  const { root, file, store } = fixture(t);
  store.setHoldUntilEmpty(true); assert.deepEqual(store.getAutomaticOptOuts(), []);
  store.setAutomaticOptOut(U, true); store.setAutomaticOptOut(V, true); store.setAutomaticOptOut(U, true);
  store.setHoldUntilEmpty(false); assert.deepEqual(store.getControl(), { holdUntilEmpty: false, automaticOptOuts: [U, V] });
  const copy = store.getAutomaticOptOuts(); copy.length = 0;
  assert.deepEqual(store.getAutomaticOptOuts(), [U, V]);
  const s = store.createSession({ startedAt: 1, consentMode: 'channel' });
  store.patchSession(s.id, { phase: 'published', endedAt: 1 }); store.prune(1000000000);
  const reloaded = new Store({ root }); assert.deepEqual(reloaded.getAutomaticOptOuts(), [U, V]);
  assert.deepEqual(fs.readdirSync(root), ['.control.json']); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8').includes('name'), false);
  reloaded.setAutomaticOptOut(U, false); assert.deepEqual(reloaded.getAutomaticOptOuts(), [V]);
  reloaded.clearAutomaticOptOuts(); assert.deepEqual(new Store({ root }).getControl(), { holdUntilEmpty: false });
});

test('control rejects extra fields, duplicate/invalid/over-cap optouts and invalid API inputs', t => {
  const { root, store, file } = fixture(t);
  for (const automaticOptOuts of [null, {}, 'ids', [U, U], ['name'], [1], ids(33)]) {
    fs.writeFileSync(file, JSON.stringify({ holdUntilEmpty: false, automaticOptOuts }), { mode: 0o600 });
    assert.throws(() => new Store({ root }), /CONTROL_CORRUPT/);
  }
  fs.writeFileSync(file, JSON.stringify({ holdUntilEmpty: false, automaticOptOuts: [], text: 'forbidden' }));
  assert.throws(() => new Store({ root }), /CONTROL_CORRUPT/);
  fs.writeFileSync(file, JSON.stringify({ holdUntilEmpty: false, automaticOptOuts: ids(32) }));
  const full = new Store({ root }); assert.throws(() => full.setAutomaticOptOut(U, true), /AUTOMATIC_OPTOUT_LIMIT/);
  assert.deepEqual(new Store({ root }).getAutomaticOptOuts(), ids(32));
  assert.throws(() => store.setAutomaticOptOut('../name', true), /INVALID_ACCOUNT_ID/);
  assert.throws(() => store.setAutomaticOptOut(U, 1), /CONTROL_CORRUPT/);
});

test('optout writes and clears fsync file plus directory; failed commits do not acknowledge memory changes', t => {
  const { root, store } = fixture(t); const sync = fs.fsyncSync;
  let files = 0, dirs = 0;
  fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory()) dirs++; else files++; return sync(fd); };
  try { store.setAutomaticOptOut(U, true); store.clearAutomaticOptOuts(); }
  finally { fs.fsyncSync = sync; }
  assert.equal(files, 2); assert.equal(dirs, 2);
  store.setAutomaticOptOut(U, true);
  const rename = fs.renameSync; fs.renameSync = () => { throw Error('private rename failure'); };
  try {
    assert.throws(() => store.setAutomaticOptOut(V, true)); assert.throws(() => store.clearAutomaticOptOuts());
    assert.throws(() => store.setHoldUntilEmpty(true));
  } finally { fs.renameSync = rename; }
  assert.deepEqual(store.getControl(), { holdUntilEmpty: false, automaticOptOuts: [U] });
  assert.deepEqual(new Store({ root }).getControl(), store.getControl());
  assert.ok(!fs.readdirSync(root).some(name => name.startsWith('.tmp-')));
});
