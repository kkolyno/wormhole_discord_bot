const { Events, MessageFlags } = require('discord.js');
const { CONFIG } = require('../config');
const { logger, safeExecute } = require('../utils/logger');
const {
  getTargetVoiceChannel,
  getAlertsChannel,
  getHumanCount,
  createPromptButtons,
  buildNotesStartedMessageWithAttendees,
} = require('../utils/helpers');
const {
  SessionState,
  setState,
  getPromptMessageId,
  disablePromptButtons,
  deletePromptMessage,
  getAttendees,
  setNotesStarted,
} = require('../state/session');

// Generic button handler to reduce repetition
async function handleButton(interaction, options) {
  const { ephemeral = false, action, successMessage, errorMessage } = options;

  try {
    await interaction.deferReply({ flags: ephemeral ? MessageFlags.Ephemeral : undefined });
    await disablePromptButtons();
    await action();
    await interaction.editReply({ content: successMessage });
  } catch (error) {
    logger.error(`Error handling ${interaction.customId} button`, error);
    try {
      await interaction.followUp({
        content: errorMessage || '❌ An error occurred.',
        flags: MessageFlags.Ephemeral,
      });
    } catch (e) {
      // Interaction may have already been handled
    }
  }
}

const buttonHandlers = {
  async start_notes(interaction) {
    await handleButton(interaction, {
      ephemeral: false,
      action: async () => {
        logger.info(`User ${interaction.user.tag} clicked Start Notes`);
        setNotesStarted(true);
        await deletePromptMessage();
      },
      successMessage: buildNotesStartedMessageWithAttendees(getAttendees()),
      errorMessage: '❌ An error occurred. Please run the NotesBot commands manually.',
    });
  },

  async no_notes(interaction) {
    await handleButton(interaction, {
      ephemeral: true,
      action: async () => {
        setState(SessionState.DECLINED);
        logger.info(`User ${interaction.user.tag} clicked No - session declined`);
        await deletePromptMessage();
      },
      successMessage: '👍 Okay, not starting notes for this session.',
      errorMessage: 'Acknowledged.',
    });
  },

  async wait_for_more(interaction) {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      setState(SessionState.WAITING);

      const alertsChannel = await getAlertsChannel();
      const promptMessageId = getPromptMessageId();

      if (alertsChannel && promptMessageId) {
        const message = await alertsChannel.messages.fetch(promptMessageId);
        const voiceChannel = await getTargetVoiceChannel();
        const humanCount = getHumanCount(voiceChannel);

        let waitContent = `⏳ **Waiting for more people to join...**\n\n`;
        waitContent += `Currently **${humanCount}** person(s) in <#${CONFIG.voiceChannelId}>.\n`;
        waitContent += `The prompt will reappear when someone new joins.`;

        await message.edit({
          content: waitContent,
          components: [createPromptButtons(true, false)],
        });
      }

      await interaction.editReply({
        content: '⏳ Waiting for more people. The prompt will reappear when someone joins.',
      });

      logger.info(`User ${interaction.user.tag} clicked Wait for More`);
    } catch (error) {
      logger.error('Error handling Wait for More button', error);
      try {
        await interaction.followUp({
          content: '❌ An error occurred.',
          flags: MessageFlags.Ephemeral,
        });
      } catch (e) {
        // Interaction may have already been handled
      }
    }
  },
};

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

      // Handle button interactions
      if (interaction.isButton()) {
        const handler = buttonHandlers[interaction.customId];
        if (handler) {
          await handler(interaction);
        }
      }
    }, 'interaction handling');
  },
};
