#!/usr/bin/env node
'use strict';
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { config, assertTokenIdentity, assertApplication, fail } = require('./config');
const { MicTest, bounded } = require('./session');
const { privateDir } = require('./storage');
const { assertLocalTools } = require('./local-stt');
const { restOptions } = require('../feasibility/probe');
const kitRequire = createRequire(path.resolve(__dirname, '../feasibility/package.json'));
class DiscordAdapter extends EventEmitter {
  constructor(cfg, load = kitRequire) {
    super(); assertTokenIdentity(cfg.token); this.config = cfg;
    this.discord = load('discord.js'); this.voice = load('@discordjs/voice');
    this.http = new AbortController();
    const { Client, GatewayIntentBits, Events } = this.discord;
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
      rest: restOptions(this.http.signal) });
    this.client.on(Events.Error, () => this.emit('fault', 'CLIENT_ERROR'));
    this.client.on(Events.ShardDisconnect, () => this.emit('fault', 'GATEWAY_DISCONNECT'));
    this.client.on(Events.ShardReconnecting, () => this.emit('fault', 'GATEWAY_RECONNECT'));
    this.client.on(Events.InteractionCreate, i => this.emit('interaction', i));
    this.client.on(Events.VoiceStateUpdate, (old, next) => {
      if (!this.connection) return;
      if (next.id === this.owner && next.channelId !== cfg.channel) this.emit('fault', 'CONSENTING_USER_LEFT');
      if (next.id === this.client.user.id && (next.channelId !== cfg.channel || next.serverDeaf || next.selfDeaf))
        this.emit('fault', 'BOT_MOVED_OR_DEAFENED');
    });
  }
  async initialize(signal) {
    assertTokenIdentity(this.config.token); signal.throwIfAborted();
    const ready = new Promise(resolve => this.client.once(this.discord.Events.ClientReady, resolve));
    await Promise.all([this.client.login(this.config.token), ready]);
    signal.throwIfAborted(); assertApplication(this.client);
    this.guild = await this.client.guilds.fetch(this.config.guild); signal.throwIfAborted();
    this.channel = await this.guild.channels.fetch(this.config.channel); signal.throwIfAborted();
    this.alerts = await this.guild.channels.fetch(this.config.alerts); signal.throwIfAborted();
    const { ChannelType, PermissionFlagsBits: P } = this.discord;
    if (this.channel?.guildId !== this.config.guild || this.channel.type !== ChannelType.GuildVoice) fail('TARGET_VOICE_REQUIRED');
    if (this.alerts?.guildId !== this.config.guild || this.alerts.type !== ChannelType.GuildText) fail('TARGET_ALERTS_REQUIRED');
    if (!this.channel.permissionsFor(this.client.user)?.has([P.ViewChannel, P.Connect])) fail('VOICE_PERMISSIONS');
    if (!this.alerts.permissionsFor(this.client.user)?.has([P.ViewChannel, P.SendMessages, P.AttachFiles])) fail('ALERTS_PERMISSIONS');
  }
  notice(payload) { return this.alerts.send(payload); }
  result(payload) { return this.alerts.send(payload); }
  ack(i, content) { return bounded(i.reply({ content, flags: 64, allowedMentions: { parse: [] } }), 3000); }
  async inVoice(id) { return this.guild.voiceStates.cache.get(id)?.channelId === this.config.channel; }
  async join(owner, signal) {
    signal.throwIfAborted(); this.owner = owner;
    const { joinVoiceChannel, entersState, VoiceConnectionStatus: S } = this.voice;
    this.connection = joinVoiceChannel({ guildId: this.config.guild, channelId: this.config.channel,
      adapterCreator: this.guild.voiceAdapterCreator, selfDeaf: false, selfMute: true });
    let wasReady = this.connection.state.status === S.Ready;
    this.connection.on('error', () => this.emit('fault', 'VOICE_ERROR'));
    this.connection.on('stateChange', (_old, next) => {
      if (next.status === S.Ready) wasReady = true;
      else if (wasReady && !this.disconnecting) this.emit('fault', 'VOICE_DISCONTINUITY');
    });
    await entersState(this.connection, S.Ready, 14000); signal.throwIfAborted();
    return this.connection.receiver;
  }
  disconnect() { this.disconnecting = true; try { this.connection?.destroy(); } catch { this.emit('fault', 'VOICE_DESTROY_FAILED'); } }
  async disableNotice(message, components) {
    if (message) await message.edit({ components, allowedMentions: { parse: [] } });
  }
  async destroy() { this.disconnect(); this.http.abort(); await this.client.destroy(); }
}
async function main(argv = process.argv.slice(2), env = process.env, makeAdapter = c => new DiscordAdapter(c), signals = process) {
  const cfg = config(argv, env); // Exact authorization/identity before constructing a client.
  process.umask(0o077); privateDir(cfg.data); assertLocalTools();
  const adapter = makeAdapter(cfg), session = new MicTest({ adapter, config: cfg });
  const stop = () => void session.stop('signal', 'INTERRUPTED', true);
  signals.once('SIGTERM', stop); signals.once('SIGINT', stop);
  try { return await session.run(); }
  finally { signals.off('SIGTERM', stop); signals.off('SIGINT', stop); }
}
if (require.main === module) main().then(report => {
  // No IDs, payloads, transcript, paths, credentials or raw errors in logs.
  console.log(report.issues.length ? 'ORACLE_MIC_TEST_INCOMPLETE' : 'ORACLE_MIC_TEST_FINISHED');
  // The boot parent waits for actual child exit, then kills any orphan descendants.
  process.exit(report.issues.length ? 1 : 0);
}).catch(() => { console.error('ORACLE_MIC_TEST_FAILED'); process.exit(1); });
module.exports = { main, DiscordAdapter };
