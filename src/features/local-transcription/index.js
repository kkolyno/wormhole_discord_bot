'use strict';
const { Events, GatewayIntentBits, MessageFlags, SlashCommandBuilder, Routes } = require('discord.js');
const { loadConfig, ACCOUNT_ID } = require('./config');

const BUTTONS = Object.freeze({
  local_transcription_consent: 'consent',
  local_transcription_revoke: 'revoke',
  local_transcription_end: 'end',
});
const safeError = code => Object.assign(new Error(code), { code });
function configureRest(client, timeoutMs = 10000) {
  Object.assign(client.rest.options, { timeout: timeoutMs, retries: 0, rejectOnRateLimit: () => true });
}
function createTransport(client, config, stopSignal) {
  configureRest(client, config.restTimeoutMs);
  async function request(method, route, options = {}) {
    if (stopSignal?.aborted) throw safeError('TRANSCRIPTION_TRANSPORT_FAILED');
    const abort = new AbortController();
    const signal = stopSignal ? AbortSignal.any([abort.signal, stopSignal]) : abort.signal;
    let timer;
    try {
      return await Promise.race([
        client.rest[method](route, { ...options, signal }),
        new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(safeError('TRANSCRIPTION_TRANSPORT_TIMEOUT')); }, config.restTimeoutMs); }),
      ]);
    } catch { throw safeError('TRANSCRIPTION_TRANSPORT_FAILED'); }
    finally { clearTimeout(timer); }
  }
  function wire(payload) {
    const files = (payload.files || []).map(file => {
      if (!Buffer.isBuffer(file.attachment) || !/^[A-Za-z0-9._-]{1,80}$/.test(file.name || '')) throw safeError('TRANSCRIPTION_PAYLOAD_INVALID');
      return { data: file.attachment, name: file.name, contentType: 'text/plain; charset=utf-8' };
    });
    return { body: {
      content: payload.content,
      components: payload.components?.map(component => component.toJSON ? component.toJSON() : component),
      allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
      nonce: payload.nonce, enforce_nonce: payload.enforceNonce ?? payload.enforce_nonce,
      attachments: files.length ? files.map((file, id) => ({ id, filename: file.name })) : payload.attachments,
    }, files };
  }
  return {
    botUserId: client.user.id,
    async send(payload) {
      const result = await request('post', Routes.channelMessages(config.alertsChannelId), wire(payload));
      if (!ACCOUNT_ID.test(result?.id || '')) throw safeError('TRANSCRIPTION_TRANSPORT_FAILED');
      return { id: result.id };
    },
    async edit(id, payload) {
      if (!ACCOUNT_ID.test(id || '')) throw safeError('TRANSCRIPTION_PAYLOAD_INVALID');
      await request('patch', Routes.channelMessage(config.alertsChannelId, id), wire(payload));
    },
    async history({ limit, before } = {}) {
      const bounded = Math.min(100, Math.max(1, Number.isSafeInteger(limit) ? limit : 50));
      if (before !== undefined && !ACCOUNT_ID.test(before)) throw safeError('TRANSCRIPTION_PAYLOAD_INVALID');
      const query = new URLSearchParams({ limit: String(bounded), ...(before ? { before } : {}) });
      const messages = await request('get', Routes.channelMessages(config.alertsChannelId), { query });
      if (!Array.isArray(messages) || messages.length > bounded) throw safeError('TRANSCRIPTION_TRANSPORT_FAILED');
      return messages.map(message => ({ id: message.id, authorId: message.author?.id,
        content: typeof message.content === 'string' ? message.content.slice(0, 2000) : '',
        createdTimestamp: Date.parse(message.timestamp),
      }));
    },
  };
}

