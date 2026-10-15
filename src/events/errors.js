const { Events } = require('discord.js');
const { logger } = require('../core/logger');
const privateMode = () => process.env.LOCAL_TRANSCRIPTION_ENABLED === 'true';
const errorEvents = [
  { name: Events.Error, execute(error) { logger.error('Discord client error', privateMode() ? null : error); } },
  { name: Events.ShardError, execute(error, shardId) { logger.error(`Shard ${shardId} error`, privateMode() ? null : error); } },
  { name: Events.ShardDisconnect, execute(event, shardId) { logger.warn(`Shard ${shardId} disconnected (code: ${event.code})`); } },
  { name: Events.ShardReconnecting, execute(shardId) { logger.info(`Shard ${shardId} reconnecting...`); } },
];

// One global deadline includes cleanup AND destroy. Callbacks are awaited, not
// fire-and-forget. Failure/timeout is nonzero; parent descriptor closure releases flock on exit.
function setupProcessHandlers(client, cleanupCallbacks = [], options = {}) {
  const proc = options.processImpl || process;
  const log = options.logger || logger;
  const deadlineMs = options.deadlineMs ?? 30000;
  let shuttingDown;
  function shutdown(signal, exitCode = 0) {
    if (shuttingDown) return shuttingDown;
    log.info(`Received ${signal} - shutting down gracefully`);
    shuttingDown = (async () => {
      let timer, destroying;
      const destroy = () => destroying || (destroying = Promise.resolve().then(() => client.destroy()));
      const work = (async () => {
        const results = await Promise.allSettled(cleanupCallbacks.map(cleanup => Promise.resolve().then(cleanup)));
        await destroy();
        return results.some(result => result.status === 'rejected') ? 1 : exitCode;
      })();
      try {
        const code = await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => { void destroy().catch(() => {}); resolve(1); }, deadlineMs); })]);
        proc.exit(code);
        return code;
      } catch { proc.exit(1); return 1; }
      finally { clearTimeout(timer); }
    })();
    return shuttingDown;
  }
  const handlers = {
    unhandledRejection(reason) {
      log.error('Unhandled Promise Rejection', privateMode() ? null : reason instanceof Error ? reason : new Error(String(reason)));
      if (privateMode()) void shutdown('UNHANDLED_REJECTION', 1);
    },
    uncaughtException(error) {
      log.error('Uncaught Exception', privateMode() ? null : error);
      void shutdown('UNCAUGHT_EXCEPTION', 1);
    },
    SIGINT: () => { void shutdown('SIGINT'); },
    SIGTERM: () => { void shutdown('SIGTERM'); },
  };
  for (const [name, handler] of Object.entries(handlers)) proc.on(name, handler);
  return { shutdown, dispose() { for (const [name, handler] of Object.entries(handlers)) proc.off(name, handler); } };
}
module.exports = { errorEvents, setupProcessHandlers };
