// Load .env file only if environment variables aren't already set
if (!process.env.DISCORD_TOKEN) {
  require('dotenv').config();
}

/**
 * Core bot configuration - shared across all features
 */
const CONFIG = {
  // Required - Core bot settings
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID,

  // Optional - Logging
  logChannelId: process.env.LOG_CHANNEL_ID || null,
};

/**
 * Validates that required core configuration is present
 */
function validateConfig() {
  const required = ['token', 'clientId', 'guildId'];
  const missing = required.filter((key) => !CONFIG[key]);

  if (missing.length > 0) {
    console.error('ERROR: Missing required environment variables:');
    missing.forEach((key) => {
      const envName = key
        .replace(/([A-Z])/g, '_$1')
        .toUpperCase()
        .replace(/^_/, '');
      console.error(`  - ${envName}`);
    });
    console.error('\nRequired environment variables:');
    console.error('  DISCORD_TOKEN        - Bot token from Discord Developer Portal');
    console.error('  CLIENT_ID            - Bot application/client ID');
    console.error('  GUILD_ID             - Discord server ID');
    process.exit(1);
  }
}

module.exports = { CONFIG, validateConfig };