// Fetch failure and gateway discontinuity are UNKNOWN, never an empty room.
async function voiceSnapshot(client, config, known = true) {
  if (!known) return null;
  try {
    const guild = await client.guilds.fetch(config.guildId);
    if (!guild || guild.available === false) return null;
    const channel = await guild.channels.fetch(config.channelId);
    if (!channel || !channel.isVoiceBased() || channel.guild.id !== config.guildId || !channel.members) return null;
    const result = [];
    for (const member of channel.members.values()) {
      if (member.user?.bot) continue;
      if (!ACCOUNT_ID.test(member.id || '') || !member.user) return null;
      result.push({ id: member.id, name: String(member.displayName || member.user.username || 'Participant').slice(0, 80) });
      if (result.length > 32) break; // bounded over-cap snapshot lets core fault explicitly
    }
    return result;
  } catch { return null; }
}
// Only these fixed codes may be displayed, never an arbitrary error/string.
const STATUS_ISSUES = new Set([
  'CORE_FAILURE', 'CORE_STORAGE_OR_LIFECYCLE_FAILED', 'FEATURE_FAILURE', 'STARTUP_FAILURE', 'GATEWAY_INTERRUPTION',
  'AUTOMATIC_OPTOUT_FAILED',
  'CONSENT_LIMIT', 'PARTICIPANT_LIMIT', 'SESSION_LIMIT', 'QUEUE_LIMIT', 'SPOOL_LIMIT', 'JOB_RECORD_LIMIT',
  'PCM_PACKET_INVALID', 'PCM_WRITE_FAILED', 'PCM_STORAGE_FAILED', 'PCM_ACCOUNTING_MISMATCH',
  'SCHEDULER_STORE_FAILED', 'SCHEDULER_CALLBACK_FAILED', 'RECOGNITION_FAILED', 'RECOGNITION_TIMEOUT',
  'RECOGNITION_ABORTED', 'RECOGNITION_OUTPUT_INVALID', 'DRAIN_TIMEOUT', 'OCCUPANCY_UNKNOWN',
  'CAPTURE_CLOSE_FAILED', 'CAPTURE_CHECKPOINT_FAILED', 'CAPTURE_EOF_UNCONFIRMED', 'AUDIO_CLOSE_TIMEOUT',
  'AUDIO_OPEN_OR_SUBSCRIBE_FAILED', 'AUDIO_UNSUBSCRIBE_FAILED', 'LATE_AUDIO_CLOSE_FAILED',
  'NOTICE_CLOSE_FAILED', 'NOTICE_FAILED_OR_UNCERTAIN', 'PUBLICATION_FAILED_OR_UNCERTAIN',
  'SHUTDOWN_CHECKPOINT_FAILED', 'SHUTDOWN_INTERRUPTED', 'RESTART_INTERRUPTED', 'AUTOMATIC_OPTOUT_FAILED',
  'AUDIO_INTERRUPTED', 'AUDIO_OPEN_FAILED', 'BOT_MOVED_OR_DEAFENED', 'CLIENT_ERROR',
  'DECODER_CLOSE_FAILED', 'DECODE_FAILED', 'DRAIN_INCOMPLETE', 'GATEWAY_DISCONNECT', 'GATEWAY_RECONNECT',
  'PACKET_QUEUE_LIMIT', 'PACKET_SIZE_LIMIT', 'PCM_FORMAT_OR_SIZE', 'PCM_HOOK_FAILED',
  'RECEIVER_ROUTING_DETACH_FAILED', 'RECEIVE_ERROR', 'ROUTING_DETACH_FAILED', 'ROUTING_MAP_UNAVAILABLE',
  'SPEAKER_LIMIT', 'STALE_STREAM', 'STREAM_CLOSE_FAILED', 'STREAM_CLOSE_TIMEOUT', 'SUBSCRIBE_OR_DECODER_FAILED',
  'UNEXPECTED_EOF', 'UNEXPECTED_STREAM_CLOSE', 'VOICE_DESTROY_FAILED', 'VOICE_DISCONTINUITY', 'VOICE_ERROR',
]);
function statusText(status = {}, state = 'starting') {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1000000) : 'unknown';
  const bool = value => value === true ? 'yes' : value === false ? 'no' : 'unknown';
  const lifecycle = status.failed === true ? 'faulted' : status.shuttingDown === true ? 'stopping'
    : status.initialized === true ? 'running' : ['starting', 'stopping', 'stopped', 'faulted'].includes(state) ? state : 'running';
  const policy = status.consentMode === 'channel' ? 'channel' : status.consentMode === undefined || status.consentMode === 'manual' ? 'manual' : 'unknown';
  const paused = Number.isSafeInteger(status.automaticOptOuts) && status.automaticOptOuts >= 0 && status.automaticOptOuts <= 32 ? status.automaticOptOuts : 'unknown';
  const issue = status.issue === null ? 'none' : STATUS_ISSUES.has(status.issue) ? status.issue : status.issue === undefined ? 'unknown' : 'unrecognized (details withheld)';
  return `Local transcription: ${lifecycle}; recording: ${bool(status.recording)}; consenting: ${count(status.consenting)}; occupancy: ${count(status.occupancy)}. ` +
    `Queue: ${count(status.pendingJobs)}; draining: ${count(status.draining)}; incomplete: ${count(status.incomplete)}; held/uncertain: ${count(status.held)}. ` +
    `Hold until empty: ${bool(status.holdUntilEmpty)}; failed: ${bool(status.failed)}; issue: ${issue}. ` +
    `Fixed consent policy: ${policy}; paused microphones: ${paused}. ` +
    (policy === 'channel' ? 'Automatic under administrator-confirmed company standing consent, including one person. Restart/reconnect can resume only with known occupancy and no safety/End hold; personal pauses persist until resume or known empty. ' :
      policy === 'manual' ? 'Recording requires explicit consent for each account; leave, interruption, or restart revokes it. ' : 'Consent policy unavailable; no automatic authorization is assumed. ') +
    'Held/uncertain publication requires review; transcript text is never shown in status.';
}
function cachedVoiceMember(client, config, userId) {
  const guild = client.guilds.cache?.get(config.guildId);
  const channel = guild?.channels.cache?.get(config.channelId);
  const member = channel?.members?.get(userId);
  return !!guild && guild.available !== false && channel?.isVoiceBased() === true &&
    channel.guild?.id === config.guildId && member?.id === userId && !!member.user && member.user.bot === false;
}
function createFeature(deps = {}) {
  let config, client, coordinator, lock, capture, timer, cleanupPromise, startupPromise;
  let state = 'starting', known = false, stopped = false, generation = 0, gatewayAvailable = true;
  let observed = new Set();
  // Own only currently pending grants. A later Stop cancels an earlier Resume
  // stalled on snapshot/interaction HTTP before it can call core's grant method.
  const pendingGrants = new Map();
  const transportStop = new AbortController();
  const getConfig = () => config || (config = deps.config || loadConfig());
  const invalidateAll = () => { for (const id of observed) coordinator?.invalidate(id); };
  const snapshot = () => voiceSnapshot(client, getConfig(), known && gatewayAvailable);
  async function refresh() {
    if (!coordinator || stopped) return;
    const epoch = generation;
    const members = await snapshot();
    if (stopped || generation !== epoch) return;
    const current = new Set((members || []).map(member => member.id));
    for (const id of observed) if (!members || !current.has(id)) coordinator.invalidate(id);
    observed = current;
    await coordinator.membership(members);
  }
  async function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    stopped = true; state = 'stopping'; clearInterval(timer);
    // Normal close owns the receiver EOF/drain barrier. Revoking here would
    // discard already-consented buffered tail before coordinator.shutdown().
    cleanupPromise = (async () => {
      // A signal during lock acquisition/recovery must not let startup create a
      // writer after cleanup returned and the client was destroyed.
      if (startupPromise) await startupPromise;
      // Keep the lock if checkpointing fails. Process exit is the final release;
      // another writer must never race an unfinished coordinator shutdown.
      if (coordinator) await coordinator.shutdown();
      if (capture) await capture.close();
      if (lock) await lock.release();
      state = 'stopped';
    })();
    return cleanupPromise;
  }
  async function failClosed(code) {
    stopped = true; state = 'faulted'; known = false; clearInterval(timer); invalidateAll(); transportStop.abort();
    // Closing capture starts immediately, not behind a serialized lifecycle queue.
    const close = capture ? Promise.resolve(capture.close()).catch(() => {}) : Promise.resolve();
    let fault, shutdown;
    try { fault = coordinator?.fault(code); } catch {}
    // Fault shutdown also synchronously pauses/aborts the recognizer.
    try { shutdown = coordinator?.shutdown(); } catch {}
    await Promise.allSettled([close, fault, shutdown]);
  }
  async function guarded(operation) {
    try { await operation(); } catch { await failClosed('FEATURE_FAILURE'); }
  }
  async function button(interaction, action) {
    let grantToken;
    const userId = interaction.user?.id;
    try {
      const cfg = getConfig();
      if (!coordinator || stopped || (action !== 'revoke' && (!known || !gatewayAvailable)) || interaction.guildId !== cfg.guildId || interaction.channelId !== cfg.alertsChannelId ||
        interaction.user?.bot || !ACCOUNT_ID.test(interaction.user?.id || '') || interaction.message?.author?.id !== client.user.id) return await deny(interaction);
      // Exact durable current notice; IDs remain static across restarts.
      const active = store.listSessions().find(session => session.phase === 'active' && session.notice?.state === 'sent' && session.notice.id === interaction.message.id);
      if (!active) return await deny(interaction);
      let cutoff;
      const epoch = generation;
      if (action === 'end') {
        // The gateway's current local voice cache is sufficient for a privacy
        // cutoff. No membership fetch or interaction HTTP may precede it.
        if (!cachedVoiceMember(client, cfg, interaction.user.id)) return await deny(interaction);
        invalidateAll();
        cutoff = Promise.resolve(coordinator.end(interaction.message.id));
        cutoff.catch(() => {}); // observe failures even while acknowledgement stalls
      } else if (action === 'revoke') {
        // A present or already-accounted participant may conservatively pause
        // their own mic without HTTP. Strangers cannot fill durable optout slots.
        if (!active.participants?.[userId] && !cachedVoiceMember(client, cfg, userId)) return await deny(interaction);
        pendingGrants.delete(userId);
        // Core synchronously cuts gates AND persists standing-policy suppression.
        // Exact notice/account authorization above needs no later snapshot HTTP.
        cutoff = Promise.resolve(coordinator.revoke(userId, interaction.message.id));
        cutoff.catch(() => {}); // acknowledgement may hang or fail independently
      } else {
        if (!pendingGrants.has(userId) && pendingGrants.size >= 32) return await deny(interaction);
        grantToken = Symbol(); pendingGrants.set(userId, grantToken);
        const members = await snapshot();
        if (generation !== epoch || !members || members.length > 32 || !members.some(member => member.id === interaction.user.id)) return await deny(interaction);
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!cutoff && (stopped || !known || !gatewayAvailable || generation !== epoch ||
        pendingGrants.get(userId) !== grantToken)) {
        await interaction.editReply({ content: 'Voice membership changed; no new consent was assumed. Try the current notice again.' });
        return;
      }
      const accepted = cutoff ? await cutoff : await coordinator.consent(userId, interaction.message.id);
      if (accepted === false) {
        await interaction.editReply({ content: 'Local transcription action was not accepted. No new consent was assumed; recording may be unavailable or at its safety limit.' });
        return;
      }
      const channelPolicy = active.consentMode === 'channel';
      await interaction.editReply({ content: action === 'consent' ? (channelPolicy ? 'Your microphone resumed under company standing consent. Shared microphone: ensure everyone audible has consented; otherwise stop your microphone.' : 'Consent recorded for your account only. Shared microphone: obtain permission from everyone audible; otherwise stop your microphone.') : action === 'revoke' ? (channelPolicy ? 'Your microphone is paused until you explicitly resume on the current notice or the channel is known empty.' : 'Your microphone consent has been revoked.') : 'Session capture ended. A known empty channel is required before a new session.' });
    } catch {
      try { if (interaction.deferred) await interaction.editReply({ content: 'Local transcription action unavailable. No consent was assumed.' }); else await deny(interaction); } catch {}
    } finally {
      if (grantToken && pendingGrants.get(userId) === grantToken) pendingGrants.delete(userId);
    }
  }
  async function deny(interaction) {
    await interaction.reply({ content: 'This action requires the current session notice and your presence in its voice channel.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  let store;
  return {
    name: 'local-transcription', intents: [GatewayIntentBits.GuildVoiceStates],
    validate: getConfig, configureClient: configureRest, cleanup,
    buttonHandlers: Object.fromEntries(Object.entries(BUTTONS).map(([id, action]) => [id, interaction => button(interaction, action)])),
    commands: [{ data: new SlashCommandBuilder().setName('transcription-status').setDescription('Show bounded local transcription state (no transcript text)'),
      async execute(interaction) {
        try {
          if (interaction.guildId !== getConfig().guildId || interaction.user?.bot) return;
          await interaction.reply({ content: statusText(coordinator?.status() || { consentMode: getConfig().consentMode }, state), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        } catch { /* No private error escapes to the global logger. */ }
      } }],
    events: [
      { name: Events.VoiceStateUpdate, execute(oldState, newState) {
        const cfg = getConfig();
        if ((oldState.guild?.id || newState.guild?.id) !== cfg.guildId) return;
        generation++;
        // This executes synchronously before snapshot fetch or coordinator queue.
        if (oldState.channelId === cfg.channelId && newState.channelId !== cfg.channelId) coordinator?.invalidate(oldState.id || newState.id);
        if (!known || stopped) return;
        return guarded(refresh);
      } },
      ...[Events.ShardDisconnect, Events.ShardReconnecting, Events.Invalidated].map(name => ({ name, execute() {
        generation++; gatewayAvailable = false; known = false; invalidateAll();
        return guarded(async () => { await coordinator?.membership(null); await coordinator?.fault('GATEWAY_INTERRUPTION'); });
      } })),
      ...[Events.ShardResume, Events.ShardReady].map(name => ({ name, execute() {
        // Track continuity even while acquire()/recovery has not created core.
        generation++; gatewayAvailable = true;
        if (!stopped) { known = true; if (coordinator) return guarded(refresh); }
      } })),

    ],
    async onStartup(discordClient) {
      if (client || stopped) return;
      client = discordClient;
      startupPromise = (async () => { try {
        const cfg = getConfig();
        const Lock = deps.WriterLock || require('./lock').WriterLock;
        lock = new Lock({ root: cfg.root });
        await lock.acquire();
        if (stopped || !lock.acquired) { await lock.release(); return; }
        const Store = deps.Store || require('./store').Store;
        const Audio = deps.Audio || require('./audio').Audio;
        const Publisher = deps.Publisher || require('./publisher').Publisher;
        const Coordinator = deps.Coordinator || require('./coordinator').Coordinator;
        const recognize = deps.recognize || require('./recognizer').recognize;
        store = new Store({ root: cfg.root, limits: cfg.limits });
        const audio = new Audio({ client, guildId: cfg.guildId, channelId: cfg.channelId });
        const audioPort = { async open(options) {
          if (stopped || !lock.acquired) throw safeError('CAPTURE_DISABLED');
          const handle = await audio.open(options);
          capture = handle;
          if (stopped || !lock.acquired) { await handle.close(); throw safeError('CAPTURE_DISABLED'); }
          return handle;
        } };
        const publisher = new Publisher({ store, transport: createTransport(client, cfg, transportStop.signal), allowAttachments: cfg.allowAttachments });
        coordinator = new Coordinator({ store, audio: audioPort, recognize, publisher, limits: cfg.limits, consentMode: cfg.consentMode });
        const recoveryGeneration = generation;
        await coordinator.init(); // Recovery MUST precede current room membership.
        if (stopped || !lock.acquired) return;
        known = gatewayAvailable && generation === recoveryGeneration; state = 'idle';
        await refresh();
        if (stopped) return;
        let ticking = false, refreshing = false, nextRefresh = Date.now() + 5000;
        timer = setInterval(() => {
          if (stopped) return;
          if (!ticking) {
            ticking = true;
            guarded(() => coordinator.tick()).finally(() => { ticking = false; });
          }
          // A transient snapshot failure must recover even if nobody triggers
          // another voice event. Coalesce retries; never infer occupancy while
          // the gateway is disconnected or delay tick deadlines behind HTTP.
          if (!refreshing && known && gatewayAvailable && Date.now() >= nextRefresh) {
            refreshing = true; nextRefresh = Date.now() + 5000;
            guarded(refresh).finally(() => { refreshing = false; });
          }
        }, 250);
        timer.unref?.();
      } catch {
        await failClosed('STARTUP_FAILURE');
        // Registry startup catches and logs raw exceptions: never throw one there.
      } })();
      return startupPromise;
    },
  };
}
module.exports = { ...createFeature(), createFeature, createTransport, configureRest, voiceSnapshot, statusText, BUTTONS };
