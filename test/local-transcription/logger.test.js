'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../src/core/logger.js'), 'utf8');
function fixture(enabled) {
  const lines = [], sent = [], module = { exports: {} };
  const output = (...args) => lines.push(args.join(' '));
  vm.runInNewContext(source, { module, exports: module.exports, process: { env: { LOCAL_TRANSCRIPTION_ENABLED: enabled } },
    console: { log: output, warn: output, error: output }, Date,
    require: name => { assert.equal(name, './config'); return { CONFIG: { logChannelId: 'log', guildId: 'guild' } }; } });
  const { logger } = module.exports;
  logger.logChannel = { send: async text => sent.push(text) };
  return { logger, lines, sent };
}
test('transcription logger suppresses private HTTP error message/stack without even inspecting them', async () => {
  const f = fixture('true');
  const error = { get message() { throw Error('message must not be read'); }, get stack() { throw Error('stack must not be read'); } };
  await f.logger._log('ERROR', 'Operation failed', error);
  assert.match(f.lines.join('\n'), /Operation failed: details suppressed/);
  assert.match(f.sent.join('\n'), /Details suppressed/);
  assert.doesNotMatch(f.lines.join('\n') + f.sent.join('\n'), /must not be read/);
});
test('transcription logger init and Discord logging failures expose stable codes, not raw errors', async () => {
  const f = fixture('true'), secret = Error('PRIVATE_FAKE_TRANSCRIPT_TOKEN_PATH');
  f.logger.setClient({ guilds: { fetch: async () => { throw secret; } } });
  await f.logger.init();
  f.logger.logChannel = { send: async () => { throw secret; } };
  await f.logger._log('ERROR', 'Operation failed', secret);
  assert.match(f.lines.join('\n'), /LOG_CHANNEL_INIT_FAILED/);
  assert.match(f.lines.join('\n'), /LOG_DELIVERY_FAILED/);
  assert.doesNotMatch(f.lines.join('\n'), /PRIVATE_FAKE_TRANSCRIPT_TOKEN_PATH/);
});
test('strict opt-in keeps original legacy error diagnostics unchanged otherwise', async () => {
  for (const value of [undefined, 'false', 'TRUE', '1']) {
    const f = fixture(value); await f.logger._log('WARN', 'Legacy operation', Error('legacy detail'));
    assert.match(f.lines.join('\n'), /legacy detail/); assert.match(f.sent.join('\n'), /legacy detail/);
  }
});
