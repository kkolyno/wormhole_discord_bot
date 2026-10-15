'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { TARGET, FLAG, DATA, config, assertApplication } = require('../config');
const { main: testMain } = require('../test');
const { main: bootMain, supervise, TEST_DEADLINE_MS, KILL_GRACE_MS, GROUP_EXIT_MS } = require('../boot');
const { privateDir, consumeOnce, cleanupSessions, newSession } = require('../storage');
const fakeToken = id => `${Buffer.from(id).toString('base64url')}.fake.c2lnbmF0dXJl`;
const env = { DISCORD_TOKEN: fakeToken(TARGET.application), GUILD_ID: TARGET.guild,
  VOICE_CHANNEL_ID: TARGET.channel, CLIENT_ID: TARGET.application, ALERTS_CHANNEL_ID: TARGET.alerts, DATA_DIR: DATA };
const tick = () => new Promise(r => setImmediate(r));
const delay = ms => new Promise(r => setTimeout(r, ms));
function temp(t) { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-')); fs.chmodSync(p, 0o700);
  t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; }

test('exact production opt-in/allowlist/token identity gates precede adapter/login boundary', async () => {
  let calls = 0;
  const invalid = [[[], env], [[FLAG, FLAG], env], [['--record'], env], [[FLAG, '--x'], env], [[FLAG], {}]];
  for (const k of ['GUILD_ID', 'VOICE_CHANNEL_ID', 'CLIENT_ID', 'ALERTS_CHANNEL_ID', 'DATA_DIR'])
    invalid.push([[FLAG], { ...env, [k]: '/wrong' }]);
  for (const token of ['', 'Bot fake', 'mfa.fake', 'abc.fake.c2lnbmF0dXJl', fakeToken('333333333333333333'),
    `${Buffer.from(TARGET.application).toString('base64url')}=.fake.c2lnbmF0dXJl`, env.DISCORD_TOKEN + '.extra',
    `${Buffer.from(TARGET.application).toString('base64url')}.bad+.safe`,
    `${Buffer.from(TARGET.application).toString('base64url')}..safe`,
    `${Buffer.from(TARGET.application).toString('base64url')}.safe.`])
    invalid.push([[FLAG], { ...env, DISCORD_TOKEN: token }]);
  for (const [args, e] of invalid) await assert.rejects(testMain(args, e, () => { calls++; }));
  assert.equal(calls, 0);
  assert.equal(config([FLAG], env).application, TARGET.application);
  assert.throws(() => assertApplication({ user: { id: TARGET.application }, application: { id: '333333333333333333' } }));
  assert.doesNotThrow(() => assertApplication({ user: { id: TARGET.application }, application: { id: TARGET.application } }));
  // The old feasibility config remains production rejecting.
  assert.throws(() => require('../../feasibility/config').assertTokenIdentity(env.DISCORD_TOKEN, TARGET.application), { safeCode: 'PRODUCTION_APPLICATION' });
});

test('only the identity segment must be canonical; opaque URL-safe auth segments are accepted without logging', () => {
  // Synthetic only: both trailing segments deliberately have noncanonical pad bits.
  const prefix = Buffer.from(TARGET.application).toString('base64url');
  const token = `${prefix}.ab._x`;
  for (const part of token.split('.').slice(1))
    assert.notEqual(Buffer.from(part, 'base64url').toString('base64url'), part);
  const accepted = config([FLAG], { ...env, DISCORD_TOKEN: token });
  assert.equal(accepted.application, TARGET.application);
  assert.ok(accepted.token === token); // Boolean assertion never prints auth material.
  const noncanonicalId = prefix.slice(0, -1) + 'x'; // Same decoded ID, different pad bits.
  assert.equal(Buffer.from(noncanonicalId, 'base64url').toString('utf8'), TARGET.application);
  assert.throws(() => config([FLAG], { ...env, DISCORD_TOKEN: `${noncanonicalId}.ab._x` }),
    { safeCode: 'TOKEN_FORMAT_UNSUPPORTED' });
});

test('boot default is legacy only; malformed opt-in never calls supervisor/login', async () => {
  let calls = 0;
  assert.equal(await bootMain([], env, o => { calls++; assert.equal(o.test, false); assert.equal(o.env, env); return 7; }), 7);
  await assert.rejects(bootMain(['--wrong'], env, () => calls++));
  await assert.rejects(bootMain([FLAG], { ...env, CLIENT_ID: 'wrong' }, () => calls++));
  assert.equal(calls, 1);
});

