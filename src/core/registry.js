const { REST, Routes, Collection } = require('discord.js');
const { CONFIG } = require('./config');
const { logger } = require('./logger');

// Storage for all registered components
const commands = new Collection();
const buttonHandlers = new Map();
const eventHandlers = [];
const featureStartupHooks = [];

/**
 * Registers a command
 */
function registerCommand(command) {
  commands.set(command.data.name, command);
}

/**
 * Registers multiple commands
 */
function registerCommands(cmds) {
  for (const cmd of cmds) {
    registerCommand(cmd);
  }
}

/**
 * Registers a button handler
 */
function registerButtonHandler(customId, handler) {
  buttonHandlers.set(customId, handler);
}

/**
 * Registers multiple button handlers
 */
function registerButtonHandlers(handlers) {
  for (const [customId, handler] of Object.entries(handlers)) {
    registerButtonHandler(customId, handler);
  }
}

/**
 * Registers an event handler
 */
function registerEvent(event) {
  eventHandlers.push(event);
}

/**
 * Registers multiple event handlers
 */
function registerEvents(events) {
  for (const event of events) {
    registerEvent(event);
  }
}

/**
 * Registers a startup hook to be called when bot is ready
 */
function registerStartupHook(hook) {
  featureStartupHooks.push(hook);
}

/**
 * Loads all registered commands onto the client
 */
function loadCommandsOnClient(client) {
  client.commands = commands;
}

/**
 * Attaches all registered event handlers to the client
 */
function loadEventsOnClient(client) {
  for (const event of eventHandlers) {
    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args, client));
    } else {
      client.on(event.name, (...args) => event.execute(...args, client));
    }
  }
}

/**
 * Registers slash commands with Discord API
 */
async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(CONFIG.token);

  try {
    logger.info('Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(CONFIG.clientId, CONFIG.guildId), {
      body: Array.from(commands.values()).map((cmd) => cmd.data.toJSON()),
    });
    logger.info('Slash commands registered successfully');
  } catch (error) {
    logger.error('Error registering slash commands', error);
  }
}

/**
 * Runs all registered startup hooks
 */
async function runStartupHooks(client) {
  for (const hook of featureStartupHooks) {
    try {
      await hook(client);
    } catch (error) {
      logger.error('Error running startup hook', error);
    }
  }
}

/**
 * Gets a button handler by custom ID
 */
function getButtonHandler(customId) {
  return buttonHandlers.get(customId);
}

/**
 * Gets all registered commands
 */
function getCommands() {
  return commands;
}

module.exports = {
  registerCommand,
  registerCommands,
  registerButtonHandler,
  registerButtonHandlers,
  registerEvent,
  registerEvents,
  registerStartupHook,
  loadCommandsOnClient,
  loadEventsOnClient,
  registerSlashCommands,
  runStartupHooks,
  getButtonHandler,
  getCommands,
};
