const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
  MessageFlags,
} = require('discord.js');

// ============================================================================
// Configuration from environment variables
// ============================================================================

const CONFIG = {
  // Required
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID,
  voiceChannelId: process.env.VOICE_CHANNEL_ID,
  notesTextChannelId: process.env.NOTES_TEXT_CHANNEL_ID,

  // Optional
  pingRoleId: process.env.PING_ROLE_ID || null,
  logChannelId: process.env.LOG_CHANNEL_ID || null,
  emptyGraceSeconds: parseInt(process.env.EMPTY_GRACE_SECONDS, 10) || 90,
  joinGraceSeconds: parseInt(process.env.JOIN_GRACE_SECONDS, 10) || 15,
  notesbotStartCommand: process.env.NOTESBOT_START_COMMAND || '/join',
  notesbotStopCommand: process.env.NOTESBOT_STOP_COMMAND || '/leave',
  notesStartHint: process.env.NOTES_START_HINT || null,
  promptText: process.env.PROMPT_TEXT || null,
};

// Validate required configuration
function validateConfig() {
  const required = ['token', 'clientId', 'guildId', 'voiceChannelId', 'notesTextChannelId'];
  const missing = required.filter((key) => !CONFIG[key]);

  if (missing.length > 0) {
    console.error('ERROR: Missing required environment variables:');
    missing.forEach((key) => {
      const envName = key
        .replace(/([A-Z])/g, '_$1')
        .toUpperCase()
        .replace(/^_/, '');
      console.error(`  - ${envName}`);
    });
    console.error('\nRequired environment variables:');
    console.error('  DISCORD_TOKEN        - Bot token from Discord Developer Portal');
    console.error('  CLIENT_ID            - Bot application/client ID');
    console.error('  GUILD_ID             - Discord server ID');
    console.error('  VOICE_CHANNEL_ID     - Voice channel to monitor');
    console.error('  NOTES_TEXT_CHANNEL_ID - Text channel for prompts');
    process.exit(1);
  }
}

// ============================================================================
// Logger Utility
// ============================================================================

const LogLevel = {
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
};

/**
 * Logger that outputs to console and optionally to a Discord channel
 */
const logger = {
  logChannel: null,

  async init() {
    if (!CONFIG.logChannelId) return;
    try {
      const guild = await client.guilds.fetch(CONFIG.guildId);
      this.logChannel = await guild.channels.fetch(CONFIG.logChannelId);
      this.info('Log channel initialized');
    } catch (error) {
      console.error('Failed to initialize log channel:', error.message);
    }
  },

  async _log(level, message, error = null) {
    const timestamp = new Date().toISOString();
    const consoleMsg = `[${timestamp}] [${level}] ${message}${error ? `: ${error.message}` : ''}`;
    
    // Always log to console
    if (level === LogLevel.ERROR) {
      console.error(consoleMsg);
    } else if (level === LogLevel.WARN) {
      console.warn(consoleMsg);
    } else {
      console.log(consoleMsg);
    }

    // Log to Discord channel if available
    if (this.logChannel) {
      try {
        const emoji = {
          [LogLevel.DEBUG]: '🔍',
          [LogLevel.INFO]: 'ℹ️',
          [LogLevel.WARN]: '⚠️',
          [LogLevel.ERROR]: '❌',
        }[level];
        
        let discordMsg = `${emoji} **[${level}]** ${message}`;
        if (error) {
          discordMsg += `\n\`\`\`${error.stack || error.message}\`\`\``;
        }
        
        // Truncate if too long
        if (discordMsg.length > 2000) {
          discordMsg = discordMsg.substring(0, 1997) + '...';
        }
        
        await this.logChannel.send(discordMsg);
      } catch (err) {
        console.error('Failed to send log to Discord:', err.message);
      }
    }
  },

  debug(message) { this._log(LogLevel.DEBUG, message); },
  info(message) { this._log(LogLevel.INFO, message); },
  warn(message, error = null) { this._log(LogLevel.WARN, message, error); },
  error(message, error = null) { this._log(LogLevel.ERROR, message, error); },
};

/**
 * Safely execute an async operation with error handling
 */
async function safeExecute(operation, context, fallback = null) {
  try {
    return await operation();
  } catch (error) {
    logger.error(`Error in ${context}`, error);
    return fallback;
  }
}

// ============================================================================
// Session State Machine
// ============================================================================

