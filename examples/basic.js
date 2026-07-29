const mineflayer = require('mineflayer');
const { ElytraFlight } = require('eafe');

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

  // Fly to coordinates
  flight.fly(500, 500);
});
