const { logger } = require('../../core/logger');
const { fetchChannel, getHumanCount } = require('../../utils/discord');
const { MEETINGS_CONFIG } = require('./config');
const {
  createPromptButtons,
  buildPromptContent,
} = require('./helpers');

const SessionState = {
  INACTIVE: 'inactive',
  PROMPTED: 'prompted',
  WAITING: 'waiting',
  DECLINED: 'declined',
};

// Session state
let state = SessionState.INACTIVE;
let currentPromptMessageId = null;
let notesStarted = false;
const attendees = new Set();
const botStartTime = Date.now();

// Meeting duration tracking
const participantJoinTimes = new Map(); // userId -> joinTimestamp
const participantDurations = new Map(); // userId -> total duration in ms

// Timer management
const timers = {
  grace: null,
  join: null,
};

function clearTimer(name) {
  if (timers[name]) {
    clearTimeout(timers[name]);
    timers[name] = null;
  }
}

function clearAllTimers() {
  clearTimer('grace');
  clearTimer('join');
}

function getState() {
  return state;
}

function setState(newState) {
  state = newState;
}

function getPromptMessageId() {
  return currentPromptMessageId;
}

function setPromptMessageId(id) {
  currentPromptMessageId = id;
}

function getBotStartTime() {
  return botStartTime;
}

function addAttendee(userId) {
  attendees.add(userId);
}

function getAttendees() {
  return Array.from(attendees);
}

function clearAttendees() {
  attendees.clear();
}

function trackUserJoin(userId) {
  if (!participantJoinTimes.has(userId)) {
    participantJoinTimes.set(userId, Date.now());
    logger.debug(`Started tracking join time for user ${userId}`);
  }
}

function trackUserLeave(userId) {
  if (participantJoinTimes.has(userId)) {
    const joinTime = participantJoinTimes.get(userId);
    const duration = Date.now() - joinTime;
    
    // Add to cumulative duration
    const currentDuration = participantDurations.get(userId) || 0;
    participantDurations.set(userId, currentDuration + duration);
    
    participantJoinTimes.delete(userId);
    logger.debug(`User ${userId} was in meeting for ${Math.round(duration / 1000)}s (total: ${Math.round((currentDuration + duration) / 1000)}s)`);
  }
}

function getParticipantDurations() {
  // Include anyone still in the channel
  const finalDurations = new Map(participantDurations);
  
  for (const [userId, joinTime] of participantJoinTimes.entries()) {
    const duration = Date.now() - joinTime;
    const currentDuration = participantDurations.get(userId) || 0;
    finalDurations.set(userId, currentDuration + duration);
  }
  
  return finalDurations;
}

function clearMeetingTracking() {
  participantJoinTimes.clear();
  participantDurations.clear();
  logger.debug('Cleared meeting tracking data');
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  } else {
    return `${seconds}s`;
  }
}

function setNotesStarted(started) {
  notesStarted = started;
}

function getNotesStarted() {
  return notesStarted;
}

function isTimerActive(name) {
  return timers[name] !== null;
}

// Helper functions for channels
async function getTargetVoiceChannel() {
  return fetchChannel(MEETINGS_CONFIG.voiceChannelId);
}

async function getAlertsChannel() {
  return fetchChannel(MEETINGS_CONFIG.alertsChannelId);
}

async function postMeetingPrompt() {
  const alertsChannel = await getAlertsChannel();
  if (!alertsChannel) {
    logger.error('Cannot post prompt: alerts channel not found');
    return;
  }

  const voiceChannel = await getTargetVoiceChannel();

  // Track all current attendees when posting the prompt
  if (voiceChannel && voiceChannel.members) {
    voiceChannel.members.forEach((member) => {
      if (!member.user.bot) {
        attendees.add(member.user.id);
        trackUserJoin(member.user.id); // Track their join time
        logger.debug(`Initial attendee: ${member.user.tag}`);
      }
    });
  }

  try {
    const message = await alertsChannel.send({
      content: buildPromptContent(voiceChannel),
      components: [createPromptButtons(false, true)],
    });
    currentPromptMessageId = message.id;
    logger.info(`Posted meeting prompt (message ID: ${message.id})`);
  } catch (error) {
    logger.error('Error posting meeting prompt', error);
  }
}

async function disablePromptButtons() {
  if (!currentPromptMessageId) return;

  const alertsChannel = await getAlertsChannel();
  if (!alertsChannel) return;

  try {
    const message = await alertsChannel.messages.fetch(currentPromptMessageId);
    await message.edit({
      components: [createPromptButtons(true)],
    });
  } catch (error) {
    logger.warn('Error disabling prompt buttons (message may have been deleted)', error);
  }
}

