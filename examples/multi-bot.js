const mineflayer = require('mineflayer');
const { ElytraFlight } = require('@eksses/eafe');

const BOTS = [
  { name: 'Scout1', host: 'localhost', port: 25565 },
  { name: 'Scout2', host: 'localhost', port: 25565 },
  { name: 'Scout3', host: 'localhost', port: 25565 },
];

const flightTargets = new Map();
const flightInstances = new Map();

BOTS.forEach(botOpts => {
  const bot = mineflayer.createBot(botOpts);

  bot.once('spawn', () => {
    const flight = new ElytraFlight(bot, {
      mode: 'MED',
      cruiseAlt: 180,
      debug: false,
    });

    flightInstances.set(botOpts.name, flight);

    flight.on('phase', (phase) => {
      console.log(`[${botOpts.name}] ${phase}`);
    });

    flight.on('error', (err) => {
      console.error(`[${botOpts.name}] Error: ${err.message}`);
    });

    console.log(`${botOpts.name} spawned`);
  });

  bot.on('chat', (user, msg) => {
    const args = msg.split(' ');

    // Assign target to bot
    if (args[0] === 'assign' && args[1]) {
      const targetName = args[1];
      const x = parseInt(args[2]) || 0;
      const z = parseInt(args[3]) || 0;

      if (targetName === botOpts.name) {
        flightTargets.set(botOpts.name, { x, z });
        bot.chat(`Assigned to (${x},${z})`);
      }
    }

    // All bots fly to their targets
    if (args[0] === 'deploy') {
      const flight = flightInstances.get(botOpts.name);
      const target = flightTargets.get(botOpts.name);
      if (flight && target) {
        flight.fly(target.x, target.z);
        bot.chat(`Flying to (${target.x},${target.z})`);
      }
    }

    // Recall all bots
    if (args[0] === 'recall') {
      const flight = flightInstances.get(botOpts.name);
      if (flight) {
        flight.stop();
        bot.chat('Recalled');
      }
    }

    // Status
    if (args[0] === 'status' && args[1] === botOpts.name) {
      const flight = flightInstances.get(botOpts.name);
      if (flight) {
        const s = flight.setStatus(flight._targetX, flight._targetZ);
        bot.chat(`${s.phase} | ${s.pos.x},${s.pos.y},${s.pos.z} | ${s.dist}m | rkt=${s.rockets}`);
      }
    }
  });
});

console.log('Multi-bot fleet started');
console.log('Commands:');
console.log('  assign <bot> X Z - Set target for bot');
console.log('  deploy - All bots fly to targets');
console.log('  recall - All bots stop');
console.log('  status <bot> - Bot status');
