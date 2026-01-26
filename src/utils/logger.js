const { CONFIG } = require('../config');

const LogLevel = {
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
};

const logger = {
  logChannel: null,
  _client: null,

  setClient(client) {
    this._client = client;
  },

  async init() {
    if (!CONFIG.logChannelId || !this._client) return;
    try {
      const guild = await this._client.guilds.fetch(CONFIG.guildId);
      this.logChannel = await guild.channels.fetch(CONFIG.logChannelId);
      this.info('Log channel initialized');
    } catch (error) {
      console.error('Failed to initialize log channel:', error.message);
    }
  },

  async _log(level, message, error = null) {
    const timestamp = new Date().toISOString();
    const consoleMsg = `[${timestamp}] [${level}] ${message}${error ? `: ${error.message}` : ''}`;

    if (level === LogLevel.ERROR) {
      console.error(consoleMsg);
    } else if (level === LogLevel.WARN) {
      console.warn(consoleMsg);
    } else {
      console.log(consoleMsg);
    }

    if (this.logChannel) {
      try {
        const emoji = {
          [LogLevel.DEBUG]: '🔍',
          [LogLevel.INFO]: 'ℹ️',
          [LogLevel.WARN]: '⚠️',
          [LogLevel.ERROR]: '❌',
        }[level];

        let discordMsg = `${emoji} **[${level}]** ${message}`;
        if (error) {
          discordMsg += `\n\`\`\`${error.stack || error.message}\`\`\``;
        }

        if (discordMsg.length > 2000) {
          discordMsg = discordMsg.substring(0, 1997) + '...';
        }

        await this.logChannel.send(discordMsg);
      } catch (err) {
        console.error('Failed to send log to Discord:', err.message);
      }
    }
  },

  debug(message) { this._log(LogLevel.DEBUG, message); },
  info(message) { this._log(LogLevel.INFO, message); },
  warn(message, error = null) { this._log(LogLevel.WARN, message, error); },
  error(message, error = null) { this._log(LogLevel.ERROR, message, error); },
};

async function safeExecute(operation, context, fallback = null) {
  try {
    return await operation();
  } catch (error) {
    logger.error(`Error in ${context}`, error);
    return fallback;
  }
}

module.exports = { logger, safeExecute };
