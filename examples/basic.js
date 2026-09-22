const mineflayer = require('mineflayer');
const { ElytraFlight } = require('@eksses/eafe');

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'Bot',
});

bot.once('spawn', () => {
  const flight = new ElytraFlight(bot);

  // Listen for events
  flight.on('phase', (phase) => console.log('Phase:', phase));
  flight.on('stopped', (reason) => console.log('Stopped:', reason));
  flight.on('error', (err) => console.error('Error:', err.message));

  // Fly to coordinates — fly() returns a promise that resolves with the
  // landing position and rejects with a typed ElytraFlightError (err.code)
  flight.fly(500, 500)
    .then((res) => console.log('Landed at', res.landedAt))
    .catch((err) => {
      if (err.code === 'STOPPED') return;
      console.error('Flight failed:', err.code, err.message);
    });
});
