# AGENTS.md — AI Agent Guide for @eksses/eafe

## Package Overview

`@eksses/eafe` is an autonomous elytra flight engine for mineflayer. It handles
takeoff, climb, cruise, terrain avoidance, and safe landing automatically.
`fly()` is **promise-based**: it resolves with the landing position and rejects
with a typed `ElytraFlightError` (`err.code`).

## Commands

```bash
node test/run.js            # unit + integration (~40s, real-time mock flights)
node test/run.js unit       # unit only
node test/run.js integ      # integration only
npm run lint                # ESLint flat config over src, test, examples
npm pack --dry-run          # verify package contents
```

## Quick Start

```js
const mineflayer = require('mineflayer');
const { ElytraFlight } = require('@eksses/eafe');

const bot = mineflayer.createBot({ host: 'localhost', username: 'Bot' });
bot.once('spawn', () => {
  const flight = new ElytraFlight(bot);
  flight.fly(500, 500)
    .then((res) => console.log('Landed at', res.landedAt))
    .catch((err) => {
      if (err.code === 'STOPPED') return;
      console.error(err.code, err.message);
    });
});
```

## Architecture

```
src/
├── index.js          # ElytraFlight class (main API, ctx wiring, retry scheduler)
├── constants.js      # MODES, PHASE, HAZARD_SURFACES, CARDINAL_YAWS
├── errors.js         # ErrorCode (19 codes), ElytraFlightError, NON_RETRYABLE
├── logger.js         # Logger with [E] prefix (per-instance)
├── utils.js          # sleep, isAir, hasCollision, angleDiff
├── core/
│   ├── inventory.js  # countRockets, findRocket, autoEquipRocket
│   ├── elytra.js     # getElytraSummary, auditAndEquipElytra, damage rate 2/(n+3)
│   └── rockets.js    # fireRocketDirect (yaw-gated), smartFireRocket, getBoostTime
└── flight/
    ├── spatial.js    # getGroundBlockAt, scanFullRenderDistance, ground tracking
    ├── phases.js     # startFlight, startClimb, startCruise, executeTakeoff
    ├── wander.js     # findSafeLandingSpotAround, startWanderScan
    └── landing.js    # startLanding (glide-to-goal, spot search, hazard check)

legacy/elytraBot.js   # pre-12 monolith — reference only, NOT version-controlled
```

All modules are factories taking a `ctx` object built in `index.js`
(`_buildCtx`). Never reach across modules through `flight._ctx` — use the
public options (`hazardCheck`, module switches) instead.

## Core API

### `new ElytraFlight(bot, options?)`

```js
{
  // Flight profile
  mode: 'MED',               // 'FAST' | 'MED' | 'LOW'
  cruiseAlt: 180,            // Cruise altitude (Y)
  targetX: 0, targetZ: 0,    // Default target
  landingMargin: 1,          // Margin around landing spot
  // Reliability
  maxRetries: 3,             // Retries for transient in-flight failures
  wanderTimeoutMs: 120000,
  // Module switches
  safety: true, elytraAudit: true, autoRocket: true,
  autoRocketCustomStars: false, chunkScan: true, pathfinding: true,
  wander: true, landing: true, relocationCanDig: false,
  // Behaviour
  hazardCheck: null,         // (block) => boolean hazard override
  ownerUsername: '',         // whisper log lines to this player
  debug: false,
}
```

### `flight.fly(x, z, opts?) → Promise`

- Resolves `{ phase: 'IDLE', landedAt: { x, y, z } }`.
- Rejects with `ElytraFlightError` — **branch on `err.code`**, never message text.
- During `CRUISE`/`DEADSTICK` it retargets the active flight and returns the
  same pending promise. In other in-flight phases it rejects `IN_FLIGHT` and
  does **not** change the active flight's target.
- Retries: deterministic pre-flight failures (`NO_ENTITY`, `NO_ELYTRA`,
  `ELYTRA_LOW`, `NO_ROCKETS`, `NO_LAUNCH_SPOT`, `PF_FAILED` — see
  `NON_RETRYABLE` in `errors.js`) fail fast with their code. Transient
  in-flight failures retry up to `maxRetries`, then reject
  `RETRIES_EXHAUSTED` with the last code in `err.cause`.

Other methods: `stop(reason?)`, `setMode(mode)`, `setTarget(x, z)`,
`setStatus(x, z)` (snapshot), `preflight()` (async check), `isFlying`,
`phase`, `targetX`, `targetZ`.

