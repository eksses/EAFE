const mineflayer = require('mineflayer');
const { ElytraFlight } = require('eafe');

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'TransferBot',
});

// Storage locations
const storage = {
  source: null,
  dest: null,
};

let transferMode = false;
let transferItem = null;

bot.once('spawn', () => {
  const flight = new ElytraFlight(bot, {
    mode: 'MED',
    cruiseAlt: 180,
    debug: true,
  });

  flight.on('phase', (phase) => {
    if (phase === 'IDLE' && transferMode) {
      handleTransferArrival();
    }
  });

  flight.on('error', (err) => console.error('Error:', err.message));

  bot.on('chat', (user, msg) => {
    const args = msg.split(' ');

    // Set source location (current position)
    if (args[0] === 'source') {
      const pos = bot.entity.position;
      storage.source = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };
      bot.chat(`Source set to (${storage.source.x},${storage.source.y},${storage.source.z})`);
    }

    // Set destination location (current position)
    if (args[0] === 'dest') {
      const pos = bot.entity.position;
      storage.dest = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };
      bot.chat(`Destination set to (${storage.dest.x},${storage.dest.y},${storage.dest.z})`);
    }

    // Transfer items
    if (args[0] === 'transfer' && args[1]) {
      if (!storage.source || !storage.dest) {
        bot.chat('Set source and dest first');
        return;
      }

      transferItem = args[1];
      transferMode = true;

      // Go to source first
      bot.chat(`Going to source to pick up ${transferItem}...`);
      flight.fly(storage.source.x, storage.source.z);
    }

    // Transfer all items
    if (args[0] === 'transfer-all') {
      if (!storage.source || !storage.dest) {
        bot.chat('Set source and dest first');
        return;
      }

      transferItem = null;
      transferMode = true;
      bot.chat('Going to source to pick up all items...');
      flight.fly(storage.source.x, storage.source.z);
    }

    // Cancel
    if (args[0] === 'cancel') {
      transferMode = false;
      transferItem = null;
      flight.stop();
      bot.chat('Transfer cancelled');
    }

    // Status
    if (args[0] === 'status') {
      const s = flight.setStatus(flight._targetX, flight._targetZ);
      bot.chat(`${s.phase} | ${s.pos.x},${s.pos.y},${s.pos.z} | ${s.dist}m`);
    }

    // View storage
    if (args[0] === 'storage') {
      bot.chat(`Source: ${storage.source ? `(${storage.source.x},${storage.source.z})` : 'not set'}`);
      bot.chat(`Dest: ${storage.dest ? `(${storage.dest.x},${storage.dest.z})` : 'not set'}`);
    }
  });

  function handleTransferArrival() {
    const pos = bot.entity.position;
    const atSource = storage.source && Math.hypot(pos.x - storage.source.x, pos.z - storage.source.z) < 5;
    const atDest = storage.dest && Math.hypot(pos.x - storage.dest.x, pos.z - storage.dest.z) < 5;

    if (atSource) {
      // Pick up items from nearby chests
      const chests = bot.findBlocks({
        matching: block => block.name === 'chest',
        maxDistance: 4,
        count: 1,
      });

      if (chests.length > 0) {
        const chest = bot.blockAt(chests[0]);
        bot.openChest(chest).then(chest => {
          const items = transferItem
            ? chest.containerItems().filter(i => i.name === transferItem)
            : chest.containerItems();

          items.forEach(item => {
            chest.withdraw(item.type, null, item.count).catch(() => {});
          });

          bot.chat(`Picked up ${items.length} items`);
          chest.close();

          // Go to destination
          setTimeout(() => {
            bot.chat('Going to destination...');
            flight.fly(storage.dest.x, storage.dest.z);
          }, 1000);
        }).catch(err => {
          bot.chat(`Cannot open chest: ${err.message}`);
          transferMode = false;
        });
      } else {
        bot.chat('No chests found nearby');
        transferMode = false;
      }
    } else if (atDest) {
      // Drop items or put in chest
      const chests = bot.findBlocks({
        matching: block => block.name === 'chest',
        maxDistance: 4,
        count: 1,
      });

      if (chests.length > 0) {
        const chest = bot.blockAt(chests[0]);
        bot.openChest(chest).then(chest => {
          const items = transferItem
            ? bot.inventory.items().filter(i => i.name === transferItem)
            : bot.inventory.items();

          items.forEach(item => {
            chest.deposit(item.type, null, item.count).catch(() => {});
          });

          bot.chat(`Deposited ${items.length} items`);
          chest.close();
          transferMode = false;
        }).catch(err => {
          bot.chat(`Cannot open chest: ${err.message}`);
          transferMode = false;
        });
      } else {
        // Drop items on ground
        const items = transferItem
          ? bot.inventory.items().filter(i => i.name === transferItem)
          : bot.inventory.items();

        items.forEach(item => {
          bot.tossStack(item);
        });

        bot.chat(`Dropped ${items.length} items`);
        transferMode = false;
      }
    }
  }

  console.log('Transfer bot ready');
  console.log('Commands:');
  console.log('  source - Set source location');
  console.log('  dest - Set destination location');
  console.log('  transfer <item> - Transfer specific item');
  console.log('  transfer-all - Transfer all items');
  console.log('  storage - View locations');
});
