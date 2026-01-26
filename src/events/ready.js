const { Events } = require('discord.js');
const { logger } = require('../core/logger');
const { registerSlashCommands, runStartupHooks } = require('../core/registry');

module.exports = {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    logger.info(`Logged in as ${client.user.tag}`);

    await logger.init();
    await registerSlashCommands();
    await runStartupHooks(client);
  },
};
