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

  // fly() returns a promise: resolves with the landing position,
  // rejects with a typed ElytraFlightError (check err.code).
  flight.fly(500, 500)
    .then((res) => bot.chat(`Landed at (${res.landedAt.x},${res.landedAt.z})`))
    .catch((err) => {
      if (err.code === 'STOPPED') return; // expected on flight.stop()
      bot.chat(`Flight failed: ${err.code}`);
    });
});
```

---

## Features

| Feature | Description |
|:--------|:------------|
| **Promise API** | `fly()` resolves with the landing position, rejects with a typed error code |
| **3 Flight Modes** | `FAST` (22 m/s), `MED` (13 m/s), `LOW` (10 m/s) — rocket boosts exceed these |
| **Smart Landing** | Glide-to-goal descent onto a verified safe spot |
| **Elytra Audit** | Durability + rocket estimates before flight (unbreaking-aware) |
| **Auto Rocket** | Equips and fires rockets automatically |
| **Terrain Avoidance** | Render-distance scans, climb steep into obstacles |
| **Deadstick** | Runs out of rockets mid-flight → glides to the goal |
| **Owner Alerts** | Whisper notifications |
| **Wander Scan** | Searches for safe spots over any terrain |
| **Retry System** | Retries transient failures; deterministic pre-flight failures fail fast |

---

## API

### `new ElytraFlight(bot, options?)`

Create a flight instance.

```js
const flight = new ElytraFlight(bot, {
  // Flight profile
  mode: 'MED',               // 'FAST' | 'MED' | 'LOW'
  cruiseAlt: 180,            // Cruise altitude (Y blocks)
  targetX: 0,                // Default target X
  targetZ: 0,                // Default target Z
  landingMargin: 1,          // Blocks of margin around the landing spot

  // Reliability
  maxRetries: 3,             // Retry attempts on transient in-flight failure
  wanderTimeoutMs: 120000,   // Give up a wander search after this long

  // Module switches
  safety: true,              // Pre-flight durability/rocket estimates
  elytraAudit: true,         // Skip only the elytra-durability estimate
  autoRocket: true,          // false = fly with no rockets at all
  autoRocketCustomStars: false, // Count/use rockets with custom stars
  chunkScan: true,           // Render-distance raycasts (terrain avoidance)
  pathfinding: true,         // Pathfind to a launch spot when blocked
  wander: true,              // Wander for a safe landing spot when none at target
  landing: true,             // false = dive straight at the target column
  relocationCanDig: false,   // Let the relocation pathfinder dig (keep off on public servers)

  // Behaviour
  hazardCheck: null,         // (block) => boolean — custom hazard override
  ownerUsername: '',         // Whisper each flight log line to this player
  debug: false,              // Verbose logging (false for production)
});
```

### `flight.fly(x, z, opts?) → Promise`

Fly to coordinates. Options override constructor options.

- **Resolves** with `{ phase: 'IDLE', landedAt: { x, y, z } }`.
- **Rejects** with an `ElytraFlightError` — branch on `err.code`, not message text.
- **Mid-cruise/deadstick** a call retargets the active flight and returns the
  *same* pending promise; in any other in-flight phase it rejects `IN_FLIGHT`
  (and does not change the active flight's target).

```js
flight.fly(500, 500)
  .then((res) => console.log('Landed at', res.landedAt))
  .catch((err) => {
    if (err.code === 'STOPPED') return;
    if (err.code === 'NO_ROCKETS') restock();
    // ...
  });

flight.fly(500, 500, { mode: 'FAST', cruiseAlt: 200 }); // one-off overrides
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
//   ok: true,                    // reason: null when ok
//   elytra: { have: 432, need: 50, equipped: 400, count: 2, unbreaking: 3 },
//   rockets: { have: 20, need: 8 }
// }
```

### `flight.isFlying`

Boolean — `true` if elytra is active.

### `flight.phase`

Current phase (string values): `IDLE`, `AUDIT`, `TAKEOFF`, `CLIMB`, `CRUISE`,
`DEADSTICK`, `LAND`, `SCAN`, `RELOC`, `FAIL`.

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
  console.error(err.code, err.message);
});
```

> The `error` event is an optional side-channel. If no `error` listener is
> attached, EAFE never throws — the `fly()` promise rejection is the primary
> error path.

---

## Error codes

Every rejected `fly()` carries a machine-readable `err.code`:

