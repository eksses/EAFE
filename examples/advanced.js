const mineflayer = require('mineflayer');
const { ElytraFlight } = require('eafe');

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'Bot',
});

bot.once('spawn', () => {
  const flight = new ElytraFlight(bot, {
    mode: 'FAST',          // FAST, MED, LOW
    cruiseAlt: 200,        // cruise altitude
    maxRetries: 5,         // retry attempts
    safety: true,          // pre-flight checks
    debug: true,           // verbose logging
    ownerUsername: 'Steve', // whisper alerts to this player
  });

  flight.on('phase', (phase, msg) => console.log(`[${phase}] ${msg || ''}`));
  flight.on('stopped', (r) => console.log('Stopped:', r));
  flight.on('error', (e) => console.error('Error:', e.message));

  // Fly with overrides
  flight.fly(1000, -500, { mode: 'LOW', cruiseAlt: 150 });

  // Check status anytime
  setInterval(() => {
    if (flight.isFlying) {
      const s = flight.setStatus(flight._targetX, flight._targetZ);
      console.log(`${s.phase} pos=(${s.pos.x},${s.pos.y},${s.pos.z}) dist=${s.dist}m e=${s.elytra.dur} rkt=${s.rockets}`);
    }
  }, 5000);

  // Emergency stop
  // flight.stop();
});
