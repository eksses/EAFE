
EAFE-v7.1 beta Engineering Specification)
Document Standard: Production Reference Blueprint (Vanilla Physics Compliant) Target Engine: Mineflayer / Node.js (Vanilla Protocol Compliant) Physics Reference: Minecraft Java Edition Decompiled Movement Loop (LivingEntity.travel)
1. Decompiled Vanilla Physics & Kinematics Engine
To prevent server-side rubber-banding and position prediction desync, the autopilot must execute the exact 3-step velocity update loop applied by the server on every 50\text{ms} tick (20\text{ TPS}).
┌────────────────────────────────────────────────────────────────────────┐
│                   PER-TICK VELOCITY UPDATE (50ms)                      │
├────────────────────────────────────────────────────────────────────────┤
│ STEP 1: Kinetic Pitch Energy Exchange                                  │
│         ├─ If Pitch < 0 (Nose UP): Convert horizontal velocity to lift │
│         └─ If Pitch > 0 (Nose DOWN): Convert fall speed to thrust      │
│                                                                        │
│ STEP 2: Impulse, Gravity & Base Lift Addition                          │
│         ├─ Add Rocket Thrust Impulse (a_boost)                         │
│         ├─ Subtract Gravity (g = 0.08)                                 │
│         └─ Add Passive Wing Lift (cos²(pitch) * 0.06)                  │
│                                                                        │
│ STEP 3: Axis-Decoupled Drag Scaling                                    │
│         ├─ Horizontal Vector (X, Z) * 0.99                             │
│         └─ Vertical Vector (Y) * 0.98                                  │
└────────────────────────────────────────────────────────────────────────┘
1.1 Step 1: Kinetic Pitch Energy Exchange Formula
Let \phi be the camera pitch angle in radians (\phi < 0 is nose UP, \phi > 0 is nose DOWN), and v_h = \sqrt{v_x^2 + v_z^2} be the horizontal speed.
Scenario A: Pitching Nose-UP (\phi < 0)
Horizontal momentum is converted into vertical climbing momentum:
\Delta v_y = v_h \cdot (-\sin\phi) \cdot 0.04 \Delta v_x = -v_x \cdot (-\sin\phi) \cdot 0.04 \Delta v_z = -v_z \cdot (-\sin\phi) \cdot 0.04
Scenario B: Diving Nose-DOWN (\phi > 0 and v_y < 0)
Gravitational downward falling speed is converted into horizontal forward thrust:
\Delta v_x = \left(\frac{v_x}{v_h}\right) \cdot (-v_y) \cdot \cos^2\phi \cdot 0.1 \Delta v_z = \left(\frac{v_z}{v_h}\right) \cdot (-v_y) \cdot \cos^2\phi \cdot 0.1 \Delta v_y = 0
1.2 Step 2: Rocket Impulse, Gravity & Base Lift
Combine current velocity \vec{v}, pitch exchange delta \vec{\Delta v}, firework boost impulse \vec{a}_{\text{boost}}, base gravity (0.08), and passive wing lift (\cos^2\phi \cdot 0.06):
v_x' = v_x + \Delta v_x + a_{\text{boost}, x} v_z' = v_z + \Delta v_z + a_{\text{boost}, z} v_y' = v_y + \Delta v_y - 0.08 + (\cos^2\phi \cdot 0.06) + a_{\text{boost}, y}
1.3 Step 3: Axis-Decoupled Drag Scaling
Apply axis-decoupled drag multipliers to produce the final tick velocity vector \vec{v}_{t+1}:
v_{x, t+1} = v_x' \cdot 0.99 v_{z, t+1} = v_z' \cdot 0.99 v_{y, t+1} = v_y' \cdot 0.98
Critical Distinction: Horizontal drag (D_h = 0.99) and vertical drag (D_v = 0.98) are non-identical. Unified 0.99 drag assumptions accumulate vertical position drift over long distances.
2. Navigation Vectors & Fuel Calculation
2.1 Target Angle Calculations
Given bot position \mathbf{P}_b = (x_b, y_b, z_b) and target position \mathbf{P}_t = (x_t, y_t, z_t):
\text{2D Horizontal Distance } (d_{2D}) = \sqrt{(x_t - x_b)^2 + (z_t - z_b)^2} \text{Target Yaw } (\theta) = \operatorname{atan2}(-(x_t - x_b), z_t - z_b) \text{Target Pitch } (\phi) = \operatorname{atan2}(y_t - y_b, d_{2D})
Convention Note: In Mineflayer, pitch \phi = -1.57 \text{ rad} is straight UP, \phi = 0 \text{ rad} is horizontal, and \phi = +1.57 \text{ rad} is straight DOWN.
2.2 Fuel Requirement Equation
Total duration-1 fireworks required (N_{\text{rockets}}) before approving launch:
N_{\text{rockets}} = \left\lceil \frac{d_{2D}}{68.5} \right\rceil + \left\lceil \frac{\vert{}Y_{\text{cruise}} - Y_{\text{start}}\vert{}}{28.0} \right\rceil + 15
Where 15 represents the mandatory safety buffer reserved for landing re-routes and emergency climbs.
3. Ground Takeoff Mechanics & Spatial Envelope
3.1 The 150ms Jump Apex Rule
Vanilla servers reject the START_FALL_FLYING client packet if received while the entity bounding box touches the ground (onGround === true).
  Tick 0: Jump Triggered       Tick 3-4 (150ms-200ms)          Tick 7+: Falling
  onGround = true               onGround = false (Apex)         Velocity dropping
  ❌ PACKET REJECTED            ✅ OPTIMAL PACKET WINDOW        ⚠️ STALL / DANGEROUS
