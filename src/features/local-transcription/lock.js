'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const fail = code => Object.assign(new Error(code), { code });

// flock(2) belongs to the open-file description shared by parent and helper.
// The helper only acquires it: its exit cannot release the parent's descriptor.
// Never unlink the inode; only close our fd after ALL writer cleanup has ended.
class WriterLock {
  constructor({ root, timeoutMs = 5000, flock = '/usr/bin/flock' }) {
    this.root = root; this.timeoutMs = timeoutMs; this.flock = flock;
    this.fd = null; this.child = null; this.started = false; this.releasing = false; this.acquired = false;
  }
  async acquire() {
    if (this.started) throw fail('WRITER_LOCK_ALREADY_STARTED');
    this.started = true;
    try {
      const { stdout } = await run(this.flock, ['--version'], { timeout: 2000, maxBuffer: 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
      if (!stdout.includes('util-linux')) throw fail('WRITER_LOCK_UNAVAILABLE');
      if (this.releasing) throw fail('WRITER_LOCK_RELEASED');
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const dir = fs.lstatSync(this.root);
      if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o777) !== 0o700 || fs.realpathSync(this.root) !== path.resolve(this.root)) throw fail('WRITER_LOCK_PRIVATE_ROOT');
      const file = path.join(this.root, '.writer.lock');
      this.fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
      const stat = fs.fstatSync(this.fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw fail('WRITER_LOCK_PRIVATE_FILE');
      // Numeric stdio entries duplicate this exact OFD, not a new open of file.
      const child = this.child = spawn(this.flock, ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', this.fd], env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      });
      let helperError;
      this.closed = new Promise(resolve => {
        const timer = setTimeout(() => { helperError = fail('WRITER_LOCK_TIMEOUT'); child.kill('SIGKILL'); }, this.timeoutMs);
        child.once('error', () => { helperError = fail('WRITER_LOCK_UNAVAILABLE'); });
        child.once('close', code => { clearTimeout(timer); resolve(code); });
      });
      const code = await this.closed;
      if (helperError) throw helperError;
      if (code !== 0) throw fail(code === 73 ? 'WRITER_LOCK_BUSY' : 'WRITER_LOCK_UNAVAILABLE');
      if (this.releasing) throw fail('WRITER_LOCK_RELEASED');
      this.acquired = true;
      return this;
    } catch (error) {
      await this.release();
      if (/^WRITER_LOCK_/.test(error.code || '')) throw error;
      throw fail('WRITER_LOCK_UNAVAILABLE');
    }
  }
  async release() {
    this.releasing = true;
    // Also await a still-starting helper so no inherited fd can outlive release.
    if (this.closed) await this.closed;
    if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; }
    this.acquired = false;
  }
}
module.exports = { WriterLock };
