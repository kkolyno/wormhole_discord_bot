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
// Session State Machine
// ============================================================================

const SessionState = {
  INACTIVE: 'inactive',
  PROMPTED: 'prompted',
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
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(CONFIG.clientId, CONFIG.guildId), {
      body: commands.map((cmd) => cmd.toJSON()),
    });
    console.log('Slash commands registered successfully');
  } catch (error) {
    console.error('Error registering slash commands:', error.message);
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
 * Get the target voice channel
 */
async function getTargetVoiceChannel() {
  try {
    const guild = await client.guilds.fetch(CONFIG.guildId);
    const channel = await guild.channels.fetch(CONFIG.voiceChannelId);
    return channel;
  } catch (error) {
    console.error('Error fetching voice channel:', error.message);
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
    console.error('Error fetching notes text channel:', error.message);
    return null;
  }
}

/**
 * Create the prompt buttons
 */
function createPromptButtons(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('start_notes')
      .setLabel('Start Notes')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('no_notes')
      .setLabel('No')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );
}

/**
 * Build the prompt message content
 */
function buildPromptContent() {
  if (CONFIG.promptText) {
    return CONFIG.promptText;
  }

  let content = `📋 **Meeting detected** in <#${CONFIG.voiceChannelId}>!\n\n`;
  content += `> Meeting notes use NotesBot recording/transcription.\n\n`;
  content += `Would you like to start meeting notes?`;

  if (CONFIG.pingRoleId) {
    content = `<@&${CONFIG.pingRoleId}>\n\n` + content;
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
    console.error('Cannot post prompt: notes text channel not found');
    return;
  }

  try {
    const message = await textChannel.send({
      content: buildPromptContent(),
      components: [createPromptButtons(false)],
    });
    currentPromptMessageId = message.id;
    console.log(`Posted meeting prompt (message ID: ${message.id})`);
  } catch (error) {
    console.error('Error posting meeting prompt:', error.message);
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
    console.error('Error disabling prompt buttons:', error.message);
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
      console.log('Grace period expired with no humans - resetting to Inactive');
      sessionState = SessionState.INACTIVE;
      currentPromptMessageId = null;
    } else {
      console.log('Grace period expired but humans are present - staying Prompted');
    }
  }, CONFIG.emptyGraceSeconds * 1000);

  console.log(`Started grace timer (${CONFIG.emptyGraceSeconds}s)`);
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
      console.log('Join grace period expired with humans present - posting prompt');
      sessionState = SessionState.PROMPTED;
      await postMeetingPrompt();
    } else {
      console.log('Join grace period expired but no humans - staying Inactive');
    }
  }, CONFIG.joinGraceSeconds * 1000);

  console.log(`Started join grace timer (${CONFIG.joinGraceSeconds}s)`);
}

// ============================================================================
// Event Handlers
// ============================================================================

/**
 * Handle bot ready event
 */
client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Monitoring voice channel: ${CONFIG.voiceChannelId}`);
  console.log(`Posting prompts to: ${CONFIG.notesTextChannelId}`);
  console.log(`Join grace period: ${CONFIG.joinGraceSeconds}s`);
  console.log(`Empty grace period: ${CONFIG.emptyGraceSeconds}s`);

  // Register slash commands
  await registerCommands();

  // Check if there are already humans in the voice channel
  const voiceChannel = await getTargetVoiceChannel();
  const humanCount = getHumanCount(voiceChannel);

  if (humanCount > 0 && sessionState === SessionState.INACTIVE) {
    console.log(`Startup: Found ${humanCount} human(s) in voice channel - posting prompt`);
    sessionState = SessionState.PROMPTED;
    await postMeetingPrompt();
  } else {
    console.log(`Startup: No humans in voice channel (count: ${humanCount})`);
  }
});

/**
 * Handle voice state updates
 */
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
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

  console.log(`Voice update: ${humanCount} human(s) in channel, state: ${sessionState}`);

  // Handle transitions
  if (humanCount > 0) {
    clearGraceTimer();

    if (sessionState === SessionState.INACTIVE && !joinGraceTimer) {
      console.log('Human joined - starting join grace timer');
      startJoinGraceTimer();
    }
  } else {
    // humanCount === 0
    clearJoinGraceTimer();

    if (sessionState === SessionState.PROMPTED && !graceTimer) {
      console.log('All humans left - starting grace timer');
      startGraceTimer();
    } else if (sessionState === SessionState.INACTIVE) {
      console.log('All humans left while inactive - no action needed');
    }
  }
});

/**
 * Handle button and slash command interactions
 */
client.on(Events.InteractionCreate, async (interaction) => {
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

  if (customId === 'start_notes') {
    try {
      // Disable buttons
      await disablePromptButtons();

      // Send follow-up message
      await interaction.reply({
        content: buildNotesStartedMessage(),
      });

      console.log('User clicked Start Notes - instructions posted');
    } catch (error) {
      console.error('Error handling Start Notes button:', error.message);
      try {
        await interaction.reply({
          content: '❌ An error occurred. Please run the NotesBot commands manually.',
          ephemeral: true,
        });
      } catch (e) {
        // Interaction may have already been handled
      }
    }
  } else if (customId === 'no_notes') {
    try {
      // Disable buttons
      await disablePromptButtons();

      // Acknowledge
      await interaction.reply({
        content: '👍 Okay, not starting notes for this session.',
      });

      console.log('User clicked No - session continues without notes');
    } catch (error) {
      console.error('Error handling No button:', error.message);
      try {
        await interaction.reply({
          content: 'Acknowledged.',
          ephemeral: true,
        });
      } catch (e) {
        // Interaction may have already been handled
      }
    }
  }
});

/**
 * Handle errors
 */
client.on(Events.Error, (error) => {
  console.error('Discord client error:', error.message);
});

// ============================================================================
// Startup
// ============================================================================

validateConfig();
console.log('Starting Meeting Helper Bot...');
client.login(CONFIG.token);
