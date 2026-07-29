'use strict';

const { HAZARD_SURFACES } = require('./constants');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function isAir(block) {
  if (!block) return true;
  return block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
}

function isHazardousBlock(block) {
  if (!block) return true;
  if (HAZARD_SURFACES.has(block.name)) return true;
  return block.name.includes('water') || block.name.includes('lava') || block.name.includes('magma');
}

function isSafeSolidBlock(block) {
  if (!block || isAir(block) || isHazardousBlock(block)) return false;
  return true;
}

function angleDiff(a, b) {
  let diff = (a - b) % (2 * Math.PI);
  if (diff < -Math.PI) diff += 2 * Math.PI;
  if (diff > Math.PI) diff -= 2 * Math.PI;
  return Math.abs(diff);
}

module.exports = { sleep, isAir, isHazardousBlock, isSafeSolidBlock, angleDiff };
