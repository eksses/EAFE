# AUDIT.md — Full Technical Audit of EAFE-v7 and EAFE-v7.1

**Date:** 2026-07-26
**Auditor:** opencode (automated)
**Scope:** EAFE-v7.md (Master Architecture Specification), EAFE-v7.1.md (Engineering Specification beta)

---

## Executive Summary

| Severity | Count |
|----------|-------|
| HIGH     | 2     |
| MEDIUM   | 5     |
| LOW      | 5     |
| **Total**| **12**|

v7.1 supersedes v7 on all physics-correctness issues. v7 appears to be a reference/design document; v7.1 is the production-grade spec. The main risks are: (1) the two versions diverge without explicit cross-reference, (2) the RECOVERY FSM state in v7.1 has no defined next-state, and (3) anti-cheat Bézier PRNG is unspecified.

---

## 1. Physics Correctness

### PHYS-001: Unified drag constant in v7 is incorrect
- **Severity:** HIGH
- **Location:** EAFE-v7.md:59-67
- **Description:** v7 applies k_d = 0.99 uniformly to all axes (line 60: `v_drag = v_t * 0.99`). Vanilla `LivingEntity.travel` uses 0.99 for horizontal (X, Z) and 0.98 for vertical (Y). This causes vertical position drift over long distances — the bot descends slower than vanilla, accumulating error.
- **Recommendation:** Document that v7.1 supersedes v7's drag model. The v7 spec should carry a deprecation note or be treated as reference-only.

### PHYS-002: v7 lift coefficient formula has no physical basis
- **Severity:** HIGH
- **Location:** EAFE-v7.md:64-67
- **Description:** v7 defines `C_L = cos(theta) * min(1.0, ||v||^2 / 1.0)` and then feeds it into a custom lift/drag redistribution model (lines 65-67). This formula has no correspondence to vanilla elytra mechanics. The min(1.0, v^2/1.0) term means C_L saturates at speed = 1.0 blocks/tick, which is arbitrary. The 0.1 scaling factor on lift (line 65) is also undocumented.
- **Recommendation:** v7.1's `cos^2(phi) * 0.06` passive wing lift is the correct vanilla decomposition. v7's C_L formula should be marked as superseded.

### PHYS-003: Passive wing lift present only in v7.1
- **Severity:** INFO (correct in v7.1)
- **Location:** EAFE-v7.1.md:16, 32
- **Description:** v7.1 adds `cos^2(phi) * 0.06` as a passive wing lift term in Step 2. This matches vanilla's per-tick lift decomposition and is absent from v7. This is a correctness improvement, not a bug.
- **Recommendation:** None. v7.1 is correct.

### PHYS-004: Pitch energy exchange differs between versions
- **Severity:** INFO
- **Location:** EAFE-v7.md:64-67, EAFE-v7.1.md:22-29
- **Description:** v7 uses a single C_L formula to handle lift. v7.1 decomposes this into two explicit scenarios: nose-up (horizontal-to-vertical conversion) and nose-down (fall-to-thrust conversion), with different coefficients (0.04 vs 0.1). v7.1 is more physically accurate.
- **Recommendation:** None. v7.1 is the improved model.

---

## 2. Formula Consistency Between Versions

### CONSIST-001: Drag model contradicts between versions
- **Severity:** HIGH (subsumed by PHYS-001)
- **Location:** EAFE-v7.md:59-60, EAFE-v7.1.md:18-21
- **Description:** v7 applies uniform 0.99 drag. v7.1 uses axis-decoupled 0.99 (horizontal) / 0.98 (vertical). These produce numerically different results. The critical distinction note on v7.1:36 explicitly calls out this drift.
- **Recommendation:** Note in README that v7.1 is the authoritative physics model.

### CONSIST-002: Lift model superseded
- **Severity:** MEDIUM
- **Location:** EAFE-v7.md:64-67, EAFE-v7.1.md:16, 31-32
- **Description:** v7's C_L formula is replaced by v7.1's decomposed pitch exchange + passive wing lift. The two models produce different velocity vectors for the same inputs.
- **Recommendation:** Note supersession in cross-reference table.

### CONSIST-003: Gravity consistent
- **Severity:** N/A
- **Location:** EAFE-v7.md:61, EAFE-v7.1.md:15
- **Description:** Both use g = 0.08 blocks/tick^2. Consistent with vanilla decompilation.
- **Recommendation:** None.

