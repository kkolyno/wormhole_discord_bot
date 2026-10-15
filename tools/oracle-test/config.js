'use strict';
const TARGET = Object.freeze({ guild: '1465125548379607094', channel: '1465125550036090883',
  application: '1465236568536252527', alerts: '1465216403241041981' });
const FLAG = '--authorized-live-oracle-test';
const DATA = '/data/oracle-test';
function fail(code) { const e = new Error(code); e.safeCode = code; throw e; }
// Local structure/identity guard, NOT authentication. Intentionally separate from
// feasibility/config.js: that kit must continue rejecting all production IDs.
function assertTokenIdentity(token) {
  if (typeof token !== 'string' || !token || token.length > 256 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) fail('TOKEN_FORMAT_UNSUPPORTED');
  const parts = token.split('.');
  // Only the identity segment has a canonical encoding contract. The remaining
  // URL-safe segments are opaque authentication material, not decoded locally.
  const id = Buffer.from(parts[0], 'base64url').toString('utf8');
  if (!/^\d{17,20}$/.test(id) || Buffer.from(id).toString('base64url') !== parts[0]) fail('TOKEN_FORMAT_UNSUPPORTED');
  if (id !== TARGET.application) fail('TOKEN_IDENTITY_MISMATCH');
}
function config(argv, env) {
  if (argv.length !== 1 || argv[0] !== FLAG) fail('EXACT_OPT_IN_REQUIRED');
  for (const [key, expected] of Object.entries({ GUILD_ID: TARGET.guild, VOICE_CHANNEL_ID: TARGET.channel,
    CLIENT_ID: TARGET.application, ALERTS_CHANNEL_ID: TARGET.alerts })) {
    if (env[key] !== expected) fail('TARGET_ALLOWLIST_MISMATCH');
  }
  if (env.DATA_DIR !== undefined && env.DATA_DIR !== DATA) fail('DATA_DIR_MISMATCH');
  assertTokenIdentity(env.DISCORD_TOKEN);
  return { ...TARGET, token: env.DISCORD_TOKEN, data: DATA };
}
function assertApplication(client) {
  if (client.user?.id !== TARGET.application || client.application?.id !== TARGET.application) fail('APPLICATION_IDENTITY_MISMATCH');
}
module.exports = { TARGET, FLAG, DATA, config, assertTokenIdentity, assertApplication, fail };
