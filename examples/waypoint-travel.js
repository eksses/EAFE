const mineflayer = require('mineflayer');
const { ElytraFlight } = require('@eksses/eafe');

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'TravelBot',
});

// Predefined locations
const locations = {
  base: { x: 0, z: 0 },
  farm: { x: 500, z: 200 },
  mine: { x: -300, z: 800 },
  nether: { x: 100, z: -500 },
};

let currentWaypoint = 0;
let waypointMode = false;

bot.once('spawn', () => {
  const flight = new ElytraFlight(bot, {
    mode: 'FAST',
    cruiseAlt: 200,
    debug: true,
  });

  flight.on('phase', (phase, msg) => {
    if (msg) console.log(`[${phase}] ${msg}`);
  });

  bot.on('chat', (user, msg) => {
    const args = msg.split(' ');

    // Fly to named location
    if (args[0] === 'goto' && locations[args[1]]) {
      const loc = locations[args[1]];
      flight.fly(loc.x, loc.z)
        .then(() => bot.chat(`Landed at ${args[1]}`))
        .catch((err) => {
          if (err.code !== 'STOPPED') bot.chat(`Flight failed: ${err.code}`);
        });
      bot.chat(`Flying to ${args[1]} (${loc.x},${loc.z})`);
    }

    // Fly to coordinates
    if (args[0] === 'fly') {
      const x = parseInt(args[1]) || 0;
      const z = parseInt(args[2]) || 0;
      flight.fly(x, z)
        .then(() => bot.chat(`Landed at (${x},${z})`))
        .catch((err) => {
          if (err.code !== 'STOPPED') bot.chat(`Flight failed: ${err.code}`);
        });
      bot.chat(`Flying to (${x},${z})`);
    }

    // Start waypoint mode
    if (args[0] === 'waypoints') {
      if (waypointMode) { bot.chat('Waypoint loop already running — use stop'); return; }
      waypointMode = true;
      currentWaypoint = 0;
      goToNextWaypoint();
    }

    // Stop waypoint mode
    if (args[0] === 'stop') {
      waypointMode = false;
      flight.stop();
      bot.chat('Stopped');
    }

    // Add location
    if (args[0] === 'addloc' && args[1]) {
      const pos = bot.entity.position;
      locations[args[1]] = { x: Math.round(pos.x), z: Math.round(pos.z) };
      bot.chat(`Added ${args[1]} at (${Math.round(pos.x)},${Math.round(pos.z)})`);
    }

    // List locations
    if (args[0] === 'locations') {
      Object.entries(locations).forEach(([name, loc]) => {
        bot.chat(`${name}: (${loc.x},${loc.z})`);
      });
    }

    // Status
    if (args[0] === 'status') {
      const s = flight.setStatus(flight.targetX, flight.targetZ);
      bot.chat(`${s.phase} | ${s.pos.x},${s.pos.y},${s.pos.z} | ${s.dist}m | rkt=${s.rockets}`);
    }
  });

  function goToNextWaypoint() {
    const names = Object.keys(locations);
    if (currentWaypoint >= names.length) {
      bot.chat('Waypoint loop complete');
      waypointMode = false;
      return;
    }

    const name = names[currentWaypoint];
    const loc = locations[name];
    bot.chat(`${currentWaypoint + 1}/${names.length}: ${name} (${loc.x},${loc.z})`);
    currentWaypoint++;

    // Chain the loop through the fly() promise (resolves on landing)
    flight.fly(loc.x, loc.z)
      .then(() => goToNextWaypoint())
      .catch((err) => {
        waypointMode = false;
        if (err.code === 'STOPPED') { bot.chat('Waypoints cancelled'); return; }
        bot.chat(`Waypoint loop failed: ${err.code}`);
      });
  }

  console.log('Travel bot ready');
  console.log('Commands:');
  console.log('  goto <location> - Fly to named location');
  console.log('  fly X Z - Fly to coordinates');
  console.log('  waypoints - Start waypoint loop');
  console.log('  addloc <name> - Save current position');
  console.log('  locations - List saved locations');
});
