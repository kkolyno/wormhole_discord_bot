const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { CONFIG } = require('../config');
const { logger } = require('./logger');

let _client = null;

function setClient(client) {
  _client = client;
}

async function fetchChannel(channelId) {
  try {
    const guild = await _client.guilds.fetch(CONFIG.guildId);
    return await guild.channels.fetch(channelId);
  } catch (error) {
    logger.error(`Error fetching channel ${channelId}`, error);
    return null;
  }
}

function getTargetVoiceChannel() {
  return fetchChannel(CONFIG.voiceChannelId);
}

function getAlertsChannel() {
  return fetchChannel(CONFIG.alertsChannelId);
}

function getHumanCount(voiceChannel) {
  if (!voiceChannel || !voiceChannel.members) return 0;
  return voiceChannel.members.filter((member) => !member.user.bot).size;
}

function getVoiceChannelMentions(voiceChannel) {
  if (!voiceChannel || !voiceChannel.members) return '';
  const humans = voiceChannel.members.filter((member) => !member.user.bot);
  return humans.map((member) => `<@${member.user.id}>`).join(' ');
}

function createPromptButtons(disabled = false, showWait = true) {
  const buttons = [
    new ButtonBuilder()
      .setCustomId('start_notes')
      .setLabel('Start Notes')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('no_notes')
      .setLabel('No')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  ];

  if (showWait) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId('wait_for_more')
        .setLabel('Wait for More')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    );
  }

  return new ActionRowBuilder().addComponents(buttons);
}

function buildPromptContent(voiceChannel) {
  const mentions = getVoiceChannelMentions(voiceChannel);

  if (CONFIG.promptText) {
    return mentions ? `${mentions}\n\n${CONFIG.promptText}` : CONFIG.promptText;
  }

  let content = `📋 **Meeting detected** in <#${CONFIG.voiceChannelId}>!\n\n`;
  content += `> Meeting notes use NotesBot recording/transcription.\n\n`;
  content += `Would you like to start meeting notes?`;

  if (CONFIG.pingRoleId) {
    content = `<@&${CONFIG.pingRoleId}>\n\n` + content;
  }

  if (mentions) {
    content = `${mentions}\n\n` + content;
  }

  return content;
}

function buildNotesStartedMessage() {
  if (CONFIG.notesStartHint) {
    return CONFIG.notesStartHint;
  }

  let content = `✅ **Meeting notes flow starting!**\n\n`;
  content += `**To start recording:**\n`;
  content += `> Run \`${CONFIG.notesbotStartCommand}\` to have NotesBot join the voice channel and begin recording.\n\n`;
  content += `**When the meeting ends:**\n`;
  content += `> Run \`${CONFIG.notesbotStopCommand}\` to stop recording and generate meeting notes.\n\n`;
  content += `_NotesBot will transcribe the meeting and provide deliverables._`;

  if (CONFIG.pingRoleId) {
    content = `<@&${CONFIG.pingRoleId}>\n\n` + content;
  }

  return content;
}

function buildNotesStartedMessageWithAttendees(attendeeIds) {
  const attendeeMentions = attendeeIds.map(id => `<@${id}>`).join(' ');
  const baseMessage = buildNotesStartedMessage();
  
  if (attendeeMentions) {
    return `${attendeeMentions}\n\n${baseMessage}`;
  }
  
  return baseMessage;
}

module.exports = {
  setClient,
  fetchChannel,
  getTargetVoiceChannel,
  getAlertsChannel,
  getHumanCount,
  getVoiceChannelMentions,
  createPromptButtons,
  buildPromptContent,
  buildNotesStartedMessage,
  buildNotesStartedMessageWithAttendees,
};
