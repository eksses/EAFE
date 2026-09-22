'use strict';

/**
 * Flight modes.
 *
 * speedMps         — expected average ground speed (m/s) used for planning.
 * pitch            — steady cruise pitch (radians, negative = descending).
 * speedGate        — fire a rocket when speed drops below this (blocks/tick,
 *                    1 block/tick = 20 m/s).
 * fuelDistDivider  — horizontal meters of flight covered per rocket when
 *                    estimating fuel (lower = more rockets budgeted).
 */
const MODES = {
  FAST: {
    name: 'FAST',
    fullName: 'FAST (High Speed Sprint)',
    pitch: 0.02,
    speedGate: 1.1,
    speedMps: 22.0,
    fuelDistDivider: 50.0,
  },
  MEDIUM: {
    name: 'MED',
    fullName: 'MED (Balanced Glide)',
    pitch: -0.04,
    speedGate: 0.55,
    speedMps: 13.0,
    fuelDistDivider: 120.0,
  },
  EFFICIENT: {
    name: 'LOW',
    fullName: 'LOW (Rocket Saver)',
    pitch: -0.05,
    speedGate: 0.40,
    speedMps: 10.0,
    fuelDistDivider: 180.0,
  },
};

// Documented aliases so 'MED' / 'LOW' resolve (previously fell back to MED silently).
MODES.MED = MODES.MEDIUM;
MODES.LOW = MODES.EFFICIENT;

const PHASE = {
  IDLE: 'IDLE',
  AUDIT: 'AUDIT',
  RELOCATING: 'RELOC',
  TAKEOFF: 'TAKEOFF',
  CLIMBING: 'CLIMB',
  CRUISING: 'CRUISE',
  WANDER_SCAN: 'SCAN',
  DEAD_STICK: 'DEADSTICK',
  LANDING: 'LAND',
  FAILED: 'FAIL',
};

/** Surfaces the bot must not land on / fly through. Exact names only. */
const HAZARD_SURFACES = new Set([
  'water', 'flowing_water', 'lava', 'flowing_lava', 'magma_block',
  'fire', 'soul_fire', 'sweet_berry_bush', 'cactus', 'powder_snow',
]);

const CARDINAL_YAWS = [
  Math.PI,
  -Math.PI / 2,
  0,
  Math.PI / 2,
];

module.exports = { MODES, PHASE, HAZARD_SURFACES, CARDINAL_YAWS };