## Flight Phases

`IDLE → AUDIT → TAKEOFF → CLIMB → CRUISE → LAND → IDLE`, with `DEADSTICK`
(out of fuel → glide), `SCAN` (wander), `RELOC`, and `FAIL` (retrying; note the
string value of `PHASE.FAILED` is `'FAIL'`).

## Events

`phase(phase, msg)`, `stopped(reason)`, `error(err)`. The `error` event is an
optional side-channel: emission is guarded (`listenerCount` check), so a missing
listener never throws. The `fly()` promise rejection is the primary error path.
Drive queue logic (deliveries, waypoints, transfers) with the `fly()` promise —
watching for the `IDLE` phase event double-fires (IDLE is emitted on stop too).

## Critical invariants (learned from real bugs — do not regress)

- **Yaw convention** (verified against mineflayer's own `bot.lookAt` and
  mineflayer-pathfinder): `yaw = atan2(-dx, -dz)` faces `(dx, dz)`, so
  `forward(yaw) = (-sin(yaw), -cos(yaw))` in (x, z). Mock physics must match.
- **`_yawTo` dead zone**: within 3 m of the target column the bearing is
  numerically unstable (jitter flips it ~180°) — hold the current heading.
  Removing this makes the bot spin and stall above the target.
- **Takeoff fires first**: an elytra at jump apex is already `isFlying()` with
  zero boost, so the first `fireRocketDirect` must happen before any
  `isFlying()` check; the fire loop polls until a rocket actually leaves
  (yaw gate may block the first few calls).
- **Climb fuel-out**: when `autoRocket` is on and the inventory hits 0 mid-climb,
  hand off to a DEADSTICK glide (`startCruise({ keepPhase: true })`) instead of
  stalling into GROUND_HIT.
- **Landing is glide-to-goal** (aim at the spot, pitch by altitude delta) — the
  old spiral orbit circled the target and skimmed the ground far off it.
- **`stop()` clears real handles** (`flyLoop`, `verifyLoop`, `rocketLoop`,
  `climbLoop`, `landLoop` + retry/sneak timeouts), emits exactly one `stopped`,
  and rejects the pending promise with `STOPPED`.
- **`emit('error')` must stay guarded** — a bare emit throws when no listener is
  attached and would break every `.catch()`.

## Testing

Zero-dependency runner (`test/run.js`) + mock mineflayer bot
(`test/helpers/mock-bot.js`): real prismarine-world 1.21 terrain,
`entity.velocity` in **blocks/tick**, elytra model with rocket boost decay,
~15:1 glide (12 m/s floor, pitch-follow + induced sink), and stall when
pointing up without a rocket.

Test gotchas (all hit in practice):
- `stepUntil(cond)` is **async — always `await` it**; an un-awaited call is a
  truthy Promise and silently passes assertions.
- Drive the mock until `flight._pending === null`, **not** until
  `phase === FAILED` — the phase goes FAILED on every failed attempt while a
  retry is pending; stopping physics then starves the retry (bot frozen on the
  ground → spurious "jump fail" on every retry).
- Monkey-patching `bot.step` must pass `dt` through (`bot.step = (dt) =>
  origStep(dt)`) — dropping it makes the physics NaN.
- Long-flight tests need enough rockets for the route (measured with the mock's
  defaults, maxRetries=3, cruiseAlt=180: 300 m ≈ 36, 500 m ≈ 38) unless the test
  is about running out (`safety: false`).

Perf guard: a 300 m flight must stay under 500k `blockAt` calls (~45k in
practice) — terrain scans stay bounded by altitude and distance.

## Dependencies

- **mineflayer** `>=4.0.0` — peer dependency
- **mineflayer-pathfinder** `^2.4.5` — relocation pathfinding
- **vec3** `^0.2.0` — 3D vectors (mock + src)
- dev: **eslint** + **@eslint/js** (flat config)

## Notes

- Bot must have elytra equipped in the chest slot and rockets in inventory
  (unless `autoRocket: false`).
- Landing spots require air above + margin; a cactus/other hazard under the
  target is avoided by the spot search, and a hazard touchdown relocates
  instead of looping forever.
- No rockets during landing; DEADSTICK is a level glide.
- CommonJS everywhere (`"type": "commonjs"`), Node ≥ 16.
