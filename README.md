<div align="center">

# ⚡ EAFE

**E**lytra **A**utonomous **F**light **E**ngine

[![npm](https://img.shields.io/npm/v/eafe?color=blue)](https://www.npmjs.com/package/eafe)
[![License](https://img.shields.io/npm/l/eafe)](LICENSE)
[![Downloads](https://img.shields.io/npm/dm/eafe)](https://www.npmjs.com/package/eafe)

*3 lines to fly anywhere in Minecraft*

</div>

---

## Install

```bash
npm install eafe mineflayer
```

## Quick Start

```js
const mineflayer = require('mineflayer');
const { ElytraFlight } = require('eafe');

const bot = mineflayer.createBot({ host: 'localhost', username: 'Bot' });

bot.once('spawn', () => {
  const flight = new ElytraFlight(bot);
  flight.fly(500, 500);
});
```

---

## Features

| Feature | Description |
|---------|-------------|
| `FAST` | 30 m/s — emergency flights |
| `MED` | 22 m/s — balanced speed/fuel |
| `LOW` | 15 m/s — fuel efficient |
| Smart Landing | Auto land at safe spots |
| Elytra Audit | Checks durability before flight |
| Auto Rocket | Equips rockets automatically |
| Terrain Avoidance | Scans and avoids obstacles |
| Owner Alerts | Whisper notifications |

---

## API

### `flight.fly(x, z, opts?)`

Fly to coordinates.

```js
flight.fly(500, 500);
flight.fly(500, 500, { mode: 'FAST', cruiseAlt: 200 });
```

### `flight.stop(reason?)`

Emergency stop.

```js
flight.stop();
```

### `flight.setMode(mode)`

Change flight mode.

```js
flight.setMode('FAST'); // FAST, MED, LOW
```

### `flight.setTarget(x, z)`

Set target without flying.

```js
flight.setTarget(100, 200);
```

### `flight.setStatus(x, z)`

Get flight status.

```js
const status = flight.setStatus(500, 500);
// { phase, mode, pos, target, dist, elytra, rockets, flying }
```

### `flight.preflight()`

Pre-flight check without flying.

```js
const check = await flight.preflight();
// { ok, elytra: { have, need }, rockets: { have, need } }
```

---

## Events

```js
flight.on('phase', (phase, msg) => {
  console.log(phase);  // TAKEOFF, CLIMB, CRUISE, LAND, IDLE
});

flight.on('stopped', (reason) => {
  console.log(reason);  // user, respawn, out of rkt
});

flight.on('error', (err) => {
  console.error(err.message);
});
```

---

## Options

```js
const flight = new ElytraFlight(bot, {
  mode: 'MED',           // FAST, MED, LOW
  cruiseAlt: 180,        // Cruise altitude (blocks)
  maxRetries: 3,         // Retry attempts
  safety: true,          // Pre-flight checks
  debug: false,          // Verbose logging
  ownerUsername: '',     // Whisper alerts to
  landingMargin: 2,      // Blocks from edge
});
```

---

## Helpers

```js
const { countRockets, getElytraSummary } = require('eafe');

const rockets = countRockets(bot);
const elytra = getElytraSummary(bot);
```

---

## Examples

| Example | Description |
|---------|-------------|
| [`basic.js`](examples/basic.js) | Simple flight |
| [`demo.js`](examples/demo.js) | Chat commands |
| [`delivery.js`](examples/delivery.js) | Multi-stop delivery |
| [`waypoint-travel.js`](examples/waypoint-travel.js) | Location loop |
| [`rescue-bot.js`](examples/rescue-bot.js) | Player rescue |
| [`multi-bot.js`](examples/multi-bot.js) | Fleet control |
| [`inventory-transfer.js`](examples/inventory-transfer.js) | Chest transfer |
| [`api-demo.js`](examples/api-demo.js) | API showcase |

---

## License

MIT

