'use strict';

const Logger = require('../logger');

/**
 * Rockets that carry a custom star (NBT `Fireworks.Explosions`) are NOT
 * counted by default — the engine only plans around plain rockets. Pass
 * `{ includeCustom: true }` to count them as well.
 */
function hasCustomStar(item) {
  try { return Boolean(item.nbt?.value?.Fireworks?.value?.Explosions); } catch (_) { return false; }
}

function countRockets(bot, { includeCustom = false } = {}) {
  let count = 0;
  for (let slot = 0; slot <= 45; slot++) {
    const i = bot.inventory.slots[slot];
    if (i && i.name === 'firework_rocket') {
      if (!includeCustom && hasCustomStar(i)) continue;
      count += i.count;
    }
  }
  return count;
}

function getRocketSummary(bot) {
  let plain = 0;
  let custom = 0;
  for (let slot = 0; slot <= 45; slot++) {
    const i = bot.inventory.slots[slot];
    if (i && i.name === 'firework_rocket') {
      if (hasCustomStar(i)) custom += i.count;
      else plain += i.count;
    }
  }
  return { plain, custom, total: plain + custom };
}

function findRocket(bot, { includeCustom = false } = {}) {
  const offhand = bot.inventory.slots[45];
  if (offhand && offhand.name === 'firework_rocket' && (includeCustom || !hasCustomStar(offhand))) {
    return offhand;
  }

  for (let slot = 0; slot <= 44; slot++) {
    const i = bot.inventory.slots[slot];
    if (i && i.name === 'firework_rocket' && (includeCustom || !hasCustomStar(i))) {
      return i;
    }
  }
  return null;
}

async function autoEquipRocket(bot, { includeCustom = false } = {}) {
  const offhand = bot.inventory.slots[45];
  if (offhand?.name === 'firework_rocket') return true;

  const rocket = findRocket(bot, { includeCustom });
  if (!rocket) {
    const s = getRocketSummary(bot);
    Logger.warn(`no plain rockets (custom star rockets: ${s.custom})`);
    return false;
  }

  try {
    await bot.equip(rocket, 'off-hand');
    Logger.debug('rkt equip offhand');
    return true;
  } catch (e) {
    Logger.warn('equip rkt fail:', e.message);
    return false;
  }
}

module.exports = { countRockets, getRocketSummary, findRocket, autoEquipRocket };
