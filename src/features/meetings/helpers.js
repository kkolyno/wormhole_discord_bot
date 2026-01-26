const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { MEETINGS_CONFIG } = require('./config');
const { getVoiceChannelMentions } = require('../../utils/discord');

function createPromptButtons(disabled = false, showWait = true) {
  const buttons = [
    new ButtonBuilder()
      .setCustomId('meetings_start_notes')
      .setLabel('Start Notes')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('meetings_no_notes')
      .setLabel('No')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  ];

  if (showWait) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId('meetings_wait_for_more')
        .setLabel('Wait for More')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    );
  }

  return new ActionRowBuilder().addComponents(buttons);
}

function buildPromptContent(voiceChannel) {
  const mentions = getVoiceChannelMentions(voiceChannel);

  if (MEETINGS_CONFIG.promptText) {
    return mentions ? `${mentions}\n\n${MEETINGS_CONFIG.promptText}` : MEETINGS_CONFIG.promptText;
  }

  let content = `📋 **Meeting detected** in <#${MEETINGS_CONFIG.voiceChannelId}>!\n\n`;
  content += `> Meeting notes use NotesBot recording/transcription.\n\n`;
  content += `Would you like to start meeting notes?`;

  if (MEETINGS_CONFIG.pingRoleId) {
    content = `<@&${MEETINGS_CONFIG.pingRoleId}>\n\n` + content;
  }

  if (mentions) {
    content = `${mentions}\n\n` + content;
  }

  return content;
}

function buildNotesStartedMessage() {
  if (MEETINGS_CONFIG.notesStartHint) {
    return MEETINGS_CONFIG.notesStartHint;
  }

  let content = `✅ **Meeting notes flow starting!**\n\n`;
  content += `**To start recording:**\n`;
  content += `> Run \`${MEETINGS_CONFIG.notesbotStartCommand}\` to have NotesBot join the voice channel and begin recording.\n\n`;
  content += `**When the meeting ends:**\n`;
  content += `> Run \`${MEETINGS_CONFIG.notesbotStopCommand}\` to stop recording and generate meeting notes.\n\n`;
  content += `_NotesBot will transcribe the meeting and provide deliverables._`;

  if (MEETINGS_CONFIG.pingRoleId) {
    content = `<@&${MEETINGS_CONFIG.pingRoleId}>\n\n` + content;
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
  createPromptButtons,
  buildPromptContent,
  buildNotesStartedMessage,
  buildNotesStartedMessageWithAttendees,
};
