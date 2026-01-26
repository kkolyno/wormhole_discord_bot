const { Events } = require('discord.js');
const { logger } = require('../utils/logger');
const { clearAllTimers } = require('../state/session');

const errorEvents = [
  {
    name: Events.Error,
    execute(error) {
      logger.error('Discord client error', error);
    },
  },
  {
    name: Events.ShardError,
    execute(error, shardId) {
      logger.error(`Shard ${shardId} error`, error);
    },
  },
  {
    name: Events.ShardDisconnect,
    execute(event, shardId) {
      logger.warn(`Shard ${shardId} disconnected (code: ${event.code})`);
    },
  },
  {
    name: Events.ShardReconnecting,
    execute(shardId) {
      logger.info(`Shard ${shardId} reconnecting...`);
    },
  },
];

function setupProcessHandlers(client) {
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Promise Rejection', reason instanceof Error ? reason : new Error(String(reason)));
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', error);
    setTimeout(() => process.exit(1), 1000);
  });

  const gracefulShutdown = (signal) => {
    logger.info(`Received ${signal} - shutting down gracefully`);
    clearAllTimers();
    client.destroy();
    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

module.exports = { errorEvents, setupProcessHandlers };