async function deletePromptMessage() {
  if (!currentPromptMessageId) return;

  const alertsChannel = await getAlertsChannel();
  if (!alertsChannel) return;

  try {
    const message = await alertsChannel.messages.fetch(currentPromptMessageId);
    await message.delete();
    logger.debug('Deleted prompt message');
  } catch (error) {
    logger.warn('Error deleting prompt message (message may already be deleted)', error);
  }
  
  currentPromptMessageId = null;
}

function startGraceTimer() {
  clearTimer('grace');

  timers.grace = setTimeout(async () => {
    timers.grace = null;

    const voiceChannel = await getTargetVoiceChannel();
    const humanCount = getHumanCount(voiceChannel);

    if (humanCount === 0) {
      // Post meeting summary before the reminder
      if (attendees.size > 0) {
        const alertsChannel = await getAlertsChannel();
        if (alertsChannel) {
          const durations = getParticipantDurations();
          
          if (durations.size > 0) {
            let summaryMsg = '📊 **Meeting Summary**\n\n';
            summaryMsg += '**Participants and Duration:**\n';
            
            // Sort by duration (longest first)
            const sortedDurations = Array.from(durations.entries())
              .sort((a, b) => b[1] - a[1]);
            
            for (const [userId, duration] of sortedDurations) {
              summaryMsg += `• <@${userId}>: ${formatDuration(duration)}\n`;
            }
            
            try {
              await alertsChannel.send(summaryMsg);
              logger.info('Posted meeting summary');
            } catch (error) {
              logger.error('Error posting meeting summary', error);
            }
          }
        }
      }
      
      // Check if notes were started and post reminder
      if (notesStarted && attendees.size > 0) {
        const alertsChannel = await getAlertsChannel();
        if (alertsChannel) {
          const attendeeMentions = Array.from(attendees).map(id => `<@${id}>`).join(' ');
          let reminderMsg = `${attendeeMentions}\n\n`;
          reminderMsg += `⏹️ **Meeting ended** - All attendees have left the voice channel.\n\n`;
          reminderMsg += `**Stop the recording now:**\n`;
          reminderMsg += `> Run \`${MEETINGS_CONFIG.notesbotStopCommand}\` to stop recording and generate meeting notes.`;
          
          try {
            await alertsChannel.send(reminderMsg);
            logger.info('Posted recording end reminder');
          } catch (error) {
            logger.error('Error posting recording end reminder', error);
          }
        }
      }

      logger.info('Grace period expired with no humans - resetting to Inactive');
      state = SessionState.INACTIVE;
      currentPromptMessageId = null;
      notesStarted = false;
      attendees.clear();
      clearMeetingTracking();
    } else if (state === SessionState.DECLINED) {
      logger.info('Grace period expired but humans still present after decline - staying Declined');
    } else {
      logger.info('Grace period expired but humans are present - staying in current state');
    }
  }, MEETINGS_CONFIG.emptyGraceSeconds * 1000);

  logger.debug(`Started grace timer (${MEETINGS_CONFIG.emptyGraceSeconds}s)`);
}

function startJoinGraceTimer() {
  clearTimer('join');

  timers.join = setTimeout(async () => {
    timers.join = null;

    const voiceChannel = await getTargetVoiceChannel();
    const humanCount = getHumanCount(voiceChannel);

    if (humanCount > 0 && state === SessionState.INACTIVE) {
      logger.info('Join grace period expired with humans present - posting prompt');
      state = SessionState.PROMPTED;
      await postMeetingPrompt();
    } else {
      logger.debug('Join grace period expired but no humans - staying Inactive');
    }
  }, MEETINGS_CONFIG.joinGraceSeconds * 1000);

  logger.debug(`Started join grace timer (${MEETINGS_CONFIG.joinGraceSeconds}s)`);
}

module.exports = {
  SessionState,
  getState,
  setState,
  getPromptMessageId,
  setPromptMessageId,
  getBotStartTime,
  isTimerActive,
  clearTimer,
  clearAllTimers,
  postMeetingPrompt,
  disablePromptButtons,
  deletePromptMessage,
  startGraceTimer,
  startJoinGraceTimer,
  addAttendee,
  getAttendees,
  clearAttendees,
  setNotesStarted,
  getNotesStarted,
  trackUserJoin,
  trackUserLeave,
  getParticipantDurations,
  clearMeetingTracking,
  formatDuration,
  getTargetVoiceChannel,
  getAlertsChannel,
};
