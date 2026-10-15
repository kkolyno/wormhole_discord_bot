const { createClient, GatewayIntentBits } = require('./src/core/client');
const { CONFIG, validateConfig } = require('./src/core/config');
const { logger } = require('./src/core/logger');
const { setClient: setDiscordUtilsClient } = require('./src/utils/discord');
const {
  registerCommands,
  registerEvents,
  registerButtonHandlers,
  registerStartupHook,
  loadCommandsOnClient,
  loadEventsOnClient,
} = require('./src/core/registry');

// Global commands and events
const { globalCommands } = require('./src/commands');
const { globalEvents, setupProcessHandlers } = require('./src/events');

// Features
const localTranscriptionEnabled = process.env.LOCAL_TRANSCRIPTION_ENABLED === 'true';

// Exactly one session/summary owner. Legacy sources and default behavior stay unchanged.
const features = [localTranscriptionEnabled
  ? require('./src/features/local-transcription')
  : require('./src/features/meetings')];

// Validate core configuration
validateConfig();

// Validate and collect intents from all features
const featureIntents = [];
const cleanupCallbacks = [];

for (const feature of features) {
  if (feature.validate) {
    feature.validate();
  }
  if (feature.intents) {
    featureIntents.push(...feature.intents);
  }
  if (feature.cleanup) {
    cleanupCallbacks.push(feature.cleanup);
  }
}

// Create Discord client with all required intents
const client = createClient(featureIntents);
for (const feature of features) feature.configureClient?.(client);

// Initialize shared utilities with client reference
logger.setClient(client);
setDiscordUtilsClient(client);

// Register global commands and events
registerCommands(globalCommands);
registerEvents(globalEvents);

// Register feature components
for (const feature of features) {
  if (feature.commands) {
    registerCommands(feature.commands);
  }
  if (feature.events) {
    registerEvents(feature.events);
  }
  if (feature.buttonHandlers) {
    registerButtonHandlers(feature.buttonHandlers);
  }
  if (feature.onStartup) {
    registerStartupHook(feature.onStartup);
  }
}

// Load everything onto the client
loadCommandsOnClient(client);
loadEventsOnClient(client);
setupProcessHandlers(client, cleanupCallbacks);

// Start the bot
console.log('Starting Wormhole Bot...');
client.login(CONFIG.token).catch((error) => {
  console.error('Failed to login:', localTranscriptionEnabled ? 'DISCORD_LOGIN_FAILED' : error.message);
  process.exit(1);
});