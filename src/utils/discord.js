const { CONFIG } = require('../core/config');
const { logger } = require('../core/logger');

let _client = null;

function setClient(client) {
  _client = client;
}

function getClient() {
  return _client;
}

/**
 * Fetches a channel by ID from the configured guild
 */
async function fetchChannel(channelId) {
  try {
    const guild = await _client.guilds.fetch(CONFIG.guildId);
    return await guild.channels.fetch(channelId);
  } catch (error) {
    logger.error(`Error fetching channel ${channelId}`, error);
    return null;
  }
}

/**
 * Gets members in a voice channel, optionally filtering bots
 */
function getVoiceChannelMembers(voiceChannel, includeBots = false) {
  if (!voiceChannel || !voiceChannel.members) return [];
  
  if (includeBots) {
    return Array.from(voiceChannel.members.values());
  }
  
  return voiceChannel.members.filter((member) => !member.user.bot);
}

/**
 * Counts humans (non-bots) in a voice channel
 */
function getHumanCount(voiceChannel) {
  if (!voiceChannel || !voiceChannel.members) return 0;
  return voiceChannel.members.filter((member) => !member.user.bot).size;
}

/**
 * Gets mentions for all humans in a voice channel
 */
function getVoiceChannelMentions(voiceChannel) {
  if (!voiceChannel || !voiceChannel.members) return '';
  const humans = voiceChannel.members.filter((member) => !member.user.bot);
  return humans.map((member) => `<@${member.user.id}>`).join(' ');
}

module.exports = {
  setClient,
  getClient,
  fetchChannel,
  getVoiceChannelMembers,
  getHumanCount,
  getVoiceChannelMentions,
};
