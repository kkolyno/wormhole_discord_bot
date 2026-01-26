const { Client, GatewayIntentBits } = require('discord.js');
const { CONFIG, validateConfig } = require('./src/config');
const { logger } = require('./src/utils/logger');
const { setClient: setHelpersClient } = require('./src/utils/helpers');
const { loadCommands } = require('./src/commands');
const { loadEvents } = require('./src/events');

// Validate configuration before starting
validateConfig();

// Create Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// Initialize modules with client reference
logger.setClient(client);
setHelpersClient(client);

// Load commands and events
loadCommands(client);
loadEvents(client);

// Start the bot
console.log('Starting Meeting Helper Bot...');
client.login(CONFIG.token).catch((error) => {
  console.error('Failed to login:', error.message);
  process.exit(1);
});