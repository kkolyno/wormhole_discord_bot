'use strict';
const PRODUCTION = Object.freeze({ guild: '1465125548379607094', channel: '1465125550036090883', application: '1465236568536252527' });
function fail(code) { const error = new Error(code); error.safeCode = code; throw error; }
// Local identity guard only: token structure/contents are untrusted, not authentication.
function assertTokenIdentity(token, application) {
  if (!/^\d{17,20}$/.test(application || '')) fail('TEST_APPLICATION_ID_REQUIRED');
  if (application === PRODUCTION.application) fail('PRODUCTION_APPLICATION');
  if (typeof token !== 'string' || !token) fail('DEV_TOKEN_REQUIRED');
  if (token.length > 256 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) fail('TOKEN_FORMAT_UNSUPPORTED');
  const segments = token.split('.');
  if (segments.some(segment => Buffer.from(segment, 'base64url').toString('base64url') !== segment)) fail('TOKEN_FORMAT_UNSUPPORTED');
  const first = segments[0];
  const id = Buffer.from(first, 'base64url').toString('utf8');
  if (!/^\d{17,20}$/.test(id) || Buffer.from(id).toString('base64url') !== first) fail('TOKEN_FORMAT_UNSUPPORTED');
  if (id === PRODUCTION.application) fail('PRODUCTION_APPLICATION');
  if (id !== application) fail('TOKEN_IDENTITY_MISMATCH');
}
function parseConfig(argv, env) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--preflight')) return { record: false };
  const flags = new Set(['--record', '--consent-ack']);
  const values = new Set(['--out', '--seconds']);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (args[key] !== undefined || (!flags.has(key) && !values.has(key))) fail('CONFIG_ARGUMENT');
    args[key] = flags.has(key) ? true : argv[++i];
    if (args[key] === undefined) fail('CONFIG_ARGUMENT');
  }
  if (!args['--record'] || !args['--consent-ack']) fail('CONSENT_REQUIRED');
  for (const key of ['TEST_GUILD_ID', 'TEST_VOICE_CHANNEL_ID']) {
    if (!/^\d{17,20}$/.test(env[key] || '')) fail('TEST_IDS_REQUIRED');
  }
  if (env.TEST_GUILD_ID === PRODUCTION.guild || env.TEST_VOICE_CHANNEL_ID === PRODUCTION.channel) fail('PRODUCTION_ID');
  assertTokenIdentity(env.DEV_DISCORD_TOKEN, env.TEST_APPLICATION_ID);
  const seconds = Number(args['--seconds'] ?? 30);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) fail('DURATION_LIMIT');
  if (!args['--out'] || args['--out'].startsWith('--')) fail('OUTPUT_REQUIRED');
  return { record: true, guild: env.TEST_GUILD_ID, channel: env.TEST_VOICE_CHANNEL_ID,
    token: env.DEV_DISCORD_TOKEN, application: env.TEST_APPLICATION_ID, seconds, out: args['--out'] };
}
function assertApplication(client, expected) {
  if (!/^\d{17,20}$/.test(expected || '')) fail('TEST_APPLICATION_ID_REQUIRED');
  if (expected === PRODUCTION.application) fail('PRODUCTION_APPLICATION');
  if (!client.application?.id || !client.user?.id) fail('APPLICATION_UNKNOWN');
  if (client.application.id === PRODUCTION.application || client.user.id === PRODUCTION.application) fail('PRODUCTION_APPLICATION');
  if (client.application.id !== client.user.id || client.user.id !== expected) fail('APPLICATION_IDENTITY_MISMATCH');
}
module.exports = { parseConfig, assertTokenIdentity, assertApplication, PRODUCTION, fail };
