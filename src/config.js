// Load .env file only if environment variables aren't already set
if (!process.env.DISCORD_TOKEN) {
  require('dotenv').config();
}

const CONFIG = {
  // Required
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID,
  voiceChannelId: process.env.VOICE_CHANNEL_ID,
  alertsChannelId: process.env.ALERTS_CHANNEL_ID,

  // Optional
  pingRoleId: process.env.PING_ROLE_ID || null,
  logChannelId: process.env.LOG_CHANNEL_ID || null,
  emptyGraceSeconds: parseInt(process.env.EMPTY_GRACE_SECONDS, 10) || 90,
  joinGraceSeconds: parseInt(process.env.JOIN_GRACE_SECONDS, 10) || 15,
  notesbotStartCommand: process.env.NOTESBOT_START_COMMAND || '/join',
  notesbotStopCommand: process.env.NOTESBOT_STOP_COMMAND || '/leave',
  notesStartHint: process.env.NOTES_START_HINT || null,
  promptText: process.env.PROMPT_TEXT || null,
};

function validateConfig() {
  const required = ['token', 'clientId', 'guildId', 'voiceChannelId', 'alertsChannelId'];
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
    console.error('  VOICE_CHANNEL_ID     - Voice channel to monitor');
    console.error('  ALERTS_CHANNEL_ID    - Text channel for meeting prompts');
    process.exit(1);
  }
}

module.exports = { CONFIG, validateConfig };
