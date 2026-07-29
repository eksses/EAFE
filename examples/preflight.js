const mineflayer = require('mineflayer');
const { ElytraFlight, countRockets, getElytraSummary } = require('@eksses/eafe');

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'Bot',
});

bot.once('spawn', async () => {
  const flight = new ElytraFlight(bot, { debug: true });

  flight.on('phase', (p, msg) => console.log(`[${p}] ${msg || ''}`));
  flight.on('error', (e) => console.error(e.message));

  // Pre-flight check only (no actual flight)
  const check = await flight.preflight();
  console.log('Preflight:', check);
  // { ok: true, elytra: { have: 432, need: 50 }, rockets: { have: 20, need: 8 } }

  // Set target without flying
  flight.setTarget(100, 200);
  console.log('Target set to', flight._targetX, flight._targetZ);

  // Get full status
  const status = flight.setStatus(flight._targetX, flight._targetZ);
  console.log('Status:', status);

  // Then fly
  // flight.fly(100, 200);
});
