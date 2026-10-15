'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { WriterLock } = require('../../src/features/local-transcription/lock');
function root(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcription-lock-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
test('parent OFD remains locked after the acquiring helper exits; release permits another process', async t => {
  const dir = root(t), first = new WriterLock({ root: dir });
  t.after(() => first.release());
  await first.acquire();
  assert.equal(first.child.exitCode, 0); // no long-lived holder or parent pipe
  assert.equal(await first.closed, 0);
  assert.equal(first.acquired, true);
  assert.ok(Number.isInteger(first.fd));
  const compete = () => spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', path.join(dir, '.writer.lock'), 'true']);
  assert.equal(compete().status, 73);
  await assert.rejects(new WriterLock({ root: dir }).acquire(), { code: 'WRITER_LOCK_BUSY' });
  await first.release();
  assert.equal(first.acquired, false); assert.equal(first.fd, null);
  assert.equal(compete().status, 0);
  const next = new WriterLock({ root: dir }); await next.acquire(); await next.release();
  assert.equal(fs.existsSync(path.join(dir, '.writer.lock')), true); // inode is never unlinked
});
test('real parent SIGKILL releases the lock without a holder, TTL or PID heuristics', { timeout: 10000 }, async t => {
  const dir = root(t);
  const modulePath = path.resolve(__dirname, '../../src/features/local-transcription/lock');
  const child = spawn(process.execPath, ['-e', `const {WriterLock}=require(${JSON.stringify(modulePath)});new WriterLock({root:process.argv[1]}).acquire().then(()=>{setInterval(()=>{},1000);process.stdout.write('READY\\n');});`, dir], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(Error('PARENT_PREMATURE_EXIT_' + code))); });
  await assert.rejects(new WriterLock({ root: dir }).acquire(), { code: 'WRITER_LOCK_BUSY' });
  const exited = once(child, 'exit'); child.kill('SIGKILL');
  const [code, signal] = await exited;
  assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  const next = new WriterLock({ root: dir });
  await next.acquire(); assert.equal(next.acquired, true); await next.release();
});
test('root or lock symlinks and permissive roots fail closed', async t => {
  const dir = root(t); fs.chmodSync(dir, 0o755);
  await assert.rejects(new WriterLock({ root: dir }).acquire(), { code: 'WRITER_LOCK_PRIVATE_ROOT' });
  fs.chmodSync(dir, 0o700); fs.symlinkSync('/tmp/not-a-lock', path.join(dir, '.writer.lock'));
  await assert.rejects(new WriterLock({ root: dir }).acquire(), { code: 'WRITER_LOCK_UNAVAILABLE' });
});
