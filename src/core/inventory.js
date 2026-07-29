'use strict';

const Logger = require('../logger');

function countRockets(bot) {
  let count = 0;
  for (let slot = 0; slot <= 45; slot++) {
    const i = bot.inventory.slots[slot];
    if (i && i.name === 'firework_rocket') {
      try { if (i.nbt?.value?.Fireworks?.value?.Explosions) continue; } catch(_) {}
      count += i.count;
    }
  }
  return count;
}

function findRocket(bot) {
  const offhand = bot.inventory.slots[45];
  if (offhand && offhand.name === 'firework_rocket') return offhand;

  for (let slot = 0; slot <= 44; slot++) {
    const i = bot.inventory.slots[slot];
    if (i && i.name === 'firework_rocket') {
      try { if (i.nbt?.value?.Fireworks?.value?.Explosions) continue; } catch(_) {}
      return i;
    }
  }
  return null;
}

async function autoEquipRocket(bot) {
  const offhand = bot.inventory.slots[45];
  if (offhand?.name === 'firework_rocket') return true;

  const rocket = findRocket(bot);
  if (!rocket) {
    Logger.warn('no rockets in inventory');
    return false;
  }

  try {
    await bot.equip(rocket, 'off-hand');
    Logger.debug('rkt equip offhand');
    return true;
  } catch(e) {
    Logger.warn('equip rkt fail:', e.message);
    return false;
  }
}

module.exports = { countRockets, findRocket, autoEquipRocket };
