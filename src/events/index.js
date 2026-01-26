const ready = require('./ready');
const voiceStateUpdate = require('./voiceStateUpdate');
const interactionCreate = require('./interactionCreate');
const { errorEvents, setupProcessHandlers } = require('./errors');

const events = [ready, voiceStateUpdate, interactionCreate, ...errorEvents];

function loadEvents(client) {
  for (const event of events) {
    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args, client));
    } else {
      client.on(event.name, (...args) => event.execute(...args, client));
    }
  }

  setupProcessHandlers(client);
}

module.exports = { loadEvents };
