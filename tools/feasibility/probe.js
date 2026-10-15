#!/usr/bin/env node
'use strict';
const { parseConfig, assertTokenIdentity, assertApplication, fail } = require('./config');
const { preflight } = require('./codec');

// Public RESTOptions.makeRequest seam: managers do not forward request signals.
// Compose shutdown + per-request deadlines at the actual HTTP boundary, including
// response-body reads. Never retry or wait through REST rate-limit queues.
function restOptions(signal, request = globalThis.fetch) {
  return { retries: 0, timeout: 3000, rejectOnRateLimit: () => true,
    makeRequest: (url, init) => {
      const combined = AbortSignal.any([signal, AbortSignal.timeout(3000), ...(init.signal ? [init.signal] : [])]);
      combined.throwIfAborted();
      return request(url, { ...init, signal: combined });
    } };
}
async function fetchTarget(client, config, signal) {
  signal.throwIfAborted();
  const guild = await client.guilds.fetch(config.guild);
  signal.throwIfAborted(); // A shutdown during guild fetch must never start channel fetch.
  const channel = await guild.channels.fetch(config.channel);
  signal.throwIfAborted();
  return { guild, channel };
}
async function run(config) {
  assertTokenIdentity(config.token, config.application); // Defense before constructing client/login.
  const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, Events } = require('discord.js');
  const { joinVoiceChannel, entersState, VoiceConnectionStatus, EndBehaviorType } = require('@discordjs/voice');
  const { Capture } = require('./capture');
  const shutdown = new AbortController();
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    rest: restOptions(shutdown.signal) });
  let connection, capture, timer, hardTimer, stopping, resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const stop = (reason, issue) => {
    if (stopping) return stopping;
    // Cancel HTTP immediately, not just the await/race, before bounded drain.
    shutdown.abort();
    clearTimeout(timer); clearTimeout(hardTimer);
    stopping = (async () => {
      if (issue && capture) capture.notes.add(issue);
      let manifest;
      try { if (capture) manifest = await capture.stop(reason); }
      finally {
        try { connection?.destroy(); } catch { /* sanitized below via outcome */ }
        let cleanupTimer;
        try {
          await Promise.race([client.destroy(), new Promise(resolve => {
            cleanupTimer = setTimeout(() => {
              console.error(JSON.stringify({ error: 'CLIENT_CLEANUP_TIMEOUT' })); process.exitCode = 1; resolve();
            }, 2000);
          })]);
        } catch { console.error(JSON.stringify({ error: 'CLIENT_CLEANUP_FAILED' })); process.exitCode = 1; }
        finally { clearTimeout(cleanupTimer); }
        process.off('SIGINT', sigint); process.off('SIGTERM', sigterm);
        resolveDone();
      }
      if (manifest) console.log(JSON.stringify({ outcome: manifest.outcome, issues: manifest.issues,
        packets: manifest.packets, pcmBytes: manifest.pcmBytes })); // No payload, ids, paths, exceptions or token.
      else console.log(JSON.stringify({ outcome: 'incomplete', issues: [issue || 'CAPTURE_NOT_STARTED'], reason }));
      if (!manifest || manifest.outcome === 'incomplete') process.exitCode = 1;
    })();
    return stopping;
  };
  const sigint = () => void stop('signal', 'INTERRUPTED');
  const sigterm = () => void stop('signal', 'INTERRUPTED');
  process.once('SIGINT', sigint); process.once('SIGTERM', sigterm);
  client.on(Events.Error, () => void stop('client_error', 'CLIENT_ERROR'));
  client.on(Events.ShardDisconnect, () => void stop('gateway_disconnect', 'GATEWAY_DISCONNECT'));
  client.on(Events.ShardReconnecting, () => void stop('gateway_reconnect', 'RECONNECT_NOT_VALIDATED'));
  client.on(Events.VoiceStateUpdate, (old, next) => {
    if (!capture || (old.channelId !== config.channel && next.channelId !== config.channel)) return;
    // A moving/deafened bot cannot claim continuous capture; user joins/leaves are normal.
    if (next.id === client.user.id && (next.channelId !== config.channel || next.serverDeaf || next.selfDeaf)) {
      void stop('bot_voice_state', 'BOT_MOVED_OR_DEAFENED');
    }
  });
  const ready = new Promise(resolve => client.once(Events.ClientReady, resolve));
  hardTimer = setTimeout(() => void stop('startup_timeout', 'STARTUP_TIMEOUT'), 20000);
  try {
    await Promise.race([Promise.all([client.login(config.token), ready]), done]);
    if (stopping) return await stopping;
    // This check is deliberately after identity is established and before *any* voice join.
    assertApplication(client, config.application);
    const { guild, channel } = await fetchTarget(client, config, shutdown.signal);
    if (stopping) return await stopping;
    if (!channel || channel.guildId !== config.guild || channel.type !== ChannelType.GuildVoice) fail('TEST_VOICE_CHANNEL_REQUIRED');
    const perms = channel.permissionsFor(client.user);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) fail('VOICE_PERMISSIONS');
    connection = joinVoiceChannel({ guildId: config.guild, channelId: config.channel,
      adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: true });
    connection.on('error', () => void stop('voice_error', 'VOICE_ERROR'));
    capture = new Capture({ out: config.out, receiver: connection.receiver, manualEnd: EndBehaviorType.Manual,
      limits: { maxDurationMs: config.seconds * 1000 },
      onFault: () => void stop('capture_failure') });
    timer = setTimeout(() => void stop('duration'), config.seconds * 1000);
    let wasReady = false;
    connection.on('stateChange', (old, next) => {
      if (next.status === VoiceConnectionStatus.Ready) wasReady = true;
      else if (wasReady) void stop('voice_discontinuity', 'RECONNECT_NOT_VALIDATED');
    });
    await Promise.race([entersState(connection, VoiceConnectionStatus.Ready, 15000), done]);
    if (stopping) return await stopping;
    clearTimeout(hardTimer);
    // Ready precedes actual RTP traffic; receiver speaking.start subscribes before pushing its first packet.
    await done;
    if (stopping) await stopping;
  } catch (error) {
    console.error(JSON.stringify({ error: error.safeCode || 'PROBE_FAILED' }));
    await stop('failure', 'PROBE_FAILED'); process.exitCode = 1;
  }
}
async function main(argv = process.argv.slice(2), env = process.env, live = run) {
  const config = parseConfig(argv, env); // Must pass explicit safety gates before live code is called.
  if (!config.record) { const report = preflight(); console.log(JSON.stringify(report, null, 2)); return report; }
  preflight(); // Offline load check before login. No automatic env-file support.
  return live(config);
}
if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ error: error.safeCode || 'PREFLIGHT_OR_CONFIG_FAILED' })); process.exitCode = 1;
});
module.exports = { main, restOptions, fetchTarget };
