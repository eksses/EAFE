const mineflayer = require('mineflayer');
const { ElytraFlight, Logger, MODES, isHazardousBlock } = require('eafe');

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'Bot',
});

bot.once('spawn', () => {
  // ── Disable modules you don't need ──
  const flight = new ElytraFlight(bot, {
    safety: false,       // skip pre-flight durability/rocket checks
    chunkScan: false,    // no render distance scanning
    pathfinding: false,  // no pathfinding to open spots
    wander: false,       // no ocean wander scan
    landing: false,      // no auto-landing spiral
    debug: true,
  });

  // ── Override specific functions ──

  // Custom rocket logic
  flight._ctx.smartFireRocket = () => {
    const vel = bot.entity.velocity;
    const speed = Math.hypot(vel.x, vel.y, vel.z);
    if (speed < 0.8 && bot.entity.elytraFlying) {
      try { bot.activateItem(true); } catch(_) {}
      return true;
    }
    return false;
  };

  // Custom hazard check
  flight._ctx.isHazardous = (block) => {
    if (!block) return true;
    // Only water/lava are dangerous for MY bot
    return block.name.includes('water') || block.name.includes('lava');
  };

  // Custom mode
  MODES.GOTTA_GO_FAST = {
    name: 'GOTTA GO FAST',
    pitch: 0.02,
    speedGate: 2.0,
    speedMps: 30.0,
    fuelDistDivider: 40.0,
  };

  flight.on('phase', (p) => console.log(p));

  // Use custom mode
  flight.setMode('GOTTA_GO_FAST');
  flight.fly(2000, 2000);

  // ── Import modules individually ──
  const { countRockets, getElytraSummary } = require('eafe');

  console.log('Rockets:', countRockets(bot));
  console.log('Elytra:', getElytraSummary(bot));
});
