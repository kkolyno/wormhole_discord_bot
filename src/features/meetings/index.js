const { MessageFlags } = require('discord.js');
const { GatewayIntentBits } = require('../../core/client');
const { logger, safeExecute } = require('../../core/logger');
const { getHumanCount } = require('../../utils/discord');
const { MEETINGS_CONFIG, validateMeetingsConfig } = require('./config');
const {
  SessionState,
  getState,
  setState,
  getPromptMessageId,
  disablePromptButtons,
  deletePromptMessage,
  getAttendees,
  setNotesStarted,
  postMeetingPrompt,
  getTargetVoiceChannel,
  getAlertsChannel,
} = require('./state');
const { createPromptButtons, buildNotesStartedMessageWithAttendees } = require('./helpers');

// Commands
const statusCommand = require('./commands/status');

// Events
const voiceStateUpdateEvent = require('./events/voiceStateUpdate');

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

// Button handlers for this feature
const buttonHandlers = {
  async meetings_start_notes(interaction) {
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

  async meetings_no_notes(interaction) {
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

  async meetings_wait_for_more(interaction) {
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
        waitContent += `Currently **${humanCount}** person(s) in <#${MEETINGS_CONFIG.voiceChannelId}>.\n`;
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

// Startup hook - called when bot is ready
async function onStartup(client) {
  logger.info(`[Meetings] Monitoring voice channel: ${MEETINGS_CONFIG.voiceChannelId}`);
  logger.info(`[Meetings] Posting alerts to: ${MEETINGS_CONFIG.alertsChannelId}`);
  logger.info(`[Meetings] Join grace period: ${MEETINGS_CONFIG.joinGraceSeconds}s`);
  logger.info(`[Meetings] Empty grace period: ${MEETINGS_CONFIG.emptyGraceSeconds}s`);

  // Check if there are already humans in the voice channel (handles restart scenario)
  await safeExecute(async () => {
    const voiceChannel = await getTargetVoiceChannel();
    const humanCount = getHumanCount(voiceChannel);

    if (humanCount > 0 && getState() === SessionState.INACTIVE) {
      logger.info(`[Meetings] Startup: Found ${humanCount} human(s) already in voice channel - posting prompt`);
      setState(SessionState.PROMPTED);
      await postMeetingPrompt();
    } else {
      logger.info(`[Meetings] Startup: No humans in voice channel (count: ${humanCount})`);
    }
  }, 'meetings startup voice channel check');
}

/**
 * Meetings Feature Module
 * 
 * Exports all components needed by the registry:
 * - commands: Slash commands for this feature
 * - events: Event handlers for this feature
 * - buttonHandlers: Button interaction handlers
 * - intents: Required Discord intents
 * - onStartup: Startup hook
 * - validate: Configuration validation
 */
module.exports = {
  name: 'meetings',
  
  // Required intents for this feature
  intents: [GatewayIntentBits.GuildVoiceStates],
  
  // Commands provided by this feature
  commands: [statusCommand],
  
  // Event handlers provided by this feature
  events: [voiceStateUpdateEvent],
  
  // Button handlers provided by this feature
  buttonHandlers,
  
  // Startup hook
  onStartup,
  
  // Configuration validation
  validate: validateMeetingsConfig,
};
