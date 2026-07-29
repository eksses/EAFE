# AGENTS.md — AI Agent Guide for @eksses/eafe

## Package Overview

`@eksses/eafe` is a mineflayer plugin for autonomous elytra flight in Minecraft. It handles takeoff, climb, cruise, terrain avoidance, and safe landing automatically.

## Quick Start

```js
const mineflayer = require('mineflayer');
const { ElytraFlight } = require('@eksses/eafe');

const bot = mineflayer.createBot({ host: 'localhost', username: 'Bot' });
bot.once('spawn', () => {
  const flight = new ElytraFlight(bot);
  flight.fly(500, 500);
});
```

## Architecture

```
src/
├── index.js          # ElytraFlight class (main API)
├── config.js         # Server config (host, port, debug)
├── constants.js      # MODES, PHASE, HAZARD_SURFACES
├── logger.js         # Logger with [E] prefix
├── utils.js          # sleep, isAir, isSafeSolidBlock, angleDiff
├── commands.js       # Chat command processor
├── core/
│   ├── chat.js       # safeChat, ownerTell, setPhase
│   ├── inventory.js  # countRockets, findRocket, autoEquipRocket
│   ├── elytra.js     # getElytraSummary, auditAndEquipElytra
│   └── rockets.js    # fireRocketDirect, smartFireRocket
└── flight/
    ├── spatial.js    # getGroundBlockAt, scanFullRenderDistance
    ├── phases.js     # startFlight, startClimb, startCruise
    ├── wander.js     # findSafeLandingSpotAround, startWanderScan
    └── landing.js    # startLanding (spiral descent)
```

## Core API

### `new ElytraFlight(bot, options?)`

Creates flight instance.

**Options:**
```js
{
  mode: 'MED',           // 'FAST' | 'MED' | 'LOW'
  cruiseAlt: 180,        // Cruise altitude (Y)
  maxRetries: 3,         // Retry on failure
  safety: true,          // Pre-flight checks
  debug: false,          // Verbose logging
  ownerUsername: '',     // Whisper alerts to
  landingMargin: 2,      // Blocks from edge
  targetX: 0,            // Default target
  targetZ: 0,            // Default target
}
```

### `flight.fly(x, z, opts?)`

Fly to coordinates. Options override constructor options.

```js
flight.fly(500, 500);
flight.fly(500, 500, { mode: 'FAST', cruiseAlt: 200 });
```

### `flight.stop(reason?)`

Emergency stop. Lands bot immediately.

```js
flight.stop();
flight.stop('out of rockets');
```

### `flight.setMode(mode)`

Change flight mode: `'FAST'`, `'MED'`, `'LOW'`.

### `flight.setTarget(x, z)`

Set target without flying.

### `flight.setStatus(x, z)`

Returns status object:
```js
{
  phase: 'CRUISE',
  mode: 'MED',
  pos: { x: 100, y: 180, z: 200 },
  target: { x: 500, z: 500 },
  dist: 350,
  elytra: { dur: 400, count: 2, unbreaking: 3 },
  rockets: 20,
  flying: true
}
```

### `flight.preflight()`

Pre-flight check without flying:
```js
const check = await flight.preflight();
// { ok: true, elytra: { have: 432, need: 50 }, rockets: { have: 20, need: 8 } }
```

### `flight.isFlying`

Boolean — true if elytra is active.

### `flight.phase`

Current phase: `IDLE`, `AUDIT`, `TAKEOFF`, `CLIMB`, `CRUISE`, `LAND`, `WANDER`, `FAILED`.

## Events

```js
flight.on('phase', (phase, msg) => {});
flight.on('stopped', (reason) => {});
flight.on('error', (err) => {});
```

## Flight Modes

| Mode | Speed | Fuel Use | Use Case |
|------|-------|----------|----------|
| `FAST` | 30 m/s | High | Emergency |
| `MED` | 22 m/s | Medium | Default |
| `LOW` | 15 m/s | Low | Long distance |

## Flight Phases

1. **AUDIT** — Check elytra durability and rockets
2. **TAKEOFF** — Jump and activate elytra
3. **CLIMB** — Ascend to cruise altitude
4. **CRUISE** — Fly toward target
5. **LAND** — Spiral descent to safe spot
6. **WANDER** — Search for safe landing spot
7. **IDLE** — Landed or stopped
8. **FAILED** — Error occurred

## Helper Functions

```js
const { countRockets, getElytraSummary } = require('@eksses/eafe');

const rockets = countRockets(bot);        // Number
const elytra = getElytraSummary(bot);     // { totalDurabilityAcrossAll, count, bestUnbreaking }
```

## Common Patterns

### Multi-stop delivery
```js
const stops = [[100, 200], [300, 400], [500, 600]];
for (const [x, z] of stops) {
  await new Promise(resolve => {
    flight.fly(x, z);
    flight.once('phase', (p) => { if (p === 'IDLE') resolve(); });
  });
  // drop items here
}
```

### Waypoint loop
```js
const waypoints = { base: [0, 0], farm: [500, 200] };
let current = 'base';
flight.fly(...waypoints[current]);
flight.on('phase', (p) => {
  if (p === 'IDLE') {
    current = current === 'base' ? 'farm' : 'base';
    flight.fly(...waypoints[current]);
  }
});
```

### Status monitoring
```js
setInterval(() => {
  if (flight.isFlying) {
    const s = flight.setStatus(targetX, targetZ);
    console.log(`${s.phase} dist=${s.dist}m rkt=${s.rockets}`);
  }
}, 5000);
```

## Error Handling

```js
flight.on('error', (err) => {
  if (err.message.includes('no elytra')) {
    // equip elytra
  }
  if (err.message.includes('out of rkt')) {
    // restock rockets
  }
});
```

## Dependencies

- **mineflayer** `>=4.0.0` — Minecraft bot framework (peer dependency)
- **mineflayer-pathfinder** `^2.4.5` — Pathfinding for relocation
- **vec3** `^0.2.0` — 3D vector math (dev dependency)

## Notes

- Bot must have elytra equipped in chest slot
- Bot must have firework rockets in inventory
- Landing spots require 2 air blocks above + 1 block margin
- Rockets only used for survival (stall prevention, altitude maintenance)
- No rockets during landing or wander scan phases