1. Tick 0: Execute sprint = true, forward = true, jump = true.
2. Tick 3–4 (150ms–200ms delay): Entity reaches vertical jump apex (v_y \approx 0, \text{onGround} = \text{false}). Release jump.
3. Tick 4: Send START_FALL_FLYING packet (bot.elytraFly()).
4. Tick 5: Pitch camera up to \phi = -0.52 \text{ rad} (\approx -30^\circ) and fire rocket #1.
3.2 3D Spatial Envelope Pre-Flight Check
Takeoff is prohibited unless the surrounding block volume passes a three-zone scan:
Scan Zone	Dimension Bound	Required Block Type
Overhead Column	1 \times 1 \times 5 blocks (Y+1 \rightarrow Y+5)	air / cave_air
Forward Runway	1 \times 2 \times 4 blocks along departure Yaw	air / cave_air
Lateral Spacing	3 \times 2 \times 1 blocks at shoulder height	air / cave_air
Failure Protocol: If any clearance scan fails, abort takeoff and pathfind on foot to open ground.
4. Chunk Streaming, Network Sync & Hysteresis Logic
4.1 Chunk Loading "Wall of Death" Mitigation
Flying into unloaded chunks causes position freezing and packet drops. The bot projects its velocity vector 30 blocks ahead to verify chunk load status.
To prevent rapid toggling between cruising and stalling at chunk boundaries, state transitions use Hysteresis Thresholds:
                  ┌─────────────────────────────────────────┐
                  │ Evaluate Unloaded Chunks 30m Ahead (R) │
                  └────────────────────┬────────────────────┘
                                       │
                  ┌────────────────────┴────────────────────┐
                  │        State Machine Check              │
                  └────────────────────┬────────────────────┘
                                       │
           ┌───────────────────────────┴───────────────────────────┐
     [ In CRUISE Mode? ]                                 [ In STALL_ORBIT Mode? ]
           │                                                       │
  [ Is R < 10 Chunks? ]                                   [ Is R ≥ 16 Chunks? ]
     /           \                                           /           \
   YES            NO                                       YES            NO
   /               \                                       /               \
Enter           Maintain                                 Exit            Maintain
STALL_ORBIT     CRUISE                                   STALL_ORBIT     STALL_ORBIT
* STALL_ORBIT Protocol: Cease firework activations, pitch UP to +0.3 \text{ rad} (\approx +17^\circ), and bank in a 20\text{m} radius orbit over loaded terrain until chunk availability \ge 16.
4.2 TPS Desync Protection
* Monitor: Track server keep-alive packet frequency.
* Action: If calculated server TPS drops below 12.0, freeze rocket activations. Allow kinetic gliding until server tick frequency normalizes.
5. Dimension Corridors & Nether Hazard Index
5.1 Dimension Flight Altitudes
Dimension	Safe Cruise Corridor (Y)	Primary Risk Mitigation
Overworld	Y = 280 - 320	Sits above player entity render bubble (128\text{m}).
Nether Roof	Y = 180 - 240	Flies in open space above bedrock ceiling (Y = 128).
Nether Caves	Restricted / Low Altitude	Subject to Hazard Index Calculation + Operator Intercept.
The End	Y = 120 - 160	Avoids obsidian towers while maintaining clearance over void.
5.2 Nether Under-Roof Hazard Index Algorithm
When instructed to fly in the Nether below bedrock ceiling (Y < 128), the bot calculates the Corridor Hazard Index (H) before launching:
H = \left( \frac{N_{\text{lava}} + 2 \cdot N_{\text{obstacle}}}{N_{\text{scanned}}} \right) \times 100\%
Where:
* N_{\text{lava}} = Surface blocks along the flight corridor consisting of liquid lava.
* N_{\text{obstacle}} = Solid blocks intersecting a 5-block clearance corridor along the vector.
* N_{\text{scanned}} = Total evaluated blocks along the trajectory.
Permission Threshold: If H > 30\%, flight is suspended. The bot issues a warning to chat/console and waits 30 seconds for operator confirmation (confirm) before launching.
6. Air-Braking, Surface Classifier & Touchdown
                   CRUISE PHASE (Speed ~30 m/s)
         ═════════════════════════════════════════┐
                                                  │ Enter 60m Arrival Zone
                                                  ▼
                                       ┌──────────────────────┐
                                       │  SPIRAL AIR-BRAKING  │
                                       │  Radius: 15-20m      │
                                       │  Pitch: +0.25 rad    │
                                       └──────────┬───────────┘
                                                  │ Speed < 8 m/s
                                                  ▼
                                       ┌──────────────────────┐
                                       │ SURFACE VALIDATION   │
                                       │ Raycast Below        │
                                       └──────────┬───────────┘
                                                  │
                                   ┌──────────────┴──────────────┐
                                   │ Is Surface Safe Solid Block?│
                                   └──────────────┬──────────────┘
                                                  │
                        ┌─────────────────────────┴─────────────────────────┐
                       YES                                                 NO
                        │                                                   │
           ┌────────────┴───────────┐                          ┌────────────┴───────────┐
           │ SOFT FLARE TOUCHDOWN   │                          │ SPIRAL RADIAL SEARCH   │
           │ Pitch: +0.10 rad       │                          │ Re-route to Safe Block │
           └────────────────────────┘                          └────────────────────────┘
