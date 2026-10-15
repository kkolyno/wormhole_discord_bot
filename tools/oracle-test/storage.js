'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fail } = require('./config');
function privateDir(dir) {
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const s = fs.lstatSync(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o700 || s.uid !== process.getuid()) fail('PRIVATE_DATA_DIR_REQUIRED');
}
function exclusive(file, data) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function consumeOnce(dir) {
  privateDir(dir);
  try { exclusive(path.join(dir, 'attempted.json'), JSON.stringify({ schema: 1, attemptedAt: new Date().toISOString() }) + '\n'); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const s = fs.lstatSync(path.join(dir, 'attempted.json'));
    if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o600 || s.uid !== process.getuid()) fail('PRIVATE_MARKER_REQUIRED');
    return false;
  }
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return true;
}
function cleanupSessions(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (!/^session-[A-Za-z0-9]+$/.test(name)) continue;
    // rm never follows a symlink; only our narrow namespace inside a verified private dir.
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}
function newSession(dir) {
  const p = fs.mkdtempSync(path.join(dir, 'session-')); fs.chmodSync(p, 0o700); return p;
}
module.exports = { privateDir, exclusive, consumeOnce, cleanupSessions, newSession };
