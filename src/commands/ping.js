const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check if the bot is alive'),

  async execute(interaction, client) {
    const latency = Date.now() - interaction.createdTimestamp;
    await interaction.reply(`🏓 Pong! Latency: ${latency}ms | WebSocket: ${client.ws.ping}ms`);
  },
};
