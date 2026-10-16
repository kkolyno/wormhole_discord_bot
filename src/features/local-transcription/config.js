'use strict';
const path = require('node:path');
const ACCOUNT_ID = /^\d{17,20}$/;
const enabled = (env = process.env) => env.LOCAL_TRANSCRIPTION_ENABLED === 'true';
function configError() { return new Error('LOCAL_TRANSCRIPTION_CONFIG_INVALID'); }
function integer(env, key, fallback, min, max) {
  if (env[key] === undefined) return fallback;
  if (!/^\d+$/.test(env[key])) throw configError();
  const value = Number(env[key]);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw configError();
  return value;
}
function loadConfig(env = process.env) {
  const guildId = env.GUILD_ID, channelId = env.VOICE_CHANNEL_ID, alertsChannelId = env.ALERTS_CHANNEL_ID;
  if (![guildId, channelId, alertsChannelId].every(id => ACCOUNT_ID.test(id || ''))) throw configError();
  const root = env.LOCAL_TRANSCRIPTION_DATA_DIR || '/data/transcription';
  if (!path.isAbsolute(root) || path.normalize(root) !== root || root === '/') throw configError();
  const consentMode = env.LOCAL_TRANSCRIPTION_CONSENT_MODE === undefined ? 'manual' : env.LOCAL_TRANSCRIPTION_CONSENT_MODE;
  if (!['manual', 'channel'].includes(consentMode)) throw configError();
  return Object.freeze({
    guildId, channelId, alertsChannelId, root, consentMode,
    allowAttachments: env.LOCAL_TRANSCRIPT_ATTACHMENTS === 'true',
    restTimeoutMs: 10000,
    limits: Object.freeze({
      emptyGraceMs: integer(env, 'LOCAL_TRANSCRIPTION_EMPTY_GRACE_SECONDS', 15, 1, 3600) * 1000,
      idleMs: integer(env, 'LOCAL_TRANSCRIPTION_IDLE_SECONDS', 300, 1, 14400) * 1000,
      maxSessionMs: integer(env, 'LOCAL_TRANSCRIPTION_MAX_SESSION_SECONDS', 14400, 1, 14400) * 1000,
      maxDrainMs: integer(env, 'LOCAL_TRANSCRIPTION_MAX_DRAIN_SECONDS', 300, 1, 300) * 1000,
      maxSpoolBytes: 256 * 1024 * 1024, maxPendingJobs: 128,
      maxUtteranceBytes: 8 * 192000, maxConsenting: 8, maxParticipants: 32,
      maxTranscriptBytes: 4 * 1024 * 1024, maxRetainedSessions: 64,
      retentionMs: 24 * 60 * 60 * 1000,
    }),
  });
}
module.exports = { enabled, loadConfig, ACCOUNT_ID };
