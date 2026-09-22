'use strict';

/**
 * Integration tests — EAFE against a mock mineflayer bot with a real 1.21
 * prismarine world and simplified elytra physics. Runs in real time
 * (EAFE loops use real timers); total budget ~2 minutes.
 */
const { test, assert, assertClose, suite } = require('./test-harness');
const E = require('../src/index.js');
const ElytraFlight = E.ElytraFlight;
const { PHASE, ErrorCode } = E;
const { MockBot, GROUND } = require('./helpers/mock-bot');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function phasesSeen(flight) {
  const seen = [];
  flight.on('phase', p => { if (!seen.includes(p)) seen.push(p); });
  return seen;
}

/**
 * Run physics until the fly() promise settles. IMPORTANT: the condition is
 * `_pending === null`, NOT "phase === FAILED" — the phase goes FAILED on
 * every failed attempt, but EAFE then schedules a retry and keeps the SAME
 * pending promise alive. Stopping the mock's physics at the first FAILED
 * starves the retry: the bot sits frozen on the ground, the retry's
 * airborne poll never sees the jump, and every retry fails with
 * "jump fail" no matter what the real cause was.
 */
async function runFlightUntilSettled(bot, flight, timeoutMs = 90000) {
  return bot.stepUntil(() => flight._pending === null, timeoutMs);
}

suite('Integration: full flight');

test('flies 300 m, lands near target (approach/trigger regression)', async () => {
  const bot = new MockBot({ startX: 0, startZ: 0, rockets: 40 });
  const flight = new ElytraFlight(bot, { debug: false, cruiseAlt: 130 });
  const seen = phasesSeen(flight);
  let resolved = null;
  let rejected = null;

  flight.fly(300, 0).then(r => { resolved = r; }, e => { rejected = e; });
  const done = await runFlightUntilSettled(bot, flight, 90000);

  assert(done, `settled within 90s (phase=${flight.phase})`);
  assert(flight.phase === PHASE.IDLE, `landed, got phase=${flight.phase}`);
  assert(!rejected, `no rejection (got ${rejected && rejected.message})`);
  assert(resolved, 'fly() promise resolved');
  assert(resolved.landedAt, 'resolved with landedAt');
  assertClose(resolved.landedAt.x, 300, 40, 'landed near target X');
  assertClose(resolved.landedAt.z, 0, 40, 'landed near target Z');
  assertClose(resolved.landedAt.y, GROUND + 1, 3, 'landed on ground');

  for (const ph of [PHASE.AUDIT, PHASE.TAKEOFF, PHASE.CLIMBING, PHASE.CRUISING, PHASE.LANDING]) {
    assert(seen.includes(ph), `saw phase ${ph} (saw: ${seen.join(',')})`);
  }
  assert(bot.eafeBlockAtCalls < 500000, `perf guard: ${bot.eafeBlockAtCalls} blockAt calls < 500k`);
});

test('fly() rejects IN_FLIGHT during climb; retarget works during cruise', async () => {
  const bot = new MockBot({ startX: 0, startZ: 0, rockets: 60 });
  const flight = new ElytraFlight(bot, { cruiseAlt: 130 });
  const raw = flight.fly(400, 0);
  const p1 = raw.catch(e => e);

  // wait until climbing
  await bot.stepUntil(() => flight.phase === PHASE.CLIMBING, 30000);
  const r = await flight.fly(500, 0).catch(e => e);
  assert(r instanceof Error, 'second fly() rejected while climbing');
  assert(r.code === ErrorCode.IN_FLIGHT, `code IN_FLIGHT, got ${r.code && r.code}`);
  assert(flight._targetX === 400, 'rejected fly() must not retarget the active flight');

  // retarget mid-cruise returns the SAME pending promise
  const arrived = await bot.stepUntil(() => flight.phase === PHASE.CRUISING, 45000);
  assert(arrived, 'reached cruise');
  const p2 = flight.fly(300, 0);
  assert(p2 === raw, 'retarget returns existing promise');

  const settled = await runFlightUntilSettled(bot, flight, 90000);
  assert(settled && flight.phase === PHASE.IDLE, `settled (phase=${flight.phase})`);
  const res = await p1;
  assertClose(res.landedAt.x, 300, 40, 'landed at retargeted X');
});

suite('Integration: stop / retry / errors');