6.1 Surface Classifier Matrix
* Blacklisted Surfaces: water, lava, air, fire, magma_block, cactus, sweet_berry_bush, powder_snow, cobweb.
* Whitelisted Surfaces: grass_block, dirt, stone, cobblestone, obsidian, netherrack, end_stone, planks, concrete.
6.2 Archimedean Spiral Landing Re-routing
If target landing coordinates reside over a blacklisted surface, execute an expanding 2D spiral search (R = 1 \rightarrow 25 \text{ blocks}) to locate a safe landing pad:
x_{\text{search}}(\theta) = x_{\text{target}} + (a + b \cdot \theta) \cos(\theta) z_{\text{search}}(\theta) = z_{\text{target}} + (a + b \cdot \theta) \sin(\theta)
Where a = 1.0 and b = 0.5. Lock onto the first whitelisted block with 2 blocks of clear head-space above it.
6.3 Soft Flare Touchdown
When Y_{\text{bot}} \le Y_{\text{ground}} + 8 \text{ blocks}:
1. Pitch is pulled up to \phi = -0.10 \text{ rad} (Nose UP).
2. Vertical downward speed drops below 0.2 \text{ blocks/tick} for a zero-damage touchdown.
7. State Machine (FSM) & Fail-Safe Recovery Matrix
7.1 Finite State Machine Transitions
State Name	Primary Action	Exit Condition	Next State
IDLE	Standby; audit gear and spatial bounds.	Command received & audit pass.	TAKEOFF
TAKEOFF	Execute 150ms apex jump + wing packet.	elytraFlying === true.	STEEP_CLIMB
STEEP_CLIMB	Pitch -0.65\text{ rad}, activate firework.	Y_{\text{bot}} \ge Y_{\text{cruise}}.	CRUISE
CRUISE	Flat pitch -0.02\text{ rad}, speed regulate.	d_{2D} \le 60\text{m} to target.	DESCENT_SPIRAL
STALL_ORBIT	Cease rockets, pitch +0.3\text{ rad}, bank.	Chunk load ahead \ge 16.	CRUISE
DESCENT_SPIRAL	Air-brake orbit, scan landing surface.	Y_{\text{bot}} \le Y_{\text{ground}} + 8\text{m}.	TOUCHDOWN
TOUCHDOWN	Nose UP flare \phi = -0.10\text{ rad}, clear inputs.	v_y = 0, onGround === true.	IDLE
RECOVERY	Mid-air packet re-issue or emergency launch.	Flight restored \rightarrow CRUISE; Ground reached \rightarrow TAKEOFF	
7.2 Real-Time Fail-Safe Matrix
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                   FAIL-SAFE MATRIX                                     │
├──────────────────────┬──────────────────────────────────┬──────────────────────────────┤
│ Risk Event           │ Detection Trigger                │ Automated Recovery Protocol  │
├──────────────────────┼──────────────────────────────────┼──────────────────────────────┤
│ Explosive Fireworks  │ NBT contains Explosions tag.     │ Quarantine item; refuse slot.│
│ Low Elytra Health    │ Durability points ≤ 15.          │ Hot-swap spare in 1 tick.    │
│ Mid-Air Packet Drop  │ Y > 50 AND elytraFlying == false │ Re-issue elytraFly() packet. │
│ Wall Collision       │ Speed < 0.1 m/s while flying.    │ Pitch UP -0.8 rad + rocket.  │
│ Out of Fireworks     │ Rocket count == 0.               │ Dead-stick optimum glide.    │
└──────────────────────┴──────────────────────────────────┴──────────────────────────────┘
