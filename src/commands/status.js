const { SlashCommandBuilder } = require('discord.js');
const { getState, getBotStartTime, isTimerActive } = require('../state/session');
const { getTargetVoiceChannel, getHumanCount } = require('../utils/helpers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Get the current bot status'),

  async execute(interaction) {
    const uptime = Math.floor((Date.now() - getBotStartTime()) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;

    const voiceChannel = await getTargetVoiceChannel();
    const humanCount = getHumanCount(voiceChannel);

    let statusMsg = `📊 **Bot Status**\n`;
    statusMsg += `> **State:** ${getState()}\n`;
    statusMsg += `> **Uptime:** ${hours}h ${minutes}m ${seconds}s\n`;
    statusMsg += `> **Humans in VC:** ${humanCount}\n`;
    statusMsg += `> **Join Grace Timer:** ${isTimerActive('join') ? 'Active' : 'Inactive'}\n`;
    statusMsg += `> **Empty Grace Timer:** ${isTimerActive('grace') ? 'Active' : 'Inactive'}`;

    await interaction.reply(statusMsg);
  },
};
