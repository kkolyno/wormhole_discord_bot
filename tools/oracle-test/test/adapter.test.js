'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DiscordAdapter } = require('../test');
const { TARGET } = require('../config');
const { main: bootMain } = require('../boot');
const { FLAG, DATA } = require('../config');
const cfg = { ...TARGET, token: `${Buffer.from(TARGET.application).toString('base64url')}.fake.c2lnbmF0dXJl` };
const env = { DISCORD_TOKEN: cfg.token, CLIENT_ID: TARGET.application, GUILD_ID: TARGET.guild,
  VOICE_CHANNEL_ID: TARGET.channel, ALERTS_CHANNEL_ID: TARGET.alerts, DATA_DIR: DATA };
function fakeRuntime({ actualId = TARGET.application } = {}) {
  const calls = [], voice = { speaking: new EventEmitter() };
  const channel = { guildId: TARGET.guild, type: 2, permissionsFor: () => ({ has: () => true }) };
  const alerts = { guildId: TARGET.guild, type: 0, permissionsFor: () => ({ has: () => true }), send: async () => {} };
  const guild = { channels: { fetch: async id => { calls.push(['channel_fetch', id]); return id === TARGET.channel ? channel : alerts; } },
    voiceAdapterCreator: 'fixed-adapter', voiceStates: { cache: new Map() } };
  let client, connection;
  class Client extends EventEmitter {
    constructor(options) { super(); client = this; this.options = options; this.user = { id: actualId }; this.application = { id: actualId };
      this.guilds = { fetch: async () => { calls.push(['guild_fetch']); return guild; } }; }
    async login(token) { assert.equal(token, cfg.token); calls.push(['login']); this.emit('ready'); }
    async destroy() { calls.push(['destroy']); }
  }
  const load = name => name === 'discord.js' ? { Client, GatewayIntentBits: { Guilds: 1, GuildVoiceStates: 2 },
    Events: { Error: 'clientError', ShardDisconnect: 'disconnect', ShardReconnecting: 'reconnect', InteractionCreate: 'interaction',
      VoiceStateUpdate: 'voiceState', ClientReady: 'ready' }, ChannelType: { GuildVoice: 2, GuildText: 0 },
    PermissionFlagsBits: { ViewChannel: 1, Connect: 2, SendMessages: 4, AttachFiles: 8 } } :
    { VoiceConnectionStatus: { Ready: 'ready' }, joinVoiceChannel: options => {
      calls.push(['join', options]); connection = new EventEmitter(); connection.state = { status: 'connecting' };
      connection.receiver = voice; connection.destroy = () => calls.push(['disconnect_voice']); return connection;
    }, entersState: async c => { c.emit('stateChange', c.state, { status: 'ready' }); return c; } };
  const adapter = new DiscordAdapter(cfg, load);
  return { adapter, guild, calls, client, connection: () => connection, voice };
}

test('adapter guards decoded identity BEFORE constructing a client or login; actual authenticated mismatch blocks target/voice', async () => {
  let loads = 0;
  assert.throws(() => new DiscordAdapter({ ...cfg, token: 'not-a-token' }, () => { loads++; })); assert.equal(loads, 0);
  const f = fakeRuntime({ actualId: '333333333333333333' });
  await assert.rejects(f.adapter.initialize(new AbortController().signal), { safeCode: 'APPLICATION_IDENTITY_MISMATCH' });
  assert.deepEqual(f.calls, [['login']]); await f.adapter.destroy();
});

test('adapter uses only configured channels, ready voice selfDeaf:false/selfMute:true, cache voice consent and discontinuity faults', async () => {
  const f = fakeRuntime(), faults = []; f.adapter.on('fault', c => faults.push(c));
  await f.adapter.initialize(new AbortController().signal);
  assert.deepEqual(f.calls.map(c => c[0]), ['login', 'guild_fetch', 'channel_fetch', 'channel_fetch']);
  assert.equal(f.calls[2][1], TARGET.channel); assert.equal(f.calls[3][1], TARGET.alerts);
  const user = '111111111111111111'; assert.equal(await f.adapter.inVoice(user), false);
  f.guild.voiceStates.cache.set(user, { channelId: TARGET.channel }); assert.equal(await f.adapter.inVoice(user), true);
  assert.equal(await f.adapter.join(user, new AbortController().signal), f.voice);
  assert.deepEqual(f.calls.find(c => c[0] === 'join')[1], { guildId: TARGET.guild, channelId: TARGET.channel,
    adapterCreator: 'fixed-adapter', selfDeaf: false, selfMute: true });
  f.connection().emit('stateChange', { status: 'ready' }, { status: 'connecting' });
  f.client.emit('voiceState', {}, { id: user, channelId: 'other' });
  f.client.emit('voiceState', {}, { id: TARGET.application, channelId: TARGET.channel, selfDeaf: true });
  assert.deepEqual(faults, ['VOICE_DISCONTINUITY', 'CONSENTING_USER_LEFT', 'BOT_MOVED_OR_DEAFENED']);
  await f.adapter.destroy();
});

test('intentional disconnect ignores resulting bot leave/deafen and connection teardown, but a fresh join faults again', async () => {
  const f = fakeRuntime(), faults = []; f.adapter.on('fault', code => faults.push(code));
  await f.adapter.initialize(new AbortController().signal);
  const owner = '111111111111111111';
  await f.adapter.join(owner, new AbortController().signal);
  f.connection().destroy = () => {
    f.connection().emit('stateChange', { status: 'ready' }, { status: 'destroyed' });
    f.client.emit('voiceState', {}, { id: TARGET.application, channelId: null, selfDeaf: true });
    f.client.emit('voiceState', {}, { id: owner, channelId: null });
  };
  f.adapter.disconnect();
  f.client.emit('voiceState', {}, { id: TARGET.application, channelId: 'elsewhere', serverDeaf: true });
  assert.deepEqual(faults, []); // duration_limit followed by normal teardown is not incomplete.
  await f.adapter.join(owner, new AbortController().signal);
  f.client.emit('voiceState', {}, { id: TARGET.application, channelId: 'elsewhere' });
  f.client.emit('voiceState', {}, { id: TARGET.application, channelId: TARGET.channel, serverDeaf: true });
  assert.deepEqual(faults, ['BOT_MOVED_OR_DEAFENED', 'BOT_MOVED_OR_DEAFENED']);
  await f.adapter.destroy();
});

test('boot integration consumes durable attempted marker BEFORE test spawn and restart marker skips test', async () => {
  for (const alreadyAttempted of [false, true]) {
    const calls = [], storage = { privateDir: dir => { assert.equal(dir, DATA); calls.push('private'); },
      cleanupSessions: () => calls.push('cleanup'), consumeOnce: () => { calls.push('consume_marker'); return !alreadyAttempted; } };
    const result = await bootMain([FLAG], env, opts => {
      calls.push('supervisor'); assert.equal(opts.test, !alreadyAttempted); assert.equal(opts.env, env); return 0;
    }, storage);
    assert.equal(result, 0); assert.deepEqual(calls, ['private', 'cleanup', 'consume_marker', 'supervisor']);
  }
});
