# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [12.0.0] — 2026-09-22

A full modular rewrite of the flight engine. The monolithic `elytraBot.js` is
replaced by focused modules, `fly()` becomes promise-based, and a zero-dependency
mock-bot test suite (27 tests) guards the whole flight lifecycle.

### Breaking
- **Modular layout.** The single `elytraBot.js` is split into `src/`:
  `index.js`, `constants.js`, `errors.js`, `logger.js`, `utils.js`,
  `core/{elytra,inventory,rockets}.js`, `flight/{spatial,phases,wander,landing}.js`.
  `src/commands.js`, `src/config.js`, and `src/core/chat.js` are removed.
  `legacy/elytraBot.js` is kept on disk for reference but excluded from the npm package.
- **`fly(x, z, opts)` returns a Promise.** It resolves with
  `{ phase: 'IDLE', landedAt: {x,y,z} }` and rejects with a typed
  `ElytraFlightError` (inspect `err.code`, not the message text).
- **Version 11.0.3 → 12.0.0.** Import surface changes (`@eksses/eafe` exports
  subpaths such as `@eksses/eafe/errors`); event-only consumers should switch to
  the promise + `err.code` pattern.

### Added
- `src/errors.js` — `ElytraFlightError` with 19 machine-readable codes
  (`IN_FLIGHT`, `NO_ENTITY`, `NO_ELYTRA`, `ELYTRA_LOW`, `NO_ROCKETS`,
  `NO_LAUNCH_SPOT`, `PF_FAILED`, `GROUND_HIT`, `CLIMB_TIMEOUT`,
  `NO_FLIGHT_CONFIRM`, `LOST_FLIGHT`, `NO_SAFE_SPOT`, `LANDING_TIMEOUT`,
  `RETRIES_EXHAUSTED`, `STOPPED`, `RESPAWN`, `DISCONNECTED`, `INTERNAL`).
- `hazardCheck` public option — override which blocks count as hazards
  (landing spots, terrain scans, ground safety). Replaces the old internal
  `_ctx.isHazardous` hook.
- `ownerUsername` option — whispers each flight log line to that player.
- Zero-dependency test suite: `node test/run.js` (unit + integration) and
  `test/helpers/mock-bot.js` (a mock mineflayer bot over real prismarine-world
  1.21 terrain with blocks/tick physics). 27 tests cover the full 300 m flight,
  cactus/hazard recovery, out-of-rockets deadstick, mid-cruise retarget, and
  stop/retry semantics.
- `LICENSE` (MIT), `CHANGELOG.md`, ESLint flat config (`npm run lint`), and a
  GitHub Actions workflow running the test suite on Node 18/20/22.

### Changed
- **Retry semantics.** Deterministic pre-flight preconditions
  (`NO_ENTITY`, `NO_ELYTRA`, `ELYTRA_LOW`, `NO_ROCKETS`, `NO_LAUNCH_SPOT`,
  `PF_FAILED`) now **fail fast** with their specific code — retrying cannot
  change the outcome. Transient in-flight failures are retried and the final
  rejection is `RETRIES_EXHAUSTED`, with the last failure's code in
  `err.cause` and the message.
- **Retargeting.** Calling `fly()` mid-cruise/deadstick retargets the active
  flight and returns the *same* pending promise. A rejected `fly()` no longer
  silently retargets the active flight.
- **Landing.** Replaced the spiral-orbit descent with a straight glide-to-goal:
  aim directly at the landing spot, pitch by altitude delta. The old spiral
  orbited the target and could skim the ground far off it.
- **Elytra damage** uses the `2/(n+3)` unbreaking rate; required durability
  scales with distance and best unbreaking level.
- **Landing-surface detection** uses the block's collision shapes (full-cube
  check) instead of a name allow-list.

### Fixed
- **Yaw singularity over the target.** `yawTo()` returned a numerically
  unstable bearing when the bot was within ~3 m of the target column —
  sub-block jitter flipped it up to 180°, making the bot spin in circles and
  never pass the rocket's yaw gate (infinite stall). A 3 m dead-zone now holds
  the current heading.
- **Takeoff skipped the first boost.** The loop checked `isFlying()` before the
  first `fireRocketDirect`, but an elytra at jump apex is already "flying" with
  zero boost — so no rocket ever fired and the bot stalled. It now fires first,
  then checks.
- **Out-of-fuel climb died with `GROUND_HIT`.** A 1-rocket launch burned its
  only boost at takeoff, then stalled on the ground during climb. The climb now
  hands off to a DEADSTICK glide when the inventory runs dry.
- **`emit('error')` threw synchronously** when no `'error'` listener was
  attached, turning a cleanly-rejectable `fly()` into a raw throw the caller's
  `.catch()` could never see. Error emission is now guarded; the promise
  rejection is the primary channel.
- **`PHASE.CRUISE` constant bug.** The retarget branch compared against
  `PHASE.CRUISE` (an undefined key — the real key is `CRUISING`), so it never
  fired.
- **Zombie timers after stop.** `stop()` now clears the real interval handles
  (`flyLoop`, `verifyLoop`, `rocketLoop`, `climbLoop`, `landLoop`) plus the
  retry/sneak timeouts, emits exactly one `stopped`, and settles the pending
  promise with `STOPPED`.
- **`_pending.promise` was never set**, so mid-cruise retargeting returned
  `undefined`.

### Performance
- Terrain scans are bounded: ground is probed only near the bot's altitude and
  the landing trigger uses a distance-based descent window. A 300 m flight now
  makes ~45k `blockAt` calls (perf guard `< 500k`) instead of repeatedly
  scanning full render distance twice per tick.

## [11.x] — prior
Monolithic `elytraBot.js` engine (event-driven `fly()`), shipped without a
LICENSE file or automated tests. See the git history for 11.0.3.