| Code | Meaning | Retried? |
|:-----|:--------|:---------|
| `IN_FLIGHT` | `fly()` called while flying (not a retargetable phase) | — |
| `NO_ENTITY` | Bot not spawned (`bot.entity` is null) | fail fast |
| `NO_ELYTRA` | No usable elytra in inventory | fail fast |
| `ELYTRA_LOW` | Total elytra durability below the requirement | fail fast |
| `NO_ROCKETS` | Not enough rockets for the estimated route | fail fast |
| `NO_LAUNCH_SPOT` | Every launch heading blocked and relocation off | fail fast |
| `PF_FAILED` | Pathfinding relocation failed | fail fast |
| `GROUND_HIT` | Hit the ground during climb | retried |
| `CLIMB_TIMEOUT` | Did not reach cruise altitude in time | retried |
| `NO_FLIGHT_CONFIRM` | Elytra flight not confirmed after launch | retried |
| `LOST_FLIGHT` | Elytra flight lost mid-flight, unrecoverable | retried |
| `NO_SAFE_SPOT` | No safe landing spot (wander timed out) | retried |
| `LANDING_TIMEOUT` | Landing did not finish in time | retried |
| `RETRIES_EXHAUSTED` | Max retries used up (last code in `err.cause`) | — |
| `STOPPED` | `flight.stop()` was called | — |
| `RESPAWN` | Bot respawned mid-flight | — |
| `DISCONNECTED` | Bot disconnected | — |
| `INTERNAL` | Unexpected internal error | — |

Deterministic pre-flight failures (the "fail fast" rows) reject immediately with
their specific code — retrying cannot change the outcome. Transient in-flight
failures are retried up to `maxRetries`, then reject `RETRIES_EXHAUSTED` with the
last failure's code available as `err.cause`.

---

## Flight Modes

| Mode | Planning speed | Fuel Use | Use Case |
|:-----|:---------------|:---------|:---------|
| `FAST` | 22 m/s | High | Emergency, short distance |
| `MED` | 13 m/s | Medium | Default, balanced |
| `LOW` | 10 m/s | Low | Long distance, fuel efficient |

Planning speed is the average ground speed used to estimate fuel; rocket
boosts push the bot well above it.

---

## Flight Phases

```
AUDIT → TAKEOFF → CLIMB → CRUISE → LAND → IDLE
                         ↘ DEADSTICK (out of rockets → glide to goal)
                         ↘ SCAN (no safe spot at target → wander)
                         ↘ FAIL (error → retry, then settle)
```

1. **AUDIT** — Check elytra durability and rockets
2. **TAKEOFF** — Jump, activate elytra, fire the first boost
3. **CLIMB** — Ascend to cruise altitude (hands off to DEADSTICK if fuel runs out)
4. **CRUISE** — Fly toward target (a `fly()` call here retargets in place)
5. **DEADSTICK** — Out of rockets: level glide to the goal, then land
6. **LAND** — Glide-to-goal descent onto a verified safe spot
7. **SCAN** — Search for a safe landing spot elsewhere (wander)
8. **IDLE** — Landed or stopped
9. **FAIL** — Error occurred (retries transient failures, then settles)

---

## Helpers

```js
const { countRockets, getElytraSummary } = require('@eksses/eafe');

const rockets = countRockets(bot);        // Number
const elytra = getElytraSummary(bot);     // { totalDurabilityAcrossAll, count, bestUnbreaking }
```

---

## Examples

All examples are promise-driven (`fly().then(...).catch(...)`) and only use the
public API.

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
| [`advanced.js`](examples/advanced.js) | FAST mode + status polling |
| [`preflight.js`](examples/preflight.js) | Gear check before flying |
| [`custom.js`](examples/custom.js) | Module switches, custom hazard + mode |

---

## Requirements

- **Node.js** ≥ 16.0.0
- **mineflayer** ≥ 4.0.0
- Bot must have **elytra** equipped in chest slot
- Bot must have **firework rockets** in inventory (unless `autoRocket: false`)

---

## Development

Zero-dependency test suite — a mock mineflayer bot over real prismarine-world
1.21 terrain with blocks/tick physics. Tests run in real time (~40 s):

```bash
node test/run.js            # unit + integration
node test/run.js unit       # unit only
node test/run.js integ      # integration only (full mock flights)
npm run lint                # ESLint (flat config)
```

CI (`.github/workflows/ci.yml`) runs lint + the full suite on Node 18/20/22.

---

## License

[MIT](LICENSE)