test('stop() emits stopped exactly once, phase IDLE, rejects with STOPPED', async () => {
  const bot = new MockBot({ startX: 0, startZ: 0, rockets: 60 });
  const flight = new ElytraFlight(bot, { cruiseAlt: 130 });
  let stoppedCount = 0;
  flight.on('stopped', () => stoppedCount++);
  let idleEmitted = false;
  flight.on('phase', p => { if (p === PHASE.IDLE) idleEmitted = true; });

  const p = flight.fly(400, 0).catch(e => e);
  await bot.stepUntil(() => flight.phase === PHASE.CLIMBING, 30000);
  flight.stop('test');

  const err = await p;
  assert(err.code === ErrorCode.STOPPED, `code STOPPED, got ${err && err.code}`);
  assert(stoppedCount === 1, `exactly one 'stopped' event (got ${stoppedCount})`);
  assert(idleEmitted, "phase IDLE emitted on stop (consumers must not hang)");
  assert(flight.phase === PHASE.IDLE, 'phase is IDLE');
});

test('stop during pending retry cancels the retry (no re-takeoff)', async () => {
  const bot = new MockBot({ startX: 0, startZ: 0, rockets: 40 });
  // Sabotage the jump so takeoff fails -> GROUND_HIT -> retry in 3s
  const origStep = bot.step.bind(bot);
  bot.step = (dt) => { bot.jump = false; origStep(dt); };

  const flight = new ElytraFlight(bot, { cruiseAlt: 130, maxRetries: 3 });
  const seen = phasesSeen(flight);
  const p = flight.fly(300, 0).catch(e => e);

  // Wait for the first failure + scheduled retry
  const failedOnce = await bot.stepUntil(() => flight.phase === PHASE.FAILED, 30000);
  assert(failedOnce, 'first attempt failed (jump sabotaged)');
  assert(seen.includes(PHASE.TAKEOFF), 'was in takeoff');

  await sleep(500); // retry is pending (fires in ~3s)
  flight.stop('cancel');

  // The old bug: retry fired after stop and re-took-off
  await sleep(4500);
  assert(flight.phase === PHASE.IDLE, `still IDLE after retry window (phase=${flight.phase})`);
  const takeoffsAfterStop = bot.chatLog.length; // sanity only
  const err = await p;
  assert(err.code === ErrorCode.STOPPED, `promise rejected STOPPED, got ${err.code}`);
  void takeoffsAfterStop;
});

test('fly() before spawn rejects NO_ENTITY without crashing', async () => {
  const bot = new MockBot();
  bot.entity = null;
  const flight = new ElytraFlight(bot);
  const err = await flight.fly(100, 100).catch(e => e);
  assert(err.code === ErrorCode.NO_ENTITY, `code NO_ENTITY, got ${err && err.code}`);
});

test('retries then rejects with typed RETRIES_EXHAUSTED', async () => {
  // 40 rockets so the audit PASSES and the sabotaged jump (a transient
  // in-flight failure, NO_FLIGHT_CONFIRM) is what actually gets retried.
  // A deterministic precondition failure (e.g. NO_ROCKETS) would fail fast
  // with its own code instead.
  const bot = new MockBot({ startX: 0, startZ: 0, rockets: 40 });
  const origStep = bot.step.bind(bot);
  bot.step = (dt) => { bot.jump = false; origStep(dt); };

  const flight = new ElytraFlight(bot, { cruiseAlt: 130, maxRetries: 1 });
  const p = flight.fly(300, 0).catch(e => e);
  const err = await p; // 1 retry (3s) then exhausted
  assert(err.code === ErrorCode.RETRIES_EXHAUSTED, `code RETRIES_EXHAUSTED, got ${err.code}`);
  assert(err instanceof E.ElytraFlightError, 'typed error class');
  assert(err.cause === ErrorCode.NO_FLIGHT_CONFIRM, `cause is the last failure code, got ${err.cause}`);
  assert(flight.phase === PHASE.FAILED, 'phase FAILED');
});

suite('Integration: inventory & elytra handling');

test('mode LOW / MED aliases resolve through constructor and fly()', () => {
  const bot = new MockBot();
  const f1 = new ElytraFlight(bot, { mode: 'LOW' });
  assert(f1.mode.name === 'LOW' && f1.mode.speedMps === 10, 'constructor LOW');
  const f2 = new ElytraFlight(bot, { mode: 'MED' });
  assert(f2.mode.name === 'MED' && f2.mode.speedMps === 13, 'constructor MED');
  f2.setMode('LOW');
  assert(f2.mode.name === 'LOW', 'setMode LOW');
  f2.setMode('GOTTA_GO_FAST');
  assert(f2.mode.name === 'LOW', 'unknown mode keeps current (no silent reset)');
});

