const { SlashCommandBuilder } = require('discord.js');
const { getState, getBotStartTime, isTimerActive, getTargetVoiceChannel } = require('../state');
const { getHumanCount } = require('../../../utils/discord');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('meeting-status')
    .setDescription('Get the current meeting tracking status'),

  async execute(interaction) {
    const uptime = Math.floor((Date.now() - getBotStartTime()) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;

    const voiceChannel = await getTargetVoiceChannel();
    const humanCount = getHumanCount(voiceChannel);

    let statusMsg = `📊 **Meeting Status**\n`;
    statusMsg += `> **State:** ${getState()}\n`;
    statusMsg += `> **Uptime:** ${hours}h ${minutes}m ${seconds}s\n`;
    statusMsg += `> **Humans in VC:** ${humanCount}\n`;
    statusMsg += `> **Join Grace Timer:** ${isTimerActive('join') ? 'Active' : 'Inactive'}\n`;
    statusMsg += `> **Empty Grace Timer:** ${isTimerActive('grace') ? 'Active' : 'Inactive'}`;

    await interaction.reply(statusMsg);
  },
};
