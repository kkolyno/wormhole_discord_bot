const { REST, Routes, Collection } = require('discord.js');
const { CONFIG } = require('../config');
const { logger } = require('../utils/logger');

const ping = require('./ping');
const status = require('./status');

const commands = [ping, status];

function loadCommands(client) {
  client.commands = new Collection();
  for (const command of commands) {
    client.commands.set(command.data.name, command);
  }
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(CONFIG.token);

  try {
    logger.info('Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(CONFIG.clientId, CONFIG.guildId), {
      body: commands.map((cmd) => cmd.data.toJSON()),
    });
    logger.info('Slash commands registered successfully');
  } catch (error) {
    logger.error('Error registering slash commands', error);
  }
}

module.exports = { loadCommands, registerCommands };
