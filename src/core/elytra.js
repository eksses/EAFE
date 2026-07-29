'use strict';

const Logger = require('../logger');

function getUnbreakingLevel(item) {
  if (!item) return 0;
  if (item.enchants && Array.isArray(item.enchants)) {
    const u = item.enchants.find(e => e.name === 'unbreaking' || e.name === 'durability');
    if (u) return u.lvl ?? 1;
  }
  try {
    const enchs = item.nbt?.value?.Enchantments?.value?.value || item.nbt?.value?.ench?.value?.value;
    if (enchs && Array.isArray(enchs)) {
      const u = enchs.find(e => e.id?.value === 'unbreaking' || e.id?.value === 34);
      if (u) return u.lvl?.value ?? 1;
    }
  } catch(_) {}
  return 0;
}

function getElytraDamageRate(unbreakingLvl) {
  switch (unbreakingLvl) {
    case 1: return 0.50;
    case 2: return 0.333;
    case 3: return 0.25;
    default: return 1.0;
  }
}

function calculateRequiredElytraDurability(d2d, speedMps, unbreakingLvl) {
  const flightTimeSec = d2d / Math.max(speedMps, 10.0);
  const damageRate = getElytraDamageRate(unbreakingLvl);
  const reqDur = Math.ceil(flightTimeSec * damageRate);
  return reqDur + 15;
}

function getElytraSummary(bot) {
  let count = 0;
  let equippedDur = 0;
  let maxDur = 0;
  let totalDurabilityAcrossAll = 0;
  let bestUnbreaking = 0;

  const chest = bot.inventory.slots[6];
  if (chest?.name === 'elytra') {
    equippedDur = chest.maxDurability ? (chest.maxDurability - chest.durabilityUsed) : 432;
    count++;
    totalDurabilityAcrossAll += equippedDur;
    if (equippedDur > maxDur) maxDur = equippedDur;
    const u = getUnbreakingLevel(chest);
    if (u > bestUnbreaking) bestUnbreaking = u;
  }

  for (let s = 0; s <= 45; s++) {
    if (s === 6) continue;
    const item = bot.inventory.slots[s];
    if (item && item.name === 'elytra') {
      const dur = item.maxDurability ? (item.maxDurability - item.durabilityUsed) : 432;
      count++;
      totalDurabilityAcrossAll += dur;
      if (dur > maxDur) maxDur = dur;
      const u = getUnbreakingLevel(item);
      if (u > bestUnbreaking) bestUnbreaking = u;
    }
  }

  return { count, equippedDur, maxDur, totalDurabilityAcrossAll, bestUnbreaking };
}

async function auditAndEquipElytra(ctx) {
  const { bot } = ctx;
  const chest = bot.inventory.slots[6];
  let currentEquippedDur = -1;
  if (chest?.name === 'elytra') {
    currentEquippedDur = chest.maxDurability ? (chest.maxDurability - chest.durabilityUsed) : 432;
  }

  if (currentEquippedDur > 10) return true;

  let bestSlot = null;
  let bestDur = -1;

  for (let s = 0; s <= 45; s++) {
    if (s === 6) continue;
    const item = bot.inventory.slots[s];
    if (item && item.name === 'elytra') {
      const dur = item.maxDurability ? (item.maxDurability - item.durabilityUsed) : 432;
      if (dur > bestDur && dur > 10) {
        bestDur = dur;
        bestSlot = s;
      }
    }
  }

  if (bestSlot === null) {
    Logger.warn(`no spare elytra (equipped=${currentEquippedDur > 0 ? currentEquippedDur : 0}/432)`);
    ctx.safeChat(`Elytra low (${currentEquippedDur > 0 ? currentEquippedDur : 0}/432)! Need fresh one!`);
    return false;
  }

  const spareItem = bot.inventory.slots[bestSlot];
  try {
    await bot.equip(spareItem, 'torso');
    Logger.info(`elytra swap slot${bestSlot} dur=${bestDur}/432 (was ${currentEquippedDur})`);
    ctx.safeChat(`Elytra swapped (${bestDur}/432)`);
    return true;
  } catch(e) {
    Logger.error('equip elytra fail:', e.message);
    return false;
  }
}

module.exports = {
  getUnbreakingLevel,
  getElytraDamageRate,
  calculateRequiredElytraDurability,
  getElytraSummary,
  auditAndEquipElytra,
};
