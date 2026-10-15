#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { FLAG, config, DATA } = require('./config');
const { consumeOnce, cleanupSessions, privateDir } = require('./storage');
const TEST_DEADLINE_MS = 800000;
const KILL_GRACE_MS = 8000;
const GROUP_EXIT_MS = 3000;
const GROUP_POLL_MS = 25;
function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; }
  catch (e) { if (e.code === 'ESRCH') return false; throw e; }
}
// Separate process groups let us kill a wedged test plus its ffmpeg/whisper
// descendants. Legacy is spawned only after test close AND confirmed group exit.
function supervise({ env, test, spawnImpl = spawn, signals = process,
  killGroup = (pid, signal) => { try { process.kill(-pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } },
  isGroupAlive = groupAlive, groupExitMs = GROUP_EXIT_MS, groupPollMs = GROUP_POLL_MS,
  cleanup = () => {}, deadlineMs = TEST_DEADLINE_MS, graceMs = KILL_GRACE_MS }) {
  return new Promise(resolve => {
    let active, shutting = false, timer, killer, finished = false;
    const finish = code => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(killer);
      signals.off('SIGTERM', term); signals.off('SIGINT', interrupt); resolve(code);
    };
    const send = (run, sig) => {
      if (!Number.isSafeInteger(run.pgid) || run.pgid <= 0) { run.killFailed = true; return; }
      try { killGroup(run.pgid, sig); } catch { run.killFailed = true; } // No raw errors.
    };
    const terminate = (run, sig) => {
      clearTimeout(timer); send(run, sig);
      if (!killer) killer = setTimeout(() => {
        if (!finished && active === run && !run.closed) send(run, 'SIGKILL');
      }, graceMs);
    };
    const shutdown = sig => {
      if (shutting) return; shutting = true;
      if (!active) finish(0);
      else if (!active.closed) terminate(active, sig);
      // A closed child may still have descendants. Keep its PGID and await the
      // ongoing group-exit confirmation; shutdown must not bypass that barrier.
    };
    const term = () => shutdown('SIGTERM'), interrupt = () => shutdown('SIGINT');
    signals.on('SIGTERM', term); signals.on('SIGINT', interrupt);
    const confirmGone = async pgid => {
      const deadline = performance.now() + groupExitMs;
      for (;;) {
        const alive = isGroupAlive(pgid); // EPERM/unknown failures are NOT exit.
        if (alive === false) return;
        if (alive !== true || performance.now() >= deadline) throw Error('GROUP_EXIT_UNCONFIRMED');
        await new Promise(r => setTimeout(r, Math.min(groupPollMs, Math.max(0, deadline - performance.now()))));
      }
    };
    const launch = isTest => {
      if (shutting) return finish(0);
      const args = isTest ? [path.join(__dirname, 'test.js'), FLAG] : [path.resolve(__dirname, '../../index.js')];
      let child;
      try { child = spawnImpl(process.execPath, args, { env, detached: true, stdio: isTest ? 'ignore' : 'inherit' }); }
      catch { if (isTest) return afterTest(); return finish(1); }
      const run = active = { child, pgid: child.pid, closed: false, failed: false, killFailed: false };
      child.once('error', () => { run.failed = true; }); // close follows error; never race a child.
      child.once('close', code => {
        run.closed = true; clearTimeout(timer); clearTimeout(killer); killer = undefined;
        void (async () => {
          // Preserve PGID after the leader closes: SIGKILL delivery alone does
          // not prove that descendants have exited (and PID 1 must reap them).
          if (run.pgid !== undefined) {
            send(run, 'SIGKILL');
          } else if (!run.failed) return finish(1); // No PID is safe only for a failed spawn.
          if (run.killFailed) return finish(1);
          if (run.pgid !== undefined) await confirmGone(run.pgid);
          if (finished) return;
          active = undefined;
          if (isTest) afterTest(); else finish(shutting ? 0 : (run.failed ? 1 : code ?? 1));
        })().catch(() => finish(1)); // Cannot verify exit: no cleanup or second login.
      });
      if (isTest) timer = setTimeout(() => terminate(run, 'SIGTERM'), deadlineMs);
    };
    const afterTest = () => {
      try { cleanup(); } catch { return finish(1); } // Privacy cleanup failure: fail closed, operator intervention.
      if (shutting) finish(0); else launch(false);
    };
    launch(test);
  });
}
async function main(argv = process.argv.slice(2), env = process.env, run = supervise,
  storage = { privateDir, cleanupSessions, consumeOnce }) {
  // No opt-in means unchanged legacy behavior; unexpected flags are refused.
  if (argv.length === 0) return run({ env, test: false });
  config(argv, env); // No child/login on malformed opt-in, IDs or token identity.
  storage.privateDir(DATA);
  storage.cleanupSessions(DATA); // Crash recovery removes raw audio before any login.
  const test = storage.consumeOnce(DATA); // Durable attempted marker BEFORE spawning; crash never rearms.
  return run({ env, test, cleanup: () => storage.cleanupSessions(DATA) });
}
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(() => {
  console.error('ORACLE_TEST_BOOT_REFUSED'); process.exitCode = 1;
});
module.exports = { main, supervise, TEST_DEADLINE_MS, KILL_GRACE_MS, GROUP_EXIT_MS, GROUP_POLL_MS };
