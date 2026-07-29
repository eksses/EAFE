const mineflayer = require('mineflayer');
const { ElytraFlight } = require('eafe');

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'RescueBot',
});

const rescueQueue = [];
let isRescuing = false;

bot.once('spawn', () => {
  const flight = new ElytraFlight(bot, {
    mode: 'FAST',
    cruiseAlt: 200,
    maxRetries: 5,
    debug: true,
    ownerUsername: 'Admin',
  });

  flight.on('phase', (phase) => {
    if (phase === 'IDLE' && isRescuing) {
      processNextRescue();
    }
  });

  flight.on('error', (err) => {
    console.error('Error:', err.message);
    bot.chat(`Error: ${err.message}`);
  });

  bot.on('chat', (user, msg) => {
    const args = msg.split(' ');

    // Rescue call
    if (args[0] === 'rescue') {
      const x = parseInt(args[1]) || Math.round(bot.entity.position.x);
      const z = parseInt(args[2]) || Math.round(bot.entity.position.z);
      rescueQueue.push({ x, z, user });
      bot.chat(`Rescue queued for ${user} at (${x},${z})`);

      if (!isRescuing) processNextRescue();
    }

    // Rescue nearest player
    if (args[0] === 'rescue-me') {
      const player = bot.players[user];
      if (player && player.entity) {
        const pos = player.entity.position;
        rescueQueue.push({ x: Math.round(pos.x), z: Math.round(pos.z), user });
        bot.chat(`Rescue queued for ${user}`);

        if (!isRescuing) processNextRescue();
      } else {
        bot.chat(`Cannot see ${user}`);
      }
    }

    // View queue
    if (args[0] === 'rescue-queue') {
      if (rescueQueue.length === 0) {
        bot.chat('No rescues queued');
      } else {
        rescueQueue.forEach((r, i) => {
          bot.chat(`${i + 1}. ${r.user} at (${r.x},${r.z})`);
        });
      }
    }

    // Cancel
    if (args[0] === 'rescue-cancel') {
      rescueQueue.length = 0;
      isRescuing = false;
      flight.stop();
      bot.chat('Rescues cancelled');
    }

    // Status
    if (args[0] === 'status') {
      const s = flight.setStatus(flight._targetX, flight._targetZ);
      bot.chat(`${s.phase} | ${s.pos.x},${s.pos.y},${s.pos.z} | ${s.dist}m`);
    }
  });

  function processNextRescue() {
    if (rescueQueue.length === 0) {
      isRescuing = false;
      bot.chat('All rescues complete');
      return;
    }

    isRescuing = true;
    const next = rescueQueue[0];

    bot.chat(`Rescuing ${next.user} at (${next.x},${next.z})...`);
    flight.fly(next.x, next.z);

    flight.once('phase', function onArrival(phase) {
      if (phase === 'IDLE') {
        bot.chat(`Rescued ${next.user}!`);
        rescueQueue.shift();
        processNextRescue();
      }
    });
  }

  console.log('Rescue bot ready');
  console.log('Commands:');
  console.log('  rescue X Z - Rescue at coordinates');
  console.log('  rescue-me - Rescue nearest player');
  console.log('  rescue-queue - View queue');
  console.log('  rescue-cancel - Cancel all');
});
