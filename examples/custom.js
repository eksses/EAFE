const mineflayer = require('mineflayer');
const { ElytraFlight, MODES, countRockets, getElytraSummary } = require('@eksses/eafe');

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'Bot',
});

bot.once('spawn', () => {
  // ── Disable modules you don't need, plug in your own rules ──
  const flight = new ElytraFlight(bot, {
    safety: false,       // skip pre-flight durability/rocket checks
    chunkScan: false,    // no render distance scanning
    pathfinding: false,  // no pathfinding to open spots
    wander: false,       // no ocean wander scan
    landing: false,      // no landing-spot search (dive straight at target)
    autoRocket: false,   // you manage rockets yourself (bot.activateItem)
    // Real hazard override: EAFE calls this for every block it considers
    // (landing spots, terrain scans, ground safety). Default is the built-in
    // hazard list — see src/constants.js HAZARD_SURFACES.
    hazardCheck: (block) => {
      if (!block) return false;
      // Only water/lava are dangerous for THIS bot:
      return block.name.includes('water') || block.name.includes('lava');
    },
    debug: true,
  });

  // ── Custom mode ──
  MODES.GOTTA_GO_FAST = {
    name: 'GOTTA_GO_FAST',
    pitch: 0.02,
    speedGate: 2.0,
    speedMps: 30.0,
    fuelDistDivider: 40.0,
  };

  flight.on('phase', (p, msg) => console.log('Phase:', p, msg || ''));
  flight.on('stopped', (reason) => console.log('Stopped:', reason));

  flight.setMode('GOTTA_GO_FAST');
  flight.fly(2000, 2000)
    .then((res) => console.log('Landed at', res.landedAt))
    .catch((err) => {
      if (err.code === 'STOPPED') return; // expected when the user stops
      console.error('Flight failed:', err.code, err.message);
    });

  console.log('Rockets:', countRockets(bot));
  console.log('Elytra:', getElytraSummary(bot));
});
