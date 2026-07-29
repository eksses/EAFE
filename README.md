<div align="center">

# ⚡ @eksses/eafe

**E**lytra **A**utonomous **F**light **E**ngine

[![npm](https://img.shields.io/npm/v/@eksses/eafe?color=blue)](https://www.npmjs.com/package/@eksses/eafe)
[![License](https://img.shields.io/npm/l/@eksses/eafe)](LICENSE)
[![Downloads](https://img.shields.io/npm/dm/@eksses/eafe)](https://www.npmjs.com/package/@eksses/eafe)
[![Node](https://img.shields.io/node/v/@eksses/eafe)](package.json)

*Autonomous elytra flight for Minecraft — takeoff, climb, cruise, land. Zero config.*

</div>

---

## Install

```bash
npm install @eksses/eafe mineflayer
```

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

---

## Features

| Feature | Description |
|:--------|:------------|
| **3 Flight Modes** | `FAST` (30 m/s), `MED` (22 m/s), `LOW` (15 m/s) |
| **Smart Landing** | Auto land at safe spots with margin check |
| **Elytra Audit** | Checks durability before flight |
| **Auto Rocket** | Equips rockets automatically |
| **Terrain Avoidance** | Scans and avoids obstacles |
| **Owner Alerts** | Whisper notifications |
| **Wander Scan** | Searches for safe spots over any terrain |
| **Retry System** | Auto retry on failure |

---

## API

### `new ElytraFlight(bot, options?)`

Create a flight instance.

```js
const flight = new ElytraFlight(bot, {
  mode: 'MED',           // 'FAST' | 'MED' | 'LOW'
  cruiseAlt: 180,        // Cruise altitude (Y blocks)
  maxRetries: 3,         // Retry attempts on failure
  safety: true,          // Pre-flight checks enabled
  debug: false,          // Verbose logging (false for production)
  ownerUsername: '',     // Whisper alerts to this player
  landingMargin: 2,      // Blocks from edge of landing spot
  targetX: 0,            // Default target X
  targetZ: 0,            // Default target Z
});
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

Change flight mode.

```js
flight.setMode('FAST');  // FAST, MED, LOW
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
// {
//   phase: 'CRUISE',
//   mode: 'MED',
//   pos: { x: 100, y: 180, z: 200 },
//   target: { x: 500, z: 500 },
//   dist: 350,
//   elytra: { dur: 400, count: 2, unbreaking: 3 },
//   rockets: 20,
//   flying: true
// }
```

### `flight.preflight()`

Pre-flight check without flying.

```js
const check = await flight.preflight();
// {
//   ok: true,
//   elytra: { have: 432, need: 50 },
//   rockets: { have: 20, need: 8 }
// }
```

### `flight.isFlying`

Boolean — `true` if elytra is active.

### `flight.phase`

Current phase: `IDLE`, `AUDIT`, `TAKEOFF`, `CLIMB`, `CRUISE`, `LAND`, `WANDER`, `FAILED`.

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

## Flight Modes

| Mode | Speed | Fuel Use | Use Case |
|:-----|:------|:---------|:---------|
| `FAST` | 30 m/s | High | Emergency, short distance |
| `MED` | 22 m/s | Medium | Default, balanced |
| `LOW` | 15 m/s | Low | Long distance, fuel efficient |

---

## Flight Phases

```
AUDIT → TAKEOFF → CLIMB → CRUISE → LAND → IDLE
                         ↘ WANDER (no spot found)
                         ↘ FAILED (error)
```

1. **AUDIT** — Check elytra durability and rockets
2. **TAKEOFF** — Jump and activate elytra
3. **CLIMB** — Ascend to cruise altitude
4. **CRUISE** — Fly toward target
5. **LAND** — Spiral descent to safe spot
6. **WANDER** — Search for safe landing spot
7. **IDLE** — Landed or stopped
8. **FAILED** — Error occurred

---

## Helpers

```js
const { countRockets, getElytraSummary } = require('@eksses/eafe');

const rockets = countRockets(bot);        // Number
const elytra = getElytraSummary(bot);     // { totalDurabilityAcrossAll, count, bestUnbreaking }
```

---

## Examples

| Example | Description |
|:--------|:------------|
| [`basic.js`](examples/basic.js) | Simple flight |
| [`demo.js`](examples/demo.js) | Chat commands |
| [`delivery.js`](examples/delivery.js) | Multi-stop delivery |
| [`waypoint-travel.js`](examples/waypoint-travel.js) | Location loop |
| [`rescue-bot.js`](examples/rescue-bot.js) | Player rescue |
| [`multi-bot.js`](examples/multi-bot.js) | Fleet control |
| [`inventory-transfer.js`](examples/inventory-transfer.js) | Chest transfer |
| [`api-demo.js`](examples/api-demo.js) | API showcase |

---

## Requirements

- **Node.js** ≥ 16.0.0
- **mineflayer** ≥ 4.0.0
- Bot must have **elytra** equipped in chest slot
- Bot must have **firework rockets** in inventory

---

## License

MIT

