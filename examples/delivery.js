const mineflayer = require('mineflayer');
const { ElytraFlight } = require('eafe');

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'DeliveryBot',
});

// Delivery queue
const deliveries = [];
let isDelivering = false;

bot.once('spawn', () => {
  const flight = new ElytraFlight(bot, {
    mode: 'MED',
    cruiseAlt: 180,
    debug: true,
    safety: true,
  });

  flight.on('phase', (phase) => {
    if (phase === 'IDLE' && isDelivering) {
      processNextDelivery();
    }
  });

  flight.on('error', (err) => console.error('Error:', err.message));

  bot.on('chat', (user, msg) => {
    const args = msg.split(' ');

    // Add delivery: deliver X Z item count
    if (args[0] === 'deliver') {
      const x = parseInt(args[1]) || 0;
      const z = parseInt(args[2]) || 0;
      const item = args[3] || 'diamond';
      const count = parseInt(args[4]) || 1;

      deliveries.push({ x, z, item, count, user });
      bot.chat(`Queued delivery to (${x},${z}): ${count}x ${item}`);

      if (!isDelivering) processNextDelivery();
    }

    // View queue
    if (args[0] === 'queue') {
      if (deliveries.length === 0) {
        bot.chat('No deliveries queued');
      } else {
        bot.chat(`${deliveries.length} deliveries queued`);
        deliveries.forEach((d, i) => {
          bot.chat(`${i + 1}. (${d.x},${d.z}) ${d.count}x ${d.item}`);
        });
      }
    }

    // Clear queue
    if (args[0] === 'clear') {
      deliveries.length = 0;
      isDelivering = false;
      flight.stop();
      bot.chat('Queue cleared');
    }

    // Stop
    if (args[0] === 'stop') {
      flight.stop();
      isDelivering = false;
      bot.chat('Stopped');
    }
  });

  async function processNextDelivery() {
    if (deliveries.length === 0) {
      isDelivering = false;
      bot.chat('All deliveries complete');
      return;
    }

    isDelivering = true;
    const next = deliveries[0];

    bot.chat(`Delivering to (${next.x},${next.z})...`);
    flight.fly(next.x, next.z);

    // Wait for arrival
    flight.once('phase', function onArrival(phase) {
      if (phase === 'IDLE') {
        // Drop items
        const item = bot.inventory.items().find(i => i.name === next.item);
        if (item) {
          bot.tossStack(item);
          bot.chat(`Delivered ${next.count}x ${next.item} to (${next.x},${next.z})`);
        } else {
          bot.chat(`No ${next.item} to deliver`);
        }

        // Remove from queue
        deliveries.shift();
        processNextDelivery();
      }
    });
  }

  console.log('Delivery bot ready');
  console.log('Commands:');
  console.log('  deliver X Z item count - Add delivery');
  console.log('  queue - View deliveries');
  console.log('  clear - Clear queue');
});