### CONSIST-004: Velocity update ordering differs
- **Severity:** MEDIUM
- **Location:** EAFE-v7.md:59-67, EAFE-v7.1.md:5-21
- **Description:** v7 applies drag first, then gravity, then lift redistribution (lines 59-67). v7.1 applies: (1) pitch exchange, (2) gravity + impulse + lift, (3) drag. These produce different numerical outcomes even with identical coefficients, because drag applied before vs. after gravity changes the effective gravitational acceleration.
- **Recommendation:** Document that v7.1 is the authoritative update order.

### CONSIST-005: Nether hazard model differs
- **Severity:** LOW
- **Location:** EAFE-v7.md:216-221, EAFE-v7.1.md:96-102
- **Description:** v7 uses a weighted sum of inverse-square distances (H(n) formula with w_1..w_4 weights). v7.1 uses a percentage-based ratio (N_lava + 2*N_obstacle) / N_scanned. The v7.1 model is simpler and threshold-based (H > 30% suspends flight). Different algorithms, different behavior.
- **Recommendation:** Note in cross-reference table.

---

## 3. FSM Completeness

### FSM-001: RECOVERY state has no defined next-state
- **Severity:** MEDIUM
- **Location:** EAFE-v7.1.md:152
- **Description:** The RECOVERY row in the FSM table (line 152) shows empty cells in the "Next State" column. The exit condition text reads "Flight restored -> CRUISE; Ground reached -> TAKEOFF" but the Next State column itself is blank. This is ambiguous — does the state self-transition, or is the table incomplete?
- **Recommendation:** Fill in explicit next-state entries: "Flight restored -> CRUISE; Ground reached -> TAKEOFF" in the Next State column.

### FSM-002: v7 FSM has 10 states, v7.1 has 7 — no reconciliation
- **Severity:** LOW
- **Location:** EAFE-v7.md:4-39, EAFE-v7.1.md:143-152
- **Description:** v7 defines IDLE, AUDIT, PRE_FLIGHT, GROUND_PATHFIND, TAKEOFF, CRUISE, EVASION, DESCENT, LANDING, STALL_ORBIT (10 states). v7.1 defines IDLE, TAKEOFF, STEEP_CLIMB, CRUISE, STALL_ORBIT, DESCENT_SPIRAL, TOUCHDOWN, RECOVERY (8 states, though RECOVERY is partially defined). States like AUDIT, PRE_FLIGHT, GROUND_PATHFIND, EVASION exist only in v7. No mapping or migration note exists.
- **Recommendation:** Add a migration table in README mapping v7 states to v7.1 equivalents.

### FSM-003: No IDLE recovery path from terminal states in v7.1
- **Severity:** LOW
- **Location:** EAFE-v7.1.md:143-152
- **Description:** TOUCHDOWN transitions to IDLE (line 151), but RECOVERY's next-state is undefined. If RECOVERY is meant to be a mid-flight error recovery state, it should have explicit paths back to CRUISE or TAKEOFF as its exit condition text implies.
- **Recommendation:** Fill RECOVERY next-state as specified in FSM-001.

### FSM-004: v7 ERR_RUBBERBAND_LOOP threshold unverifiable
- **Severity:** LOW
- **Location:** EAFE-v7.md:264
- **Description:** "> 3 server position reset packets received within 10 ticks" is stated as the rubberband detection trigger. This threshold is plausible (2 resets/sec in vanilla) but cannot be verified against vanilla source without decompilation access. The 10-tick window at 20 TPS = 500ms.
- **Recommendation:** Flag as empirical value; verify against server source if available.

---

## 4. Anti-Cheat Logic

### ANTI-001: PRNG for Bezier perturbation unspecified
- **Severity:** LOW
- **Location:** EAFE-v7.md:120-122
- **Description:** The Gaussian noise N(0, sigma^2) on control points P1 and P2 (lines 121-122) does not specify a PRNG algorithm or seed strategy. Different PRNGs produce different sequences, which affects anti-cheat fingerprinting. A seeded PRNG (e.g., MT19937) would make behavior reproducible for debugging.
- **Recommendation:** Specify PRNG (e.g., seeded MT19937 or crypto.getRandomValues) and seed strategy (e.g., per-session random seed).

