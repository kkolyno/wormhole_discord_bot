const { Events } = require('discord.js');
const { CONFIG } = require('../config');
const { logger, safeExecute } = require('../utils/logger');
const { getTargetVoiceChannel, getHumanCount } = require('../utils/helpers');
const { SessionState, getState, setState, postMeetingPrompt } = require('../state/session');
const { registerCommands } = require('../commands');

module.exports = {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    logger.info(`Logged in as ${client.user.tag}`);

    await logger.init();

    logger.info(`Monitoring voice channel: ${CONFIG.voiceChannelId}`);
    logger.info(`Posting alerts to: ${CONFIG.alertsChannelId}`);
    logger.info(`Join grace period: ${CONFIG.joinGraceSeconds}s`);
    logger.info(`Empty grace period: ${CONFIG.emptyGraceSeconds}s`);

    await registerCommands();

    // Check if there are already humans in the voice channel (handles restart scenario)
    await safeExecute(async () => {
      const voiceChannel = await getTargetVoiceChannel();
      const humanCount = getHumanCount(voiceChannel);

      if (humanCount > 0 && getState() === SessionState.INACTIVE) {
        logger.info(`Startup: Found ${humanCount} human(s) already in voice channel - posting prompt`);
        setState(SessionState.PROMPTED);
        await postMeetingPrompt();
      } else {
        logger.info(`Startup: No humans in voice channel (count: ${humanCount})`);
      }
    }, 'startup voice channel check');
  },
};
