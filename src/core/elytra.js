'use strict';

const Logger = require('../logger');

/**
 * Detect Unbreaking level across mineflayer item shapes:
 *  - pre-1.20.5:  item.enchants = [{ name: 'unbreaking', lvl: 3 }]
 *  - 1.20.5+:     item.enchants = [{ id: 'minecraft:unbreaking', lvl: 3 }] (item components)
 *  - raw NBT:     item.nbt.value.Enchantments.value.value = [{ id: 34, lvl: 3 }]
 */
function getUnbreakingLevel(item) {
  if (!item) return 0;

  const enchs = item.enchants;
  if (Array.isArray(enchs)) {
    const u = enchs.find(e =>
      e.name === 'unbreaking' || e.name === 'durability' ||
      e.id === 'minecraft:unbreaking' || e.id === 'unbreaking' || e.id === 34
    );
    if (u) return u.lvl ?? 1;
  }

  try {
    const raw = item.nbt?.value?.Enchantments?.value?.value;
    if (raw && Array.isArray(raw)) {
      const u = raw.find(e => {
        const id = e.id?.value ?? e.id;
        return id === 34 || id === 'unbreaking' || id === 'minecraft:unbreaking';
      });
      if (u) {
        const lvl = u.lvl?.value ?? u.lvl;
        return Number(lvl) || 1;
      }
    }
  } catch (_) { /* NBT shape varies by version — fall through */ }

  return 0;
}

/**
 * Expected elytra durability loss per second of flight.
 *
 * Unbreaking n deals damage with probability 2/(n+3) (no damage with
 * probability (n+1)/(n+3)), so the expected rate is `2 / (n + 3)`:
 *   unenchanted 1.0, U1 0.5, U2 0.4, U3 ~0.333, U4 ~0.286 ...
 * (The old 1/(n+1) table under-estimated U3 by 25% — preflight could pass
 * while the elytra broke mid-flight.)
 */
function getElytraDamageRate(unbreakingLvl) {
  if (!unbreakingLvl || unbreakingLvl < 1) return 1.0;
  return 2 / (unbreakingLvl + 3);
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

/**
 * Ensure the chest slot holds the best elytra.
 *
 * @param {object} ctx  flight context (needs bot, safeChat, logger)
 * @param {object} [options]
 * @param {boolean} [options.equip=true]  actually swap items. Pass false for a
 *        pure "check" (used by preflight()).
 * @returns {Promise<boolean>} true when an elytra with durability > 10 is (or
 *        will be) equipped.
 */
async function auditAndEquipElytra(ctx, options = {}) {
  const { equip = true } = options;
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

  if (!equip) return true; // check-only: a good spare exists

  const spareItem = bot.inventory.slots[bestSlot];
  try {
    await bot.equip(spareItem, 'torso');
    Logger.info(`elytra swap slot${bestSlot} dur=${bestDur}/432 (was ${currentEquippedDur})`);
    ctx.safeChat(`Elytra swapped (${bestDur}/432)`);
    return true;
  } catch (e) {
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
