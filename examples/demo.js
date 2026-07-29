const mineflayer = require('mineflayer');
const { ElytraFlight } = require('@eksses/eafe');

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'test',
});

bot.once('spawn', () => {
  const flight = new ElytraFlight(bot, {
    mode: 'MED',
    cruiseAlt: 180,
    debug: true,
  });

  flight.on('phase', (phase) => console.log(`Phase: ${phase}`));
  flight.on('error', (err) => console.error(`Error: ${err.message}`));
  flight.on('stopped', (r) => console.log(`Stopped: ${r}`));

  console.log('Bot spawned! Type "f X Z" in chat to fly.');

  let targetX = 0;
  let targetZ = 0;

  bot.on('chat', (user, msg) => {
    const args = msg.split(' ');

    if (args[0] === 'f') {
      targetX = parseInt(args[1]) || 0;
      targetZ = parseInt(args[2]) || 0;
      flight.fly(targetX, targetZ);
      bot.chat(`Flying to ${targetX} ${targetZ}`);
    }

    if (args[0] === 'stop') {
      flight.stop();
      bot.chat('Stopped');
    }

    if (args[0] === 'fast') flight.setMode('FAST');
    if (args[0] === 'med') flight.setMode('MED');
    if (args[0] === 'low') flight.setMode('LOW');

    if (args[0] === 'status') {
      const s = flight.setStatus(targetX, targetZ);
      bot.chat(`Phase: ${s.phase} | Pos: ${s.pos.x},${s.pos.y},${s.pos.z} | Dist: ${s.dist}m | Elytra: ${s.elytra.dur} | Rockets: ${s.rockets}`);
    }
  });
});
