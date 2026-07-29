'use strict';

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
