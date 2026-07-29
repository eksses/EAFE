const mineflayer = require('mineflayer');
const { ElytraFlight } = require('eafe');

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

  flight.on('phase', (phase) => {
    if (phase === 'IDLE' && waypointMode) {
      goToNextWaypoint();
    }
  });

  flight.on('error', (err) => console.error('Error:', err.message));

  bot.on('chat', (user, msg) => {
    const args = msg.split(' ');

    // Fly to named location
    if (args[0] === 'goto' && locations[args[1]]) {
      const loc = locations[args[1]];
      flight.fly(loc.x, loc.z);
      bot.chat(`Flying to ${args[1]} (${loc.x},${loc.z})`);
    }

    // Fly to coordinates
    if (args[0] === 'fly') {
      const x = parseInt(args[1]) || 0;
      const z = parseInt(args[2]) || 0;
      flight.fly(x, z);
      bot.chat(`Flying to (${x},${z})`);
    }

    // Start waypoint mode
    if (args[0] === 'waypoints') {
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
      const s = flight.setStatus(flight._targetX, flight._targetZ);
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
    flight.fly(loc.x, loc.z);
    currentWaypoint++;
  }

  console.log('Travel bot ready');
  console.log('Commands:');
  console.log('  goto <location> - Fly to named location');
  console.log('  fly X Z - Fly to coordinates');
  console.log('  waypoints - Start waypoint loop');
  console.log('  addloc <name> - Save current position');
  console.log('  locations - List saved locations');
});