test('durable attempted marker is private, exclusive, one shot, and crash leftovers are removed', t => {
  const dir = temp(t); privateDir(dir);
  assert.equal(consumeOnce(dir), true);
  const first = fs.readFileSync(path.join(dir, 'attempted.json'), 'utf8');
  assert.equal(consumeOnce(dir), false); assert.equal(fs.readFileSync(path.join(dir, 'attempted.json'), 'utf8'), first);
  assert.equal(fs.statSync(path.join(dir, 'attempted.json')).mode & 0o777, 0o600);
  const session = newSession(dir); fs.writeFileSync(path.join(session, 'audio.wav'), 'fake');
  fs.writeFileSync(path.join(dir, 'do-not-touch'), 'keep');
  cleanupSessions(dir);
  assert.equal(fs.existsSync(session), false); assert.equal(fs.existsSync(path.join(dir, 'do-not-touch')), true);
  assert.equal(consumeOnce(dir), false);
});

test('private storage rejects symlink, permissive directories/markers', t => {
  const dir = temp(t); const child = path.join(dir, 'child'); fs.mkdirSync(child, { mode: 0o755 });
  assert.throws(() => privateDir(child));
  const link = path.join(dir, 'link'); fs.symlinkSync(child, link); assert.throws(() => privateDir(link));
  fs.writeFileSync(path.join(dir, 'attempted.json'), 'bad', { mode: 0o644 });
  assert.throws(() => consumeOnce(dir));
});

function supervisorFixture(options = {}) {
  const signals = new EventEmitter(), children = [], kills = [], events = [];
  const spawnImpl = (_file, args, opts) => {
    const c = new EventEmitter(); c.pid = 100 + children.length;
    children.push(c); events.push(args[0].endsWith('/test.js') ? 'test_spawn' : 'legacy_spawn');
    assert.equal(opts.detached, true); assert.equal(opts.env, env); return c;
  };
  const done = supervise({ env, test: true, signals, spawnImpl,
    killGroup: (pid, signal) => { kills.push([pid, signal]); events.push(signal); },
    isGroupAlive: () => false, groupExitMs: 40, groupPollMs: 5,
    cleanup: () => events.push('cleanup'), deadlineMs: 40, graceMs: 15, ...options });
  return { signals, children, kills, done, events };
}

test('normal and error test close precede orphan kill/cleanup/legacy spawn; unchanged environment', async () => {
  for (const fail of [false, true]) {
    const f = supervisorFixture(); assert.equal(f.children.length, 1);
    if (fail) f.children[0].emit('error', Error('secret raw error'));
    await tick(); assert.equal(f.children.length, 1);
    f.events.push('test_close'); f.children[0].emit('close', fail ? 1 : 0); await tick();
    assert.deepEqual(f.events, ['test_spawn', 'test_close', 'SIGKILL', 'cleanup', 'legacy_spawn']);
    f.children[1].emit('close', 0); assert.equal(await f.done, 0);
    assert.equal(f.signals.listenerCount('SIGTERM'), 0);
  }
});

test('watchdog TERM then KILL does not launch legacy until test actually closes', async () => {
  const f = supervisorFixture({ deadlineMs: 10, graceMs: 10 });
  await delay(35);
  assert.deepEqual(f.kills, [[100, 'SIGTERM'], [100, 'SIGKILL']]); assert.equal(f.children.length, 1);
  f.children[0].emit('close', null); await tick(); assert.equal(f.children.length, 2);
  f.children[1].emit('close', 0); await f.done;
  assert.ok(TEST_DEADLINE_MS <= 900000); assert.ok(KILL_GRACE_MS <= 10000);
});

test('shutdown propagates/waits boundedly; never starts legacy during shutdown', async () => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const f = supervisorFixture({ graceMs: 10 }); f.signals.emit(signal); await delay(25);
    assert.deepEqual(f.kills, [[100, signal], [100, 'SIGKILL']]); assert.equal(f.children.length, 1);
    f.children[0].emit('close', null); assert.equal(await f.done, 0); assert.equal(f.children.length, 1);
    assert.equal(f.events.includes('legacy_spawn'), false); assert.equal(f.events.includes('cleanup'), true);
  }
});

