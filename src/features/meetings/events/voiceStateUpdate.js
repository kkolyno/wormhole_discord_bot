const { Events } = require('discord.js');
const { MEETINGS_CONFIG } = require('../config');
const { logger, safeExecute } = require('../../../core/logger');
const { getHumanCount } = require('../../../utils/discord');
const {
  SessionState,
  getState,
  setState,
  isTimerActive,
  clearTimer,
  startGraceTimer,
  startJoinGraceTimer,
  postMeetingPrompt,
  setPromptMessageId,
  addAttendee,
  clearAttendees,
  setNotesStarted,
  trackUserJoin,
  trackUserLeave,
  clearMeetingTracking,
  getTargetVoiceChannel,
} = require('../state');

module.exports = {
  name: Events.VoiceStateUpdate,
  once: false,

  async execute(oldState, newState) {
    await safeExecute(async () => {
      const targetChannelId = MEETINGS_CONFIG.voiceChannelId;
      const wasInTarget = oldState.channelId === targetChannelId;
      const isInTarget = newState.channelId === targetChannelId;

      if (!wasInTarget && !isInTarget) return;
      
      // Check if the user is a bot (use oldState for leaves, newState for joins)
      const member = newState.member || oldState.member;
      if (member?.user?.bot) return;

      const voiceChannel = await getTargetVoiceChannel();
      const humanCount = getHumanCount(voiceChannel);
      const isJoin = !wasInTarget && isInTarget;
      const state = getState();

      logger.debug(`Voice update: ${humanCount} human(s) in channel, state: ${state}, isJoin: ${isJoin}`);

      // Track join/leave for duration tracking
      if (isJoin) {
        trackUserJoin(member.user.id);
      } else if (wasInTarget && !isInTarget) {
        trackUserLeave(member.user.id);
      }

      // Track attendees when they join (if we're past the inactive state)
      if (isJoin && state !== SessionState.INACTIVE) {
        addAttendee(member.user.id);
        logger.debug(`Added attendee: ${member.user.tag}`);
      }

      if (humanCount >= 2) {
        clearTimer('grace');

        if (state === SessionState.INACTIVE) {
          clearTimer('join');
          logger.info('2+ humans in channel - posting prompt immediately');
          setState(SessionState.PROMPTED);
          await postMeetingPrompt();
        } else if (state === SessionState.WAITING && isJoin) {
          logger.info('New human joined while waiting - re-posting prompt');
          setState(SessionState.PROMPTED);
          await postMeetingPrompt();
        }
      } else {
        // humanCount is 0 or 1 - not enough for a meeting
        clearTimer('join');

        if (state === SessionState.DECLINED) {
          logger.info('Not enough humans after decline - resetting to Inactive');
          setState(SessionState.INACTIVE);
          setPromptMessageId(null);
          setNotesStarted(false);
          clearAttendees();
          clearMeetingTracking();
        } else if ((state === SessionState.PROMPTED || state === SessionState.WAITING) && !isTimerActive('grace')) {
          logger.info('Only 1 or 0 humans remain - starting grace timer');
          startGraceTimer();
        } else if (state === SessionState.INACTIVE) {
          logger.debug('Not enough humans while inactive - no action needed');
        }
      }
    }, 'voice state update');
  },
};
