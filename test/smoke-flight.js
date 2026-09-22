'use strict';
// quick smoke: full 300m flight
const { ElytraFlight, PHASE } = require('../src/index.js');
const { MockBot } = require('./helpers/mock-bot');

(async () => {
  const bot = new MockBot({ startX: 0, startZ: 0, rockets: 40 });
  const flight = new ElytraFlight(bot, { debug: false, cruiseAlt: 130 });
  const seen = [];
  flight.on('phase', (p, m) => { if (!seen.includes(p)) seen.push(p); console.log(`  phase ${p} ${m || ''}`); });

  const p = flight.fly(300, 0);
  const t0 = Date.now();
  await bot.stepUntil(() => flight.phase === PHASE.IDLE || flight.phase === PHASE.FAILED, 90000);
  try {
    const res = await p;
    console.log(`LANDED in ${((Date.now() - t0) / 1000).toFixed(1)}s at`, res.landedAt, `target (300,0) err=${Math.hypot(res.landedAt.x - 300, res.landedAt.z).toFixed(1)}m`);
    console.log('blockAt calls:', bot.eafeBlockAtCalls);
  } catch (e) {
    console.log('FAILED:', e.code, e.message, `phase=${flight.phase} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log('pos:', bot.entity.position, 'phases:', seen.join(','));
  }
  process.exit(0);
})();