const SessionState = {
  INACTIVE: 'inactive',
  PROMPTED: 'prompted',
  WAITING: 'waiting',
};

let sessionState = SessionState.INACTIVE;
let graceTimer = null;
let joinGraceTimer = null;
let currentPromptMessageId = null;
let botStartTime = Date.now();

// ============================================================================
// Slash Commands
// ============================================================================

const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check if the bot is alive'),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Get the current bot status'),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(CONFIG.token);

  try {
    logger.info('Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(CONFIG.clientId, CONFIG.guildId), {
      body: commands.map((cmd) => cmd.toJSON()),
    });
    logger.info('Slash commands registered successfully');
  } catch (error) {
    logger.error('Error registering slash commands', error);
  }
}

// ============================================================================
// Discord Client Setup
// ============================================================================

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Count human (non-bot) members in the target voice channel
 */
function getHumanCount(voiceChannel) {
  if (!voiceChannel || !voiceChannel.members) return 0;
  return voiceChannel.members.filter((member) => !member.user.bot).size;
}

/**
 * Get mentions for all human members in the voice channel
 */
function getVoiceChannelMentions(voiceChannel) {
  if (!voiceChannel || !voiceChannel.members) return '';
  const humans = voiceChannel.members.filter((member) => !member.user.bot);
  return humans.map((member) => `<@${member.user.id}>`).join(' ');
}

/**
 * Get the target voice channel
 */
async function getTargetVoiceChannel() {
  try {
    const guild = await client.guilds.fetch(CONFIG.guildId);
    const channel = await guild.channels.fetch(CONFIG.voiceChannelId);
    return channel;
  } catch (error) {
    logger.error('Error fetching voice channel', error);
    return null;
  }
}

/**
 * Get the notes text channel
 */
async function getNotesTextChannel() {
  try {
    const guild = await client.guilds.fetch(CONFIG.guildId);
    const channel = await guild.channels.fetch(CONFIG.notesTextChannelId);
    return channel;
  } catch (error) {
    logger.error('Error fetching notes text channel', error);
    return null;
  }
}

/**
 * Create the prompt buttons
 */
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

/**
 * Build the prompt message content with voice channel member mentions
 */
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

/**
 * Build the "notes started" follow-up message
 */
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

/**
 * Post the meeting detected prompt
 */
async function postMeetingPrompt() {
  const textChannel = await getNotesTextChannel();
  if (!textChannel) {
    logger.error('Cannot post prompt: notes text channel not found');
    return;
  }

  const voiceChannel = await getTargetVoiceChannel();

  try {
    const message = await textChannel.send({
      content: buildPromptContent(voiceChannel),
      components: [createPromptButtons(false, true)],
    });
    currentPromptMessageId = message.id;
    logger.info(`Posted meeting prompt (message ID: ${message.id})`);
  } catch (error) {
    logger.error('Error posting meeting prompt', error);
  }
}

/**
 * Disable buttons on the current prompt message
 */
async function disablePromptButtons() {
  if (!currentPromptMessageId) return;

  const textChannel = await getNotesTextChannel();
  if (!textChannel) return;

  try {
    const message = await textChannel.messages.fetch(currentPromptMessageId);
    await message.edit({
      components: [createPromptButtons(true)],
    });
  } catch (error) {
    logger.warn('Error disabling prompt buttons (message may have been deleted)', error);
  }
}

/**
 * Clear the grace timer if active
 */
function clearGraceTimer() {
  if (graceTimer) {
    clearTimeout(graceTimer);
    graceTimer = null;
  }
}

/**
 * Clear the join grace timer if active
 */
function clearJoinGraceTimer() {
  if (joinGraceTimer) {
    clearTimeout(joinGraceTimer);
    joinGraceTimer = null;
  }
}

/**
 * Start the empty grace timer
 */
function startGraceTimer() {
  clearGraceTimer();

  graceTimer = setTimeout(async () => {
    graceTimer = null;

    const voiceChannel = await getTargetVoiceChannel();
    const humanCount = getHumanCount(voiceChannel);

    if (humanCount === 0) {
      logger.info('Grace period expired with no humans - resetting to Inactive');
      sessionState = SessionState.INACTIVE;
      currentPromptMessageId = null;
    } else {
      logger.info('Grace period expired but humans are present - staying Prompted');
    }
  }, CONFIG.emptyGraceSeconds * 1000);

  logger.debug(`Started grace timer (${CONFIG.emptyGraceSeconds}s)`);
}

