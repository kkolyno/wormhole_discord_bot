/**
 * Meetings Feature Configuration
 * 
 * This configuration is specific to the meetings feature.
 * It's loaded from environment variables with sensible defaults.
 */

// Load .env if not already loaded
if (!process.env.DISCORD_TOKEN) {
  require('dotenv').config();
}

const MEETINGS_CONFIG = {
  // Required for this feature
  voiceChannelId: process.env.VOICE_CHANNEL_ID,
  alertsChannelId: process.env.ALERTS_CHANNEL_ID,

  // Optional
  pingRoleId: process.env.PING_ROLE_ID || null,
  emptyGraceSeconds: parseInt(process.env.EMPTY_GRACE_SECONDS, 10) || 90,
  joinGraceSeconds: parseInt(process.env.JOIN_GRACE_SECONDS, 10) || 15,
  notesbotStartCommand: process.env.NOTESBOT_START_COMMAND || '/join',
  notesbotStopCommand: process.env.NOTESBOT_STOP_COMMAND || '/leave',
  notesStartHint: process.env.NOTES_START_HINT || null,
  promptText: process.env.PROMPT_TEXT || null,
};

/**
 * Validates meetings feature configuration
 */
function validateMeetingsConfig() {
  const required = ['voiceChannelId', 'alertsChannelId'];
  const missing = required.filter((key) => !MEETINGS_CONFIG[key]);

  if (missing.length > 0) {
    console.error('ERROR: Missing required environment variables for meetings feature:');
    missing.forEach((key) => {
      const envName = key
        .replace(/([A-Z])/g, '_$1')
        .toUpperCase()
        .replace(/^_/, '');
      console.error(`  - ${envName}`);
    });
    console.error('\nRequired for meetings feature:');
    console.error('  VOICE_CHANNEL_ID     - Voice channel to monitor');
    console.error('  ALERTS_CHANNEL_ID    - Text channel for meeting prompts');
    process.exit(1);
  }
}

module.exports = { MEETINGS_CONFIG, validateMeetingsConfig };
