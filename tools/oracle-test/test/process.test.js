'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { supervise } = require('../boot');

test('real isolated child with persistent handles exits before legacy fixture starts after watchdog; no actual bot is executed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-process-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'child-exited'), legacyMarker = path.join(dir, 'legacy-started');
  const children = [], events = [];
  t.after(() => { for (const c of children) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* isolated fixture group already gone */ } } });
  const result = await supervise({ env: {}, test: true, signals: new EventEmitter(), deadlineMs: 1000, graceMs: 1000,
    spawnImpl: (_file, args, options) => {
      const isTest = args[0].endsWith('/test.js');
      if (!isTest) { assert.equal(events.includes('test_close'), true); assert.equal(fs.existsSync(marker), true); }
      const code = isTest ?
        `process.on('SIGTERM',()=>setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},'exited');process.exit(0)},30));setInterval(()=>{},1000);` :
        `require('node:fs').writeFileSync(${JSON.stringify(legacyMarker)},'started');`;
      const child = spawn(process.execPath, ['-e', code], options); children.push(child);
      child.once('close', () => events.push(isTest ? 'test_close' : 'legacy_close')); return child;
    } });
  assert.equal(result, 0); assert.equal(children.length, 2); assert.equal(fs.existsSync(legacyMarker), true);
  assert.deepEqual(events, ['test_close', 'legacy_close']);
});