/**
 * Start the join grace timer - waits before posting prompt to avoid accidental joins
 */
function startJoinGraceTimer() {
  clearJoinGraceTimer();

  joinGraceTimer = setTimeout(async () => {
    joinGraceTimer = null;

    const voiceChannel = await getTargetVoiceChannel();
    const humanCount = getHumanCount(voiceChannel);

    if (humanCount > 0 && sessionState === SessionState.INACTIVE) {
      logger.info('Join grace period expired with humans present - posting prompt');
      sessionState = SessionState.PROMPTED;
      await postMeetingPrompt();
    } else {
      logger.debug('Join grace period expired but no humans - staying Inactive');
    }
  }, CONFIG.joinGraceSeconds * 1000);

  logger.debug(`Started join grace timer (${CONFIG.joinGraceSeconds}s)`);
}

// ============================================================================
// Event Handlers
// ============================================================================

/**
 * Handle bot ready event
 */
client.once(Events.ClientReady, async (readyClient) => {
  logger.info(`Logged in as ${readyClient.user.tag}`);
  
  // Initialize log channel first
  await logger.init();
  
  logger.info(`Monitoring voice channel: ${CONFIG.voiceChannelId}`);
  logger.info(`Posting prompts to: ${CONFIG.notesTextChannelId}`);
  logger.info(`Join grace period: ${CONFIG.joinGraceSeconds}s`);
  logger.info(`Empty grace period: ${CONFIG.emptyGraceSeconds}s`);

  // Register slash commands
  await registerCommands();

  // Check if there are already humans in the voice channel (handles restart scenario)
  await safeExecute(async () => {
    const voiceChannel = await getTargetVoiceChannel();
    const humanCount = getHumanCount(voiceChannel);

    if (humanCount > 0 && sessionState === SessionState.INACTIVE) {
      logger.info(`Startup: Found ${humanCount} human(s) already in voice channel - posting prompt`);
      sessionState = SessionState.PROMPTED;
      await postMeetingPrompt();
    } else {
      logger.info(`Startup: No humans in voice channel (count: ${humanCount})`);
    }
  }, 'startup voice channel check');
});

/**
 * Handle voice state updates
 */
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  await safeExecute(async () => {
    // Check if this update involves our target voice channel
    const targetChannelId = CONFIG.voiceChannelId;
    const wasInTarget = oldState.channelId === targetChannelId;
    const isInTarget = newState.channelId === targetChannelId;

    // Ignore if neither old nor new state involves our channel
    if (!wasInTarget && !isInTarget) return;

    // Ignore bot users
    if (newState.member?.user?.bot) return;

    const voiceChannel = await getTargetVoiceChannel();
    const humanCount = getHumanCount(voiceChannel);
    
    // Check if someone joined (not just moved or left)
    const isJoin = !wasInTarget && isInTarget;

    logger.debug(`Voice update: ${humanCount} human(s) in channel, state: ${sessionState}, isJoin: ${isJoin}`);

    // Handle transitions
    if (humanCount > 0) {
      clearGraceTimer();

      if (sessionState === SessionState.INACTIVE && !joinGraceTimer) {
        logger.info('Human joined - starting join grace timer');
        startJoinGraceTimer();
      } else if (sessionState === SessionState.WAITING && isJoin) {
        // Someone new joined while waiting - re-post the prompt
        logger.info('New human joined while waiting - re-posting prompt');
        sessionState = SessionState.PROMPTED;
        await postMeetingPrompt();
      }
    } else {
      // humanCount === 0
      clearJoinGraceTimer();

      if ((sessionState === SessionState.PROMPTED || sessionState === SessionState.WAITING) && !graceTimer) {
        logger.info('All humans left - starting grace timer');
        startGraceTimer();
      } else if (sessionState === SessionState.INACTIVE) {
        logger.debug('All humans left while inactive - no action needed');
      }
    }
  }, 'voice state update');
});

/**
 * Handle button and slash command interactions
 */
