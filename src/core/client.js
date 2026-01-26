const { Client, GatewayIntentBits } = require('discord.js');

/**
 * Creates and configures the Discord client with required intents
 * @param {number[]} additionalIntents - Additional intents required by features
 */
function createClient(additionalIntents = []) {
  const baseIntents = [GatewayIntentBits.Guilds];
  const allIntents = [...new Set([...baseIntents, ...additionalIntents])];

  return new Client({
    intents: allIntents,
  });
}

module.exports = { createClient, GatewayIntentBits };