### ANTI-002: Packet jitter is asymmetric — verify intentional
- **Severity:** LOW
- **Location:** EAFE-v7.md:127
- **Description:** Packet delay is `50ms +/- U(-4ms, +6ms)`, meaning the range is [46ms, 56ms] — biased toward longer delays. This is asymmetric. Real human input jitter tends to be roughly symmetric or right-skewed. The +6ms / -4ms asymmetry may be intentional (slight bias toward longer gaps is more human-like), but it's undocumented.
- **Recommendation:** Document intent: "Asymmetric jitter biases toward longer delays to simulate human reaction latency."

### ANTI-003: Slew rate limits — verify against human neck muscle limits
- **Severity:** INFO
- **Location:** EAFE-v7.md:124-125
- **Description:** Delta yaw <= 0.35 rad/tick (~20 deg/tick) and delta pitch <= 0.26 rad/tick (~15 deg/tick). At 20 TPS, this is ~400 deg/s yaw and ~300 deg/s pitch. Professional FPS players typically achieve 200-400 deg/s yaw. The values are at the upper end of human capability but plausible for fast flick shots.
- **Recommendation:** None. Values are reasonable.

---

## 5. Edge Cases and Missing Failure Modes

### EDGE-001: Nether void weight disproportionate
- **Severity:** LOW
- **Location:** EAFE-v7.md:220
- **Description:** w_4 = 200.0 for void indicator in the Nether Hazard Index. Since void is binary (instant death), any w_4 > 0 would trigger avoidance. 200 inflates H(n) unnecessarily and could mask the relative importance of lava (w_1 = 100) and bedrock (w_2 = 80) proximity. A void node at distance 1 from bedrock would score H(n) >= 200, making the bedrock term (80/d^2) irrelevant.
- **Recommendation:** Reduce to w_4 = 1.0 or document that high weight ensures immediate path rerouting regardless of other hazards.

### EDGE-002: Fuel safety buffer +15 undocumented
- **Severity:** LOW
- **Location:** EAFE-v7.1.md:44
- **Description:** The fuel equation adds `+ 15` as a "mandatory safety buffer reserved for landing re-routes and emergency climbs." This is an empirical constant. No derivation or sensitivity analysis is provided. If the bot typically needs 2-3 rockets for landing re-routes and 1-2 for emergency climbs, 15 is conservative (7-15x overhead).
- **Recommendation:** Document the derivation or at minimum the expected worst-case consumption that 15 covers.

### EDGE-003: Portal blockage timeout 60 ticks vs vanilla 80-tick cooldown
- **Severity:** LOW
- **Location:** EAFE-v7.md:267
- **Description:** v7 uses a 60-tick (3s) timeout for portal dimension shift. Vanilla has an 80-tick (4s) cooldown on portal usage after a dimension change. If the bot enters a portal at tick 0, the server won't process the shift until tick 80, but v7's fail-safe triggers at tick 60 and repositions the bot — potentially pulling it out of the portal before the shift completes.
- **Recommendation:** Increase timeout to 80-100 ticks to account for vanilla portal cooldown, or document that 60 ticks applies only to the first portal entry attempt.

### EDGE-004: TPS threshold 12.0 — verify cutoff appropriateness
- **Severity:** INFO
- **Location:** EAFE-v7.md:49, 152, EAFE-v7.1.md:87
- **Description:** Both versions use TPS < 12.0 as the threshold for entering STALL_ORBIT. Most servers run at 20 TPS. A threshold of 12 means the bot tolerates up to 40% server lag before stalling. This is aggressive — many anti-cheat systems flag erratic movement at TPS < 15. However, 12 is a reasonable threshold for vanilla servers without heavy plugins.
- **Recommendation:** None. 12.0 is a reasonable default; document that it can be tuned per-server.

### EDGE-005: v7 landing spiral parameters differ from v7.1
- **Severity:** INFO
- **Location:** EAFE-v7.md:235, EAFE-v7.1.md:136-137
- **Description:** v7 uses Archimedean spiral with a=0.5, b=0.8, alpha in [0, 6pi]. v7.1 uses a=1.0, b=0.5, R=1->25 blocks. Different spiral geometries. v7.1's spiral is more practical (expanding radius search).
- **Recommendation:** None. v7.1 is the improved model.

---

## 6. Mathematical Notation

