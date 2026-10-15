'use strict';
// Offline integration: real process groups and the image's PID-1 reaper, but no
// test/legacy application entrypoints, credentials, Discord or private audio.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { supervise } = require('../oracle-test/boot');
let testGroup, legacyStarted = false;
const syntheticTest = `const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
setTimeout(() => process.exit(0), 100);`;
async function main() {
  const code = await supervise({
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, test: true,
    signals: new EventEmitter(), deadlineMs: 5000,
    spawnImpl: (file, args, options) => {
      if (args[0].endsWith('/test.js')) {
        const child = spawn(file, ['-e', syntheticTest], options);
        testGroup = child.pid;
        return child;
      }
      // A signal being sent is insufficient: every test-group member must be gone.
      assert.throws(() => process.kill(-testGroup, 0), { code: 'ESRCH' });
      legacyStarted = true;
      return spawn(file, ['-e', 'process.exit(0)'], options);
    },
  });
  assert.equal(code, 0);
  assert.equal(legacyStarted, true);
  console.log('PASS: actual orphaned test process group exited before legacy substitute; no bot login.');
}
main().catch(() => { console.error('FAIL: offline process-group handoff'); process.exitCode = 1; });
