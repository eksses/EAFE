'use strict';

/**
 * Machine-readable error codes emitted by ElytraFlight.
 *
 * Consumers should match on `err.code` (not on message text):
 *
 *   flight.fly(500, 500).catch(err => {
 *     if (err.code === 'NO_ROCKETS') restock(err);
 *   });
 */
const ErrorCode = Object.freeze({
  /** fly() called while already flying (and not in a retargetable phase). */
  IN_FLIGHT: 'IN_FLIGHT',
  /** Called before the bot spawned (no bot.entity). */
  NO_ENTITY: 'NO_ENTITY',
  /** No elytra with usable durability in the inventory. */
  NO_ELYTRA: 'NO_ELYTRA',
  /** Total elytra durability below the requirement for this distance. */
  ELYTRA_LOW: 'ELYTRA_LOW',
  /** Not enough firework rockets for the estimated route. */
  NO_ROCKETS: 'NO_ROCKETS',
  /** Every launch heading is blocked and relocation was disabled. */
  NO_LAUNCH_SPOT: 'NO_LAUNCH_SPOT',
  /** Pathfinding relocation to a launch spot failed. */
  PF_FAILED: 'PF_FAILED',
  /** The bot hit the ground during climb. */
  GROUND_HIT: 'GROUND_HIT',
  /** Climb did not reach cruise altitude in time. */
  CLIMB_TIMEOUT: 'CLIMB_TIMEOUT',
  /** Elytra flight could not be confirmed after launch. */
  NO_FLIGHT_CONFIRM: 'NO_FLIGHT_CONFIRM',
  /** Elytra flight was lost mid-flight and could not be recovered. */
  LOST_FLIGHT: 'LOST_FLIGHT',
  /** No safe landing spot could be found (wander scan timed out). */
  NO_SAFE_SPOT: 'NO_SAFE_SPOT',
  /** Spiral landing did not finish in time. */
  LANDING_TIMEOUT: 'LANDING_TIMEOUT',
  /** Max retries exhausted. */
  RETRIES_EXHAUSTED: 'RETRIES_EXHAUSTED',
  /** flight.stop() was called. */
  STOPPED: 'STOPPED',
  /** The bot respawned mid-flight. */
  RESPAWN: 'RESPAWN',
  /** The bot disconnected. */
  DISCONNECTED: 'DISCONNECTED',
  /** Unexpected internal error. */
  INTERNAL: 'INTERNAL',
});

/**
 * Pre-flight precondition failures. These are deterministic — retrying
 * cannot change the outcome (the bot is still not spawned, the inventory
 * is still short of rockets) — so fly() fails fast with the specific code
 * instead of burning the retry budget and re-reporting RETRIES_EXHAUSTED.
 * Every other failure code is considered transient and gets retried.
 */
const NON_RETRYABLE = new Set(Object.freeze([
  ErrorCode.NO_ENTITY,
  ErrorCode.NO_ELYTRA,
  ErrorCode.ELYTRA_LOW,
  ErrorCode.NO_ROCKETS,
  ErrorCode.NO_LAUNCH_SPOT,
  ErrorCode.PF_FAILED,
]));

class ElytraFlightError extends Error {
  /**
   * @param {string} code  one of {@link ErrorCode}
   * @param {string} [message]
   */
  constructor(code, message) {
    super(message || code.toLowerCase().replace(/_/g, ' '));
    this.name = 'ElytraFlightError';
    this.code = code;
  }
}

module.exports = { ErrorCode, ElytraFlightError, NON_RETRYABLE };