### NOTATION-001: Pitch/yaw symbol convention differs between versions
- **Severity:** MEDIUM
- **Location:** EAFE-v7.md:56-57, EAFE-v7.1.md:23, 39-40
- **Description:** v7 uses phi for both pitch and yaw (context-dependent, lines 56-57). v7.1 uses phi for pitch and theta for yaw (lines 23, 39-40). This makes cross-referencing formulas between versions confusing. For example, "theta" means yaw in v7 but pitch in v7.1.
- **Recommendation:** Standardize on v7.1 convention (phi=pitch, theta=yaw) in any shared documentation. Add a notation legend.

### NOTATION-002: v7 orientation vector definition ambiguous
- **Severity:** MEDIUM
- **Location:** EAFE-v7.md:56-57
- **Description:** v7 defines d = (d_x, d_y, d_z) using both theta and phi but doesn't clarify which is pitch and which is yaw in the definition. Line 56 says "derived from pitch theta and yaw phi" but then uses phi in d_x and d_z while theta appears in d_y. This is internally consistent but conflicts with v7.1's convention.
- **Recommendation:** Clarify in v7 or defer to v7.1 notation.

### NOTATION-003: Dimensional consistency check
- **Severity:** INFO
- **Location:** Both files
- **Description:** All formulas are dimensionally consistent (blocks/tick^2 for acceleration, blocks/tick for velocity, rad for angles, rad/tick for angular velocity). No dimensional mismatches found.
- **Recommendation:** None.

---

## 7. Cross-Reference: v7 Issues Fixed in v7.1

| v7 Issue | v7.1 Status | Notes |
|----------|-------------|-------|
| Unified 0.99 drag (PHYS-001) | FIXED | Axis-decoupled 0.99/0.98 in v7.1 |
| C_L formula (PHYS-002) | FIXED | Replaced with decomposed pitch exchange + passive wing lift |
| No passive wing lift | FIXED | cos^2(phi) * 0.06 added in v7.1 |
| Velocity update order | FIXED | v7.1 uses pitch exchange -> gravity -> drag |
| Nether hazard model | CHANGED | v7.1 uses percentage-based ratio instead of weighted sum |
| Landing spiral | IMPROVED | v7.1 uses expanding radius search |
| Portal timeout 60 ticks | NOT ADDRESSED | v7.1 doesn't mention portal mechanics |
| Bézier PRNG unspecified | NOT ADDRESSED | v7.1 doesn't include anti-cheat section |
| Fuel buffer +15 | NOT ADDRESSED | v7.1 retains the same formula |

---

## 8. Audit Completeness Verification

### v7 Sections Reviewed

| Section | Lines | Findings |
|---------|-------|----------|
| 1. Executive System Overview & FSM | 1-52 | FSM-002, FSM-004 |
| 2. Kinematics, Drag Physics & Aerodynamic Lift | 53-71 | PHYS-001, PHYS-002, CONSIST-001, CONSIST-002, CONSIST-004, NOTATION-001, NOTATION-002 |
| 3. Pre-Flight Volumetric Auditing | 72-107 | None |
| 4. Anti-Cheat Humanization | 108-127 | ANTI-001, ANTI-002, ANTI-003 |
| 5. Airborne Navigation & Chunk Throttling | 128-167 | EDGE-004 |
| 6. Threat Evasion Engine | 168-198 | None |
| 7. Nether Hazard Index | 199-221 | EDGE-001, CONSIST-005 |
| 8. Archimedean Landing Scan | 222-257 | EDGE-005 |
| 9. Unified Fail-Safe & Recovery Matrix | 258-267 | EDGE-003, FSM-004 |

### v7.1 Sections Reviewed

| Section | Lines | Findings |
|---------|-------|----------|
| 1. Decompiled Vanilla Physics | 1-35 | PHYS-003, PHYS-004, CONSIST-001, CONSIST-004 |
| 2. Navigation Vectors & Fuel | 37-45 | EDGE-002 |
| 3. Ground Takeoff Mechanics | 46-62 | None |
| 4. Chunk Streaming & Network Sync | 63-87 | EDGE-004 |
| 5. Dimension Corridors & Nether | 88-102 | CONSIST-005 |
| 6. Air-Braking & Surface Classifier | 103-141 | EDGE-005 |
| 7. FSM & Fail-Safe Matrix | 142-164 | FSM-001, FSM-002, FSM-003 |

All sections reviewed. No sections skipped.

---

*End of audit.*
