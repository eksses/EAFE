'use strict';

const { test, assert, assertClose, suite } = require('./test-harness');
const E = require('../src/index.js');
const { MODES, PHASE, ErrorCode, ElytraFlightError } = E;
const {
  isAir, isHazardousBlock, hasCollision, isSafeSolidBlock, isLandingSurface, angleDiff,
} = E;
const {
  getUnbreakingLevel, getElytraDamageRate, calculateRequiredElytraDurability,
} = E;
const { countRockets, getRocketSummary } = E;

const { md, BlockCtor } = require('./helpers/mock-bot');
function B(name) {
  const be = md.blocksByName[name];
  if (!be) throw new Error('no block ' + name);
  return BlockCtor.fromStateId(be.minStateId, 0);
}

suite('Unit: constants & modes');

test('mode aliases resolve (LOW->EFFICIENT, MED->MEDIUM)', () => {
  assert(MODES.LOW === MODES.EFFICIENT, 'LOW alias');
  assert(MODES.MED === MODES.MEDIUM, 'MED alias');
  assert(MODES.FAST, 'FAST exists');
});

test('phase values are the documented short names', () => {
  assert(PHASE.CRUISING === 'CRUISE', 'CRUISE');
  assert(PHASE.CLIMBING === 'CLIMB', 'CLIMB');
  assert(PHASE.LANDING === 'LAND', 'LAND');
  assert(PHASE.FAILED === 'FAIL', 'FAIL');
});

test('error codes are a stable frozen set', () => {
  assert(Object.isFrozen(ErrorCode), 'frozen');
  for (const c of ['NO_ELYTRA', 'NO_ROCKETS', 'STOPPED', 'RESPAWN', 'NO_SAFE_SPOT', 'IN_FLIGHT', 'RETRIES_EXHAUSTED']) {
    assert(ErrorCode[c] === c, `code ${c}`);
  }
});

test('ElytraFlightError carries code', () => {
  const e = new ElytraFlightError(ErrorCode.NO_ROCKETS, 'need 5 rkt, have 0');
  assert(e instanceof Error, 'is Error');
  assert(e.code === 'NO_ROCKETS', 'code set');
  assert(e.message.includes('need 5'), 'message kept');
});

suite('Unit: block classification (real 1.21 data)');

test('isAir', () => {
  assert(isAir(B('air')), 'air');
  assert(isAir(null), 'null');
  assert(!isAir(B('stone')), 'stone');
});

test('isHazardousBlock: exact names only (no substring false positives)', () => {
  assert(isHazardousBlock(B('water')), 'water');
  assert(isHazardousBlock(B('lava')), 'lava');
  assert(isHazardousBlock(B('cactus')), 'cactus');
  assert(isHazardousBlock(B('powder_snow')), 'powder_snow');
  assert(isHazardousBlock(null), 'null unsafe');
  assert(!isHazardousBlock(B('stone')), 'stone');
  // The old substring match flagged water_strainer — a safe solid block.
  const ws = md.blocksByName.water_strainer;
  if (ws) assert(!isHazardousBlock(BlockCtor.fromStateId(ws.minStateId, 0)), 'water_strainer NOT hazard');
});

test('hasCollision / isSafeSolidBlock reject pass-through blocks', () => {
  assert(hasCollision(B('stone')), 'stone');
  assert(hasCollision(B('glass')), 'glass');
  assert(!hasCollision(B('poppy')), 'poppy');
  assert(!hasCollision(B('oak_sapling')), 'sapling');
  assert(!hasCollision(B('torch')), 'torch');
  assert(!hasCollision(B('tall_grass')), 'tall grass');
  assert(!hasCollision(B('water')), 'water');
  assert(isSafeSolidBlock(B('stone')), 'stone safe');
  assert(!isSafeSolidBlock(B('poppy')), 'poppy not safe');
  assert(!isSafeSolidBlock(B('torch')), 'torch not safe');
});

