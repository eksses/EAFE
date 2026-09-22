'use strict';

const { HAZARD_SURFACES } = require('./constants');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function isAir(block) {
  if (!block) return true;
  return block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
}

/**
 * Default hazard check — exact block names only (the old `name.includes('water')`
 * false-positived on safe blocks such as `water_strainer`).
 */
function isHazardousBlock(block) {
  if (!block) return true;
  return HAZARD_SURFACES.has(block.name);
}

/**
 * True when the block has a collision box (you can stand on / bounce off it).
 * Verified against prismarine-block runtime data: `boundingBox` is 'block'
 * for collision blocks and 'empty' for pass-through blocks.
 */
function hasCollision(block) {
  return Boolean(block) && block.boundingBox !== 'empty' && block.shapes && block.shapes.length > 0;
}

/**
 * Safe to build flight decisions on: solid, collision, not hazardous.
 * (The previous version accepted flowers/saplings/torches as "solid".)
 */
function isSafeSolidBlock(block) {
  if (!block || isAir(block) || isHazardousBlock(block)) return false;
  return hasCollision(block);
}

/**
 * Stricter surface test for actual landing: the top of the block must be a
 * full walkable cube (stone = [0,0,0,1,1,1]; a top slab = [0,0.5,0,1,1,1] fails).
 */
function isLandingSurface(block) {
  if (!isSafeSolidBlock(block)) return false;
  return block.shapes.some(s =>
    s[0] === 0 && s[1] === 0 && s[2] === 0 &&
    s[3] === 1 && s[4] === 1 && s[5] === 1
  );
}

function angleDiff(a, b) {
  let diff = (a - b) % (2 * Math.PI);
  if (diff < -Math.PI) diff += 2 * Math.PI;
  if (diff > Math.PI) diff -= 2 * Math.PI;
  return Math.abs(diff);
}

module.exports = {
  sleep,
  isAir,
  isHazardousBlock,
  hasCollision,
  isSafeSolidBlock,
  isLandingSurface,
  angleDiff,
};