client.on(Events.InteractionCreate, async (interaction) => {
  await safeExecute(async () => {
    // Handle slash commands
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === 'ping') {
        const latency = Date.now() - interaction.createdTimestamp;
        await interaction.reply(`🏓 Pong! Latency: ${latency}ms | WebSocket: ${client.ws.ping}ms`);
      } else if (commandName === 'status') {
        const uptime = Math.floor((Date.now() - botStartTime) / 1000);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = uptime % 60;

        const voiceChannel = await getTargetVoiceChannel();
        const humanCount = getHumanCount(voiceChannel);

        let statusMsg = `📊 **Bot Status**\n`;
        statusMsg += `> **State:** ${sessionState}\n`;
        statusMsg += `> **Uptime:** ${hours}h ${minutes}m ${seconds}s\n`;
        statusMsg += `> **Humans in VC:** ${humanCount}\n`;
        statusMsg += `> **Join Grace Timer:** ${joinGraceTimer ? 'Active' : 'Inactive'}\n`;
        statusMsg += `> **Empty Grace Timer:** ${graceTimer ? 'Active' : 'Inactive'}`;

        await interaction.reply(statusMsg);
      }
      return;
    }

    // Handle button interactions
    if (!interaction.isButton()) return;

    const { customId } = interaction;

    // Helper to safely reply to interaction
    const safeReply = async (options) => {
      if (interaction.replied || interaction.deferred) {
        return interaction.followUp(options);
      }
      return interaction.reply(options);
    };

    if (customId === 'start_notes') {
      try {
        // Disable buttons first
        await disablePromptButtons();

        // Send follow-up message
        await safeReply({
          content: buildNotesStartedMessage(),
        });

        logger.info('User clicked Start Notes - instructions posted');
      } catch (error) {
        logger.error('Error handling Start Notes button', error);
        try {
          await safeReply({
            content: '❌ An error occurred. Please run the NotesBot commands manually.',
            flags: MessageFlags.Ephemeral,
          });
        } catch (e) {
          // Interaction may have already been handled
        }
      }
    } else if (customId === 'no_notes') {
      try {
        // Disable buttons first
        await disablePromptButtons();

        // Acknowledge
        await safeReply({
          content: '👍 Okay, not starting notes for this session.',
        });

        logger.info('User clicked No - session continues without notes');
      } catch (error) {
        logger.error('Error handling No button', error);
        try {
          await safeReply({
            content: 'Acknowledged.',
            flags: MessageFlags.Ephemeral,
          });
        } catch (e) {
          // Interaction may have already been handled
        }
      }
    } else if (customId === 'wait_for_more') {
      try {
        sessionState = SessionState.WAITING;
        
        // Update the message to show waiting status
        const textChannel = await getNotesTextChannel();
        if (textChannel && currentPromptMessageId) {
          const message = await textChannel.messages.fetch(currentPromptMessageId);
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
        
        await safeReply({
          content: '⏳ Waiting for more people. The prompt will reappear when someone joins.',
          flags: MessageFlags.Ephemeral,
        });
        
        logger.info('User clicked Wait for More - waiting for new joins');
      } catch (error) {
        logger.error('Error handling Wait for More button', error);
        try {
          await safeReply({
            content: '❌ An error occurred.',
            flags: MessageFlags.Ephemeral,
          });
        } catch (e) {
          // Interaction may have already been handled
        }
      }
    }
  }, 'interaction handling');
});

/**
 * Handle Discord client errors
 */
client.on(Events.Error, (error) => {
  logger.error('Discord client error', error);
});

/**
 * Handle shard errors
 */
client.on(Events.ShardError, (error, shardId) => {
  logger.error(`Shard ${shardId} error`, error);
});

/**
 * Handle disconnects
 */
client.on(Events.ShardDisconnect, (event, shardId) => {
  logger.warn(`Shard ${shardId} disconnected (code: ${event.code})`);
});

/**
 * Handle reconnects
 */
client.on(Events.ShardReconnecting, (shardId) => {
  logger.info(`Shard ${shardId} reconnecting...`);
});

// ============================================================================
// Global Error Handlers
// ============================================================================

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', reason instanceof Error ? reason : new Error(String(reason)));
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', error);
  // Give time for the log to be sent to Discord
  setTimeout(() => process.exit(1), 1000);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT - shutting down gracefully');
  clearGraceTimer();
  clearJoinGraceTimer();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM - shutting down gracefully');
  clearGraceTimer();
  clearJoinGraceTimer();
  client.destroy();
  process.exit(0);
});

// ============================================================================
// Startup
// ============================================================================

validateConfig();
console.log('Starting Meeting Helper Bot...');
client.login(CONFIG.token).catch((error) => {
  console.error('Failed to login:', error.message);
  process.exit(1);
});
