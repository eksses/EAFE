# EAFE

**Autonomous elytra flight for mineflayer.** 3 lines to fly anywhere in Minecraft.

```bash
npm install eafe
```

```js
const { ElytraFlight } = require('eafe');
const flight = new ElytraFlight(bot);
flight.fly(500, -1200);
```

That's it. Bot takes off, climbs, navigates, avoids terrain, manages rockets, and lands.

---

## Install

```bash
npm install eafe mineflayer
```

`mineflayer` is a peer dependency — you already have it. `eafe` auto-installs `mineflayer-pathfinder` and `vec3`.

---

## Quick Start

```js
const mineflayer = require('mineflayer');
const { ElytraFlight } = require('eafe');

const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'Bot' });

bot.once('spawn', () => {
  const flight = new ElytraFlight(bot);

  flight.on('phase', (p) => console.log(p));
  flight.on('error', (e) => console.error(e.message));

  flight.fly(500, -1200);
});
```

---

## Flight Modes

| Mode | Speed | Fuel | Use |
|------|-------|------|-----|
| `FAST` | 22 m/s | ~50m/rocket | Emergency, short hops |
| `MED` | 13 m/s | ~120m/rocket | Balanced (default) |
| `LOW` | 10 m/s | ~180m/rocket | Long range, save fuel |

```js
flight.fly(500, -1200, { mode: 'FAST' });
// or
flight.setMode('LOW').fly(500, -1200);
```

---

## Options

Every option has a default. Only set what you need.

```js
const flight = new ElytraFlight(bot, {
  mode: 'MED',          // FAST, MED, LOW
  cruiseAlt: 180,       // cruise altitude
  maxRetries: 3,        // retry attempts
  debug: false,         // verbose logging
  safety: true,         // pre-flight checks
  ownerUsername: '',     // whisper alerts to player
});
```

---

## Turn Off What You Don't Need

Don't want safety checks? Disable them. Don't want ocean scanning? Disable it. Every module is optional.

```js
const flight = new ElytraFlight(bot, {
  safety: false,      // skip elytra/rocket pre-flight checks
  chunkScan: false,   // skip render distance scanning
  pathfinding: false, // skip pathfinding to open spots
  wander: false,      // skip ocean wander scan
  landing: false,     // skip auto-landing spiral
  autoRocket: false,  // skip auto rocket firing
});
```

---

## Override Anything

Swap any internal function with your own:

```js
const flight = new ElytraFlight(bot);

// Custom rocket logic
flight._ctx.smartFireRocket = () => {
  if (bot.entity.elytraFlying && Math.hypot(...Object.values(bot.entity.velocity)) < 0.8) {
    bot.activateItem(true);
    return true;
  }
  return false;
};

// Custom hazard check
flight._ctx.isHazardous = (block) => {
  return block?.name?.includes('lava');
};

// Custom landing
flight._ctx.startLanding = () => {
  // your landing logic
};
```

---

## Events

```js
flight.on('phase', (phase, msg) => {});  // phase changed
flight.on('stopped', (reason) => {});     // emergency stop
flight.on('error', (err) => {});          // flight failed
```

---

## API

### `new ElytraFlight(bot, options?)`
Create flight instance. `bot` is a mineflayer bot.

### `flight.fly(x, z, options?)`
Start flying to coordinates. Returns `this` for chaining.

### `flight.stop(reason?)`
Emergency stop. Lands immediately.

### `flight.setTarget(x, z)`
Set target without flying.

### `flight.setMode(mode)`
Set flight mode: `'FAST'`, `'MED'`, `'LOW'`.

### `flight.setStatus(x, z)`
Get current status object.

### `flight.preflight()`
Run pre-flight checks without flying. Returns `{ ok, elytra, rockets }`.

### `flight.phase`
Current phase string.

### `flight.isFlying`
Boolean — is the bot currently in elytra flight?

---

## Import Modules Individually

Use only what you need:

```js
const { countRockets, getElytraSummary, isSafeSolidBlock, Logger } = require('eafe');
```

Available exports:
- `ElytraFlight` — main class
- `MODES`, `PHASE` — constants
- `Logger` — debug logger
- `countRockets`, `findRocket`, `autoEquipRocket` — inventory
- `getElytraSummary`, `auditAndEquipElytra`, `calculateRequiredElytraDurability` — elytra
- `isAir`, `isHazardousBlock`, `isSafeSolidBlock`, `angleDiff`, `sleep` — utils

---

## Sub-Path Imports

```js
const Logger = require('eafe/logger');
const { MODES } = require('eafe/constants');
const { countRockets } = require('eafe/inventory');
```

---

## Examples

```
examples/
├── basic.js         — 10 lines, fly somewhere
├── advanced.js      — options, events, status loop
├── custom.js        — override modules, custom modes
└── preflight.js     — check resources without flying
```

---

## License

MIT