test('isLandingSurface requires a full-cube top', () => {
  assert(isLandingSurface(B('stone')), 'stone');
  assert(!isLandingSurface(B('poppy')), 'poppy');
  const slab = B('oak_slab'); // [0,0.5,0,1,1,1] default state = not a full cube top
  assert(!isLandingSurface(slab), 'half slab not full-cube');
});

test('angleDiff wraps correctly', () => {
  assertClose(angleDiff(0, 0), 0, 1e-9);
  assertClose(angleDiff(Math.PI, -Math.PI), 0, 1e-9, 'antipodal wrap');
  assertClose(angleDiff(Math.PI / 2, 0), Math.PI / 2, 1e-9);
});

suite('Unit: elytra math');

test('unbreaking detection across mineflayer item shapes', () => {
  assert(getUnbreakingLevel({ enchants: [{ name: 'unbreaking', lvl: 3 }] }) === 3, 'pre-1.20.5 array name');
  assert(getUnbreakingLevel({ enchants: [{ id: 'minecraft:unbreaking', lvl: 4 }] }) === 4, '1.20.5+ component id');
  assert(getUnbreakingLevel({ enchants: [{ id: 34, lvl: 2 }] }) === 2, 'numeric id');
  assert(getUnbreakingLevel({ enchants: [] }) === 0, 'none');
  assert(getUnbreakingLevel(null) === 0, 'null');
  // raw NBT shape: { value: { Enchantments: { value: { value: [{ id: 34, lvl: 3 }] } } } }
  const nbtItem = { nbt: { value: { Enchantments: { value: { value: [{ id: 34, lvl: 3 }] } } } } };
  assert(getUnbreakingLevel(nbtItem) === 3, 'raw NBT');
});

test('damage rate = 2/(n+3), monotonically decreasing, U4 handled', () => {
  assertClose(getElytraDamageRate(0), 1.0, 1e-9);
  assertClose(getElytraDamageRate(1), 0.5, 1e-9);
  assertClose(getElytraDamageRate(2), 2 / 5, 1e-9);
  assertClose(getElytraDamageRate(3), 1 / 3, 1e-9);
  assertClose(getElytraDamageRate(4), 2 / 7, 1e-9, 'U4 (old code returned 1.0!)');
  assert(getElytraDamageRate(5) < getElytraDamageRate(4), 'U5 < U4');
});

test('required durability scales with distance and unbreaking', () => {
  const base = calculateRequiredElytraDurability(1000, 13, 0);
  const u3 = calculateRequiredElytraDurability(1000, 13, 3);
  assert(u3 < base, 'U3 needs less');
  assert(base > 0, 'positive');
  assert(calculateRequiredElytraDurability(2000, 13, 0) > base, 'farther = more');
});

suite('Unit: rockets');

test('countRockets excludes custom stars by default', () => {
  const fakeBot = { inventory: { slots: new Array(46).fill(null) } };
  fakeBot.inventory.slots[0] = { name: 'firework_rocket', count: 5 };
  fakeBot.inventory.slots[1] = {
    name: 'firework_rocket', count: 3,
    nbt: { value: { Fireworks: { value: { Explosions: [{}] } } } },
  };
  assert(countRockets(fakeBot) === 5, 'plain only');
  assert(countRockets(fakeBot, { includeCustom: true }) === 8, 'with custom');
  const s = getRocketSummary(fakeBot);
  assert(s.plain === 5 && s.custom === 3 && s.total === 8, 'summary');
});

test('calculateRequiredRockets shape (real ctx)', () => {
  const { MockBot } = require('./helpers/mock-bot');
  const bot = new MockBot();
  const flight = new E(bot);
  const calc = flight._ctx.calculateRequiredRockets;
  assert(calc(0, 0) === 12 + flight.opts.maxRetries * 3, 'baseline margin 12 + 3*retries');
  assert(calc(200, 0) > calc(60, 0), 'distance adds');
  assert(calc(0, 100) > calc(0, 0), 'climb adds');
  assert(calc(0, -100) === calc(0, 100), 'descend symmetric');
});
