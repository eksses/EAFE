const mineflayer = require('mineflayer');
const { ElytraFlight, countRockets, getElytraSummary } = require('@eksses/eafe');

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'APIBot',
});

bot.once('spawn', async () => {
  const flight = new ElytraFlight(bot, { debug: true });

  // ── Programmatic API ──

  // 1. Simple flight
  // flight.fly(500, 500);

  // 2. Flight with options
  // flight.fly(500, 500, { mode: 'FAST', cruiseAlt: 200 });

  // 3. Chain commands
  // flight.setTarget(100, 200).setMode('LOW').fly();

  // 4. Check status
  // const status = flight.setStatus(500, 500);
  // console.log(status);

  // 5. Pre-flight check
  // const check = await flight.preflight();
  // console.log(check);

  // 6. Listen to events
  flight.on('phase', (phase, msg) => {
    console.log(`Phase: ${phase} ${msg || ''}`);
  });

  flight.on('stopped', (reason) => {
    console.log(`Stopped: ${reason}`);
  });

  flight.on('error', (err) => {
    console.error(`Error: ${err.message}`);
  });

  // 7. Use helper functions
  console.log('Rockets:', countRockets(bot));
  console.log('Elytra:', getElytraSummary(bot));

  // 8. Get landing stats
  // const landing = flight.getLandingStats();
  // console.log(landing);

  // 9. Programmatic control
  bot.on('chat', (user, msg) => {
    if (msg === 'test-api') {
      // Test all API methods
      console.log('Phase:', flight.phase);
      console.log('IsFlying:', flight.isFlying);

      flight.setTarget(100, 200);
      console.log('Target set');

      flight.setMode('FAST');
      console.log('Mode set');

      const status = flight.setStatus(flight._targetX, flight._targetZ);
      console.log('Status:', status);
    }
  });

  console.log('API demo ready');
  console.log('Type "test-api" in chat');
});
