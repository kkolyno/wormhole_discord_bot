'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { enabled, loadConfig } = require('../../src/features/local-transcription/config');
const env = { GUILD_ID: '111111111111111111', VOICE_CHANNEL_ID: '222222222222222222', ALERTS_CHANNEL_ID: '333333333333333333' };
test('strict opt-in and attachment approval default off', () => {
  for (const value of [undefined, '', 'false', 'TRUE', '1', ' true', 'true ']) assert.equal(enabled({ LOCAL_TRANSCRIPTION_ENABLED: value }), false);
  assert.equal(enabled({ LOCAL_TRANSCRIPTION_ENABLED: 'true' }), true);
  assert.equal(loadConfig(env).allowAttachments, false);
  assert.equal(loadConfig({ ...env, LOCAL_TRANSCRIPT_ATTACHMENTS: 'TRUE' }).allowAttachments, false);
  assert.equal(loadConfig({ ...env, LOCAL_TRANSCRIPT_ATTACHMENTS: 'true' }).allowAttachments, true);
  assert.equal(loadConfig(env).limits.emptyGraceMs, 90000);
  assert.equal(loadConfig(env).limits.maxSessionMs, 14400000);
});
test('invalid IDs, relative root, malformed and excessive limits fail without echoing input', () => {
  for (const extra of [{ GUILD_ID: 'private speech' }, { LOCAL_TRANSCRIPTION_DATA_DIR: '../private' }, { LOCAL_TRANSCRIPTION_DATA_DIR: '/' },
    { LOCAL_TRANSCRIPTION_MAX_SESSION_SECONDS: '14401' }, { LOCAL_TRANSCRIPTION_EMPTY_GRACE_SECONDS: '0' },
    { LOCAL_TRANSCRIPTION_MAX_DRAIN_SECONDS: '2x' }]) assert.throws(() => loadConfig({ ...env, ...extra }), { message: 'LOCAL_TRANSCRIPTION_CONFIG_INVALID' });
});
