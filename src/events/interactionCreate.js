const { Events } = require('discord.js');
const { safeExecute } = require('../core/logger');
const { getButtonHandler } = require('../core/registry');

module.exports = {
  name: Events.InteractionCreate,
  once: false,

  async execute(interaction, client) {
    await safeExecute(async () => {
      // Handle slash commands
      if (interaction.isChatInputCommand()) {
        const command = client.commands?.get(interaction.commandName);
        if (command) {
          await command.execute(interaction, client);
        }
        return;
      }

      // Handle button interactions - delegate to registered handlers
      if (interaction.isButton()) {
        const handler = getButtonHandler(interaction.customId);
        if (handler) {
          await handler(interaction);
        }
      }
    }, 'interaction handling');
  },
};