test('preflight() is pure and returns a consistent shape', async () => {
  const bot = new MockBot({ rockets: 50 });
  const flight = new ElytraFlight(bot);
  const chestBefore = bot.inventory.slots[6];
  flight.setTarget(200, 0);
  const check = await flight.preflight();
  assert(typeof check.ok === 'boolean', 'ok boolean');
  assert(check.elytra && typeof check.elytra.have === 'number', 'elytra shape');
  assert(check.rockets && typeof check.rockets.need === 'number', 'rockets shape');
  assert(bot.inventory.slots[6] === chestBefore, 'no equip side effect');
  assert(check.ok === true, `expected ok with plenty of gear (got reason=${check.reason})`);
});

test('preflight() reports unbreaking correctly (U3 detected)', async () => {
  const bot = new MockBot({ unbreaking: 3 });
  const flight = new ElytraFlight(bot);
  const check = await flight.preflight();
  assert(check.elytra.unbreaking === 3, `U3 detected (got ${check.elytra.unbreaking})`);
});

test('worn elytra is swapped from spare inventory', async () => {
  const bot = new MockBot({ elytraDur: 5, unbreaking: 0 });
  const spare = { name: 'elytra', count: 1, maxDurability: 432, durabilityUsed: 0, enchants: [] };
  bot.inventory.slots[0] = spare; // no rockets in slot 0 for this test
  const flight = new ElytraFlight(bot);
  const ok = await flight._ctx.auditAndEquipElytra({ equip: true });
  assert(ok === true, 'swap succeeded');
  assert(bot.inventory.slots[6] === spare, 'fresh elytra equipped');
  assert(bot.inventory.slots[0] !== null || bot.inventory.slots[0].name === 'elytra', 'worn elytra back in bag');
});

test('flowers are skipped by landing spot search (solid detection)', async () => {
  const bot = new MockBot({ startX: 0, startZ: 0, features: [
    { x: 10, y: GROUND + 1, z: 0, name: 'poppy' }, // flower on top of the target column
  ] });
  const flight = new ElytraFlight(bot);
  const spot = flight._ctx.wander.findSafeLandingSpotAround(10, 0);
  assert(spot.safe, 'spot safe');
  assert(spot.blockName === 'stone', `ground is stone not poppy (got ${spot.blockName})`);
  assert(spot.y === GROUND + 1, `ground height (got ${spot.y})`);
});

test('landing on a cactus recovers instead of looping forever', async () => {
  // cactus directly under the target column. The old bug: a cactus
  // touchdown reset the search timer and looped forever standing on it.
  // The bot must end safely: spot search avoids the hazard column, or a
  // cactus touchdown relocates — either way it reaches IDLE (or a clean,
  // finite failure) and is NOT sitting on the cactus.
  const bot = new MockBot({ startX: 0, startZ: 0, rockets: 40, features: [
    { x: 60, y: GROUND + 1, z: 0, name: 'cactus' },
  ] });
  const flight = new ElytraFlight(bot, { cruiseAlt: 130, wanderTimeoutMs: 3000, maxRetries: 3 });
  let resolved = null, rejected = null;
  const pp = flight.fly(60, 0).then(r => { resolved = r; }, e => { rejected = e; });
  const settled = await runFlightUntilSettled(bot, flight, 120000);
  assert(settled, 'settled (did not loop forever)');
  await pp; // let the fly() promise's settle handlers run
  assert(flight.phase === PHASE.IDLE, `recovered to IDLE (phase=${flight.phase})`);
  assert(!rejected, `no error (got ${rejected && rejected.code})`);
  assert(resolved && resolved.landedAt, 'fly() resolved with landedAt');
  const ex = Math.round(bot.entity.position.x);
  assert(!(ex === 60 && Math.abs(bot.entity.position.z) < 1 && bot.entity.position.y <= GROUND + 2),
    'not sitting on the cactus');
});

suite('Integration: fuel & fuel-out');

test('out of rockets enters DEADSTICK and still lands', async () => {
  const bot = new MockBot({ startX: 0, startZ: 0, rockets: 1 });
  const flight = new ElytraFlight(bot, { cruiseAlt: 130, safety: false });
  const seen = phasesSeen(flight);
  const p = flight.fly(300, 0).catch(e => e);
  const done = await runFlightUntilSettled(bot, flight, 120000);
  assert(done, `settled (phase=${flight.phase})`);
  assert(seen.includes(PHASE.DEAD_STICK), `entered DEADSTICK (saw: ${seen.join(',')})`);
  const r = await p;
  assert(flight.phase === PHASE.IDLE, `landed (phase=${flight.phase})`);
  assertClose(r.landedAt.x, 300, 80, 'landed reasonably near target');
});