test('closed test group still alive after KILL times out closed without cleanup or legacy', async () => {
  const checked = [];
  const f = supervisorFixture({ isGroupAlive: pgid => { checked.push(pgid); return true; }, groupExitMs: 20 });
  f.children[0].emit('close', 0);
  assert.equal(await f.done, 1);
  assert.ok(checked.length > 1); assert.ok(checked.every(pgid => pgid === 100));
  assert.deepEqual(f.kills, [[100, 'SIGKILL']]);
  assert.equal(f.children.length, 1); assert.equal(f.events.includes('cleanup'), false);
  assert.equal(f.signals.listenerCount('SIGTERM'), 0);
  assert.ok(GROUP_EXIT_MS <= 5000);
});

test('delayed group exit is confirmed using preserved PGID before cleanup and legacy', async () => {
  let alive = true; const checks = [];
  const f = supervisorFixture({ isGroupAlive: pgid => { checks.push(pgid); return pgid === 100 && alive; }, groupExitMs: 200 });
  f.children[0].emit('error', Error('private')); f.children[0].emit('close', 1);
  await delay(15);
  assert.ok(checks.length > 1); assert.ok(checks.every(pgid => pgid === 100));
  assert.equal(f.children.length, 1); assert.equal(f.events.includes('cleanup'), false);
  alive = false; await delay(15);
  assert.deepEqual(f.events, ['test_spawn', 'SIGKILL', 'cleanup', 'legacy_spawn']);
  f.children[1].emit('close', 0); assert.equal(await f.done, 0);
});

test('unverifiable group state including EPERM fails closed without cleanup or legacy', async () => {
  for (const check of [() => { throw Object.assign(Error('private'), { code: 'EPERM' }); },
    () => { throw Error('private'); }, () => undefined]) {
    const f = supervisorFixture({ isGroupAlive: check }); f.children[0].emit('close', 0);
    assert.equal(await f.done, 1); assert.equal(f.children.length, 1);
    assert.equal(f.events.includes('cleanup'), false);
  }
});

test('failed group signal cannot be mistaken for successful termination even if exit check says gone', async () => {
  for (const failingSignal of ['SIGTERM', 'SIGKILL']) {
    const f = supervisorFixture({ killGroup: (_pgid, sig) => {
      if (sig === failingSignal) throw Object.assign(Error('private'), { code: 'EPERM' });
    } });
    if (failingSignal === 'SIGTERM') f.signals.emit('SIGTERM');
    f.children[0].emit('close', 0);
    assert.equal(await f.done, 1); assert.equal(f.children.length, 1);
    assert.equal(f.events.includes('cleanup'), false);
  }
});

test('signal while verifying closed test group never launches legacy or bypasses exit confirmation', async () => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    let alive = true, settled = false;
    const f = supervisorFixture({ isGroupAlive: () => alive, groupExitMs: 200 });
    f.done.then(() => { settled = true; });
    f.children[0].emit('close', 0); f.signals.emit(signal);
    await delay(15);
    assert.equal(settled, false); assert.equal(f.events.includes('cleanup'), false);
    alive = false; assert.equal(await f.done, 0);
    assert.deepEqual(f.events, ['test_spawn', 'SIGKILL', 'cleanup']);
    assert.equal(f.children.length, 1);
  }
});

test('marker-skip supervisor path starts legacy directly and forwards termination', async () => {
  const f = supervisorFixture({ test: false }); assert.deepEqual(f.events, ['legacy_spawn']);
  f.signals.emit('SIGTERM'); assert.deepEqual(f.kills, [[100, 'SIGTERM']]);
  f.children[0].emit('close', 0); assert.equal(await f.done, 0); assert.equal(f.children.length, 1);
});

test('test spawn failure resumes legacy, privacy cleanup failure fails closed', async () => {
  let calls = 0; const legacy = new EventEmitter(); legacy.pid = 20;
  const done = supervise({ env, test: true, signals: new EventEmitter(), killGroup() {}, isGroupAlive: () => false,
    spawnImpl: () => { if (++calls === 1) throw Error('sensitive'); return legacy; } });
  assert.equal(calls, 2); legacy.emit('close', 0); assert.equal(await done, 0);
  const f = supervisorFixture({ cleanup: () => { throw Error('private'); } });
  f.children[0].emit('close', 1); assert.equal(await f.done, 1); assert.equal(f.children.length, 1);
});
