/*
 * config.js — every tunable in Orbs.
 *
 * This file is the tuning surface. sim.js and main.js read numbers from here and
 * hard-code nothing, so a future session is just hand-editing this file.
 *
 * UNITS
 *   Distance : CSS pixels, measured at the reference dimension (world.referenceDim).
 *              Anything marked "@ref" is multiplied by sim.scale at runtime so an
 *              iPhone SE and an iPad feel identical.
 *   Time     : seconds.
 *   Speed    : px/s @ref.   Acceleration: px/s^2 @ref.
 *   Damping  : per-second exponential rate; v *= exp(-rate * dt).
 *
 * Scaling rule: positions and accelerations both scale linearly with sim.scale,
 * which leaves trajectory *timing* invariant across screen sizes. Rates (1/s) and
 * dimensionless gains are never scaled.
 */

export const CONFIG = {

  /* ---------------------------------------------------------------- world -- */
  world: {
    referenceDim: 390,        // px. Reference for min(width,height); scale = min(w,h)/this. iPhone-ish.
    gravityY: 3,              // px/s^2 @ref. "Near-zero" downward bias; set 0 for true weightlessness.
    gravityX: 0,              // px/s^2 @ref. Lateral bias. Normally 0.
    drag: 0.34,               // 1/s. Linear velocity damping. Higher = balls settle sooner.
    dragFrenzyScale: 0.72,    // Multiplier on drag at full FRENZY, so chaos stays lively a bit longer.
    idleDriftStrength: 20,    // px/s^2 @ref. Wandering force that keeps an untouched screen alive.
                              // Kept well below the level where drift alone can manufacture a HARD
                              // impact — otherwise an untouched screen quietly scores forever.
                              // Tests zero this out to check the integrator does not pump energy.
    idleDriftRateA: 0.19,     // 1/s. Frequency of the slow drift lobe (per-ball phase offsets).
    idleDriftRateB: 0.41,     // 1/s. Frequency of the faster drift lobe.
    idleDriftSpaceA: 0.0042,  // 1/px. Spatial frequency of the drift field (large, lazy cells).
    idleDriftSpaceB: 0.0091,  // 1/px. Spatial frequency of the finer drift lobe.
    idleDriftCalmBoost: 1.25, // Drift multiplier when fully CALM, so a quiet screen still breathes.
    idleDriftLobeB: 0.6,      // Amplitude of the second (faster, finer) drift lobe, relative to the first.
    idleDriftGain: 0.7,       // Overall gain on the summed drift lobes. Shapes how wandery it looks.
    speedClamp: 1250,         // px/s @ref. Hard velocity ceiling. Nothing ever exceeds this.
    substeps: 2,              // Physics substeps per frame. 2 keeps fast balls from tunnelling.
    maxDt: 1 / 30,            // s. Longest dt a single step will integrate; longer frames are clipped.
    resumeDt: 1 / 60,         // s. dt forced on the first step after a pause/resume/visibility change.
    wallRestitution: 0.9,     // Bounciness against the screen edges.
    wallFriction: 0.995,      // Tangential velocity retained in a wall bounce (slight scrub).
    boundsPad: 0,             // px @ref. Inset of the play area from the true screen edge.
    escapeMargin: 110,        // px @ref. Outside the bounds by more than this = escaped; the
                              // sanitizer respawns it at an edge rather than dragging it back.
  },

  /* ------------------------------------------------------------ collision -- */
  collision: {
    restitution: 0.9,         // Ball-ball bounciness. The brief's headline feel number.
    restitutionFrenzy: 0.94,  // Restitution at full FRENZY. Slightly livelier when it is loud.
    correctionPercent: 0.42,  // Fraction of penetration resolved positionally per substep (<1, never 1).
    correctionSlop: 0.35,     // px @ref. Penetration allowed before positional correction kicks in.
                              // Slop + percent<1 is what stops positional correction adding energy.
    maxCorrection: 6,         // px @ref. Cap on a single positional correction, anti-explosion guard.
    hardImpactSpeed: 185,     // px/s @ref. Relative normal speed above which an impact is "HARD".
                              // Hard impacts score, trigger type effects, and feed the combo.
                              // Must sit comfortably above what idle drift alone can produce.
    tapFraction: 0.28,        // Fraction of hardImpactSpeed at which a collision still emits a soft
                              // 'tap' effect. Below this a contact is silent.
    hardImpactWall: 260,      // px/s @ref. Higher bar for wall hits, so edge-rattling is not a score farm.
    wallScoreScale: 0.35,     // Wall hard-hit score is scaled down; walls are not opponents.
    effectCooldown: 0.42,     // s. Per-ball lockout after its type effect fires. Stops machine-gunning.
    scoreCooldown: 0.06,      // s. Per-ball lockout on scoring, so one contact is one score.
    gridCellScale: 2.15,      // Broadphase cell size as a multiple of the largest ball radius.
  },

  /* --------------------------------------------------------- finger field -- */
  // Every pointer is an independent field. Push by default; morphs to an attractor
  // when held nearly still. Released fields sling whatever they gathered.
  field: {
    radius: 118,              // px @ref. Push reach. The attractor's reach is a separate knob,
                              // gather.radiusGather — see the note there.
    strength: 2750,           // px/s^2 @ref. Peak outward push at the field centre.
    falloffExp: 2.0,          // Exponent on (1 - t^2)^n falloff, t = dist/radius. Higher = tighter core.
    minDist: 7,               // px @ref. Distance floor so the centre is not a singularity.
    smoothTau: 0.055,         // s. Position smoothing time constant. THIS is the "weighty" feel.
    velTau: 0.075,            // s. Smoothing on the field's own velocity estimate.
    maxFieldSpeed: 4200,      // px/s @ref. Clamp on the measured finger speed (guards teleporting pointers).
    flingGain: 8.4,           // 1/s. Acceleration imparted along the field's motion. Makes swipes fling.
    flingFalloffExp: 1.35,    // Exponent on the fling falloff; flatter than the push so swipes reach wider.
    swirl: 0.26,             // Tangential fraction of the push force. A little curl reads as "alive".
    swirlSign: 1,             // +1 / -1. Handedness of the swirl.
    pressRampTime: 0.09,      // s. Fade-in of a brand-new field, so a tap does not detonate the screen.
    releaseFade: 0.12,        // s. Fade-out after release, so lifting a finger is not a hard cut.
    massFalloff: 0.55,        // How much a ball's mass resists the field. 0 = mass-independent, 1 = full F=ma.
  },

  /* ----------------------------------------------------- gather and sling -- */
  gather: {
    radiusGather: 220,        // px @ref. Reach once fully morphed into an attractor. Deliberately
                              // MUCH wider than field.radius: the push evacuates its own
                              // neighbourhood, so a same-size attractor would have nothing left
                              // to gather. Reaching past that hole is what makes gather work.
                              // Measured: this catches ~51% of the population on a 390px screen
                              // (44 gathered, 42 left), so there is still a real crowd to sling
                              // the orbit INTO. 250 catches 60%, 190 catches 44%.
                              // NOTE: this key must live in `gather`, not `field` — sim.js reads
                              // C.gather.radiusGather. It sat under `field` once, so the lookup
                              // was undefined, `d < NaN` was always false, and the attractor
                              // silently applied no force at all while still LOOKING alive
                              // (the ring drew, the morph animated, the sling still threw
                              // whatever happened to be nearby). See the gather tests.
    stillSpeed: 130,          // px/s @ref. Field speed below which the finger counts as "held still".
    stillTime: 0.18,          // s. How long it must stay still before the morph starts. Long
                              // enough not to trigger on a pause mid-swipe.
    morphIn: 0.55,            // s. Time to fully become an attractor.
    morphOut: 0.22,           // s. Time to fall back to push once the finger moves again.
    // These four are coupled. A ball orbiting at tangential speed v needs centripetal
    // acceleration v^2/d, which the spring supplies as orbitSpring*(d - orbitRadius). The
    // orbit therefore settles NOT at orbitRadius but where those balance:
    //     d = (k*r0 + sqrt(k^2*r0^2 + 4*k*v^2)) / (2k)
    // With the old values (k=21, v=430) that was ~120px against a 46px nominal shell, so the
    // balls orbited far outside the ring drawn for them. main.js draws the ring at the solved
    // radius, so retuning any of these keeps the visual honest.
    orbitRadius: 50,          // px @ref. Nominal shell radius (the spring's zero point).
    orbitSpring: 110,         // 1/s^2. Radial spring toward the shell. Stiff enough to actually
                              // hold an orbit at the speed orbitSpin asks for.
    orbitDamp: 6.5,           // 1/s. Damping on radial velocity. Underdamped on purpose: the
                              // slight bob in and out is what makes the orbit look alive.
    orbitSpin: 300,           // px/s @ref. Tangential speed injected; this is what makes it *orbit*.
    orbitSpinGain: 3.4,       // 1/s. How hard tangential velocity is driven toward orbitSpin.
    spinRampTime: 0.5,        // s. Time for the spin to reach full strength after the morph.
    pull: 1900,               // px/s^2 @ref. Ceiling on the inward pull. The spring is clamped to
                              // this, which turns it into a near-constant haul at long range and a
                              // proper shell spring up close.
    pushOutCap: 0.5,          // Outward spring force inside the shell, as a fraction of `pull`.
    captureRadius: 175,       // px @ref. Balls inside this at release are considered "in the orbit".
    maxCapture: 72,           // Ceiling on balls a single sling can throw. Kept comfortably above
                              // what radiusGather actually gathers, so a release throws the WHOLE
                              // orbit rather than an arbitrary subset of it. The sling loop is
                              // O(n) over captured balls, so this is cheap.

    slingBase: 620,           // px/s @ref. Base speed added to every slung ball.
    slingPerBall: 5.2,        // px/s @ref added per additional captured ball. Big orbits hit harder.
    slingSpin: 0.55,          // Fraction of orbital tangential velocity retained through the sling.
    slingSpread: 0.34,        // Radians of random cone spread around the sling direction.
    flickSpeed: 290,          // px/s @ref. Release speed above which the sling follows the flick.
    flickGain: 1.15,          // Multiplier on flick velocity folded into the sling.
    slingChargeMax: 2.6,      // s. Hold time at which sling power saturates.
    slingChargeGain: 0.75,    // Extra sling power at full charge (0.75 = +75%).
    minSlingGather: 0.06,     // Gather amount below which a release is just a lift, not a sling.
    slingComboGrace: 0.9,     // s. Combo timer floor granted after a sling, so the payoff can land.
  },

  /* ---------------------------------------------------------------- charge -- */
  // WHY THIS EXISTS: a detonation throws balls far above the hard-impact threshold, which
  // detonates more volatiles, forever. Left alone the screen never calms down and the
  // combo climbs into the tens of thousands untouched — the exact opposite of the CALM /
  // FRENZY contrast this thing is built around.
  //
  // So type effects only fire on balls carrying "charge": energy that can be traced back
  // to a finger. Touching a ball charges it; a hard impact passes a fraction of the charge
  // on; each effect passes a fraction to whatever it catches. A cascade therefore runs
  // maybe eight hops and dies, which is gloriously loud and then genuinely over.
  // Scoring is NOT gated — a hard impact is a hard impact. Only effects are.
  charge: {
    fieldTime: 1.4,           // s of charge granted to any ball a live field is touching.
    slingTime: 2.8,           // s granted to every ball thrown by a sling. Slings start cascades.
    impactTransfer: 0.72,     // Fraction of the charge passed along by a hard impact.
    effectTransfer: 0.8,      // Fraction passed to every ball an effect catches.
    minTransfer: 0.16,        // s. Below this the chain is over and the charge drops to zero.
    untouchedDecay: 2.6,      // Charge bleeds this much faster once the screen has been untouched
                              // for `untouchedGrace`. Charge means "energy traceable to a finger",
                              // so with no finger it should be going away — otherwise the toy keeps
                              // detonating itself long into what is supposed to be silence.
    untouchedGrace: 3.0,      // s after the last touch during which charge decays at the normal
                              // rate. This is the sling's payoff window: you throw an orbit into
                              // the crowd and lift your finger, and the cascade you just paid for
                              // has to be allowed to land in full. Only after that does the world
                              // start actively forgetting.
  },

  /* ------------------------------------------------------------ population -- */
  population: {
    startCount: 30,           // Balls present on a brand-new save. Deliberately sparse: the
                              // screen should feel roomy at level 1 and crowded at level 100.
    softCapBase: 30,          // Target population at level 1. Raised ONLY by 'MORE ORBS'
                              // upgrades — TEN of them, +6 each. The soft cap also nudges up
                              // 1.6 per level past level 8, and the two together reach the hard
                              // cap of 150 at level 46. There used to be twenty MORE ORBS; the
                              // ten after level 46 raised a number that was already pinned
                              // behind the clamp and changed nothing on screen at all.
                              // rather than an invisible drift.
    softCapPerLevel: 0,       // No automatic per-level growth; see softCapBase above.
    hardCap: 150,             // Absolute ceiling. Splitters may never push the count past this.
    unlockBurst: 5,           // Balls of a newly unlocked type made by RETYPING existing ORBs the
                              // moment it unlocks. Never spawned: no ball enters or leaves, so no
                              // energy enters the world and an untouched screen still goes quiet.
                              // Without this, levels 2..8 announced seven ball types and put none
                              // of them on screen — three of them never appeared at all.
    unlockBurstSpread: 0.35,  // s between conversions, so they arrive as a sequence you can follow
                              // with your eyes rather than a single frame where five things change.
    convertMaxFrac: 0.2,      // Hard ceiling: never retype more than this fraction of the live
                              // population, however many an upgrade asks for.
    convertPulse: 0.6,        // Render-only pulse given to a ball at the moment it changes type.
    respawnDelay: 0.22,       // s. Gap between a despawn and the matching fade-in respawn.
    spawnFade: 0.9,           // s. Fade-in time for a new ball (also its collision ramp).
    despawnFade: 0.75,        // s. Fade-out time for a quiet edge despawn.
    despawnMargin: 34,        // px @ref. Only balls this close to an edge are eligible to despawn.
    despawnMaxSpeed: 70,      // px/s @ref. Only slow balls despawn, so nothing vanishes mid-flight.
    despawnInterval: 0.55,    // s. Minimum time between despawns; keeps churn invisible.
    overCapUrgency: 6,        // Over-cap count at which the despawn interval collapses to near zero.
    spawnEdgeInset: 12,       // px @ref. How far inside the edge new balls appear.
    spawnSpeed: 46,           // px/s @ref. Initial drift speed of a spawned ball.
    scatterSpeed: 210,        // px/s @ref. Speed given to balls by a two-finger triple-tap re-scatter.
    scatterFadeFloor: 0.15,   // Minimum presence a ball is given by a re-scatter, so nothing pops in.
  },

  /* ----------------------------------------------------------------- balls -- */
  balls: {
    radiusMin: 5.0,           // px @ref. Smallest naturally spawned ball.
    radiusMax: 11.5,          // px @ref. Largest naturally spawned ball.
    radiusBias: 1.7,          // Exponent on the radius roll; >1 biases toward small balls.
    minSplitRadius: 3.4,      // px @ref. A splitter below this will not split again.
    densityExp: 2,            // mass = density * r^densityExp. 2 = "area", reads right in 2D.
    density: 0.022,           // Mass per r^densityExp. Only ratios matter.
    hueVariants: 4,           // How many of the palette's orb hues a ball picks between (render only).
    glowScale: 1.9,           // Halo radius as a multiple of ball radius (render only). Bigger
                              // than ~2 and the balls stop reading as small glowing balls and
                              // start reading as one continuous wall of light.
  },

  /* ------------------------------------------------------------ ball types -- */
  // weight  : relative spawn frequency once unlocked.
  // score   : score multiplier for a hard impact involving this ball.
  // unlockLevel : level at which the type joins the spawn pool (0 = available from the start).
  types: {
    ORB: {
      weight: 100, score: 1.0, unlockLevel: 0,
      label: 'ORB',           // Shown only in the unlock celebration.
    },
    VOLATILE: {
      weight: 15, score: 2.0, unlockLevel: 2,
      label: 'VOLATILE',
      blastRadius: 108,       // px @ref. Reach of the detonation impulse.
      blastImpulse: 940,      // px/s @ref. Peak velocity change at the blast centre.
      blastFalloffExp: 1.6,   // Exponent on the blast falloff.
      inertTime: 4.0,         // s. Recharge lockout after detonating. Rendered as a visible refill.
      selfKick: 0.35,         // Fraction of the blast impulse the detonator keeps for itself.
      scoreEach: 3,           // Flat score per ball caught in the blast, before multipliers.
    },
    SPLITTER: {
      weight: 14, score: 1.6, unlockLevel: 3,
      label: 'SPLITTER',
      childRadius: 0.5,       // Child radius as a fraction of the parent's.
      splitSpeed: 235,        // px/s @ref. Separation speed given to the two children.
      splitSpread: 0.75,      // Radians of angular spread between the children.
      inheritSpeed: 0.86,     // Fraction of the parent's velocity the children inherit.
      cooldown: 0.9,          // s. Lockout before a child may split again.
      reserve: 4,             // Headroom kept below hardCap; splits stop this many below the cap.
    },
    MAGNET: {
      weight: 11, score: 1.5, unlockLevel: 4,
      label: 'MAGNET',
      pull: 32,               // px/s^2 @ref. Constant ambient attraction. Deliberately WEAK: a
                              // stronger pull can accelerate a ball past hardImpactSpeed all on
                              // its own, which turns every magnet into a perpetual scoring
                              // machine on an untouched screen. sqrt(2*pull*pullRadius) must
                              // stay well under collision.hardImpactSpeed.
      pullRadius: 108,        // px @ref. Reach of the ambient pull.
      spikePull: 9.0,         // Multiplier on pull while spiked by a hard impact. The spike is
                              // where a magnet gets to be dramatic; the ambient pull is not.
      spikeTime: 1.15,        // s. Duration of the post-impact spike.
      fieldLines: 5,          // Faint field lines drawn around a magnet (render only).
      dragAssist: 0.1,        // How strongly a magnet drags a captured ball along its own motion.
                              // This term is non-conservative (it does net work), so it is kept
                              // small — it is the mechanism behind the gold resonance, not a
                              // general-purpose energy source.
    },
    PRISM: {
      weight: 10, score: 1.8, unlockLevel: 5,
      label: 'PRISM',
      shards: 7,              // Shards emitted per hard impact.
      shardSpeed: 720,        // px/s @ref. Shard launch speed.
      shardSpeedJitter: 0.4,  // Fractional randomisation of shard speed.
      shardLife: 1.5,         // s. Shard lifetime.
      shardRadius: 2.2,       // px @ref. Shard collision radius against balls.
      shardScore: 5,          // Flat score for a shard touching a ball, before multipliers.
      shardBounces: 1,        // Wall bounces allowed before a shard expires. The brief says one.
      shardDrag: 0.22,        // 1/s. Shard damping.
      maxShards: 190,         // Hard cap on live shards; excess emissions are dropped.
      shardSpread: 6.283,     // Radians of the emission fan (2pi = full circle).
    },
    CHAIN: {
      weight: 9, score: 2.2, unlockLevel: 6,
      label: 'CHAIN',
      targets: 3,             // Balls jolted per link.
      depth: 2,               // Total links: the ball, then one more hop. "Chains once more."
      range: 175,             // px @ref. Search radius for the next jolt target.
      impulse: 330,           // px/s @ref. Velocity kick delivered by a jolt.
      scoreEach: 4,           // Flat score per jolted ball, before multipliers.
      arcTime: 0.28,          // s. Lifetime of the drawn lightning arc (render only).
      hopDelay: 0.05,         // s. Visual delay between links (render only).
    },
    FROST: {
      weight: 9, score: 1.7, unlockLevel: 7,
      label: 'FROST',
      radius: 104,            // px @ref. Freeze reach.
      maxTargets: 6,          // Balls frozen per hard impact.
      freezeTime: 1.0,        // s. Freeze duration, then they shatter free.
      frozenDrag: 7.5,        // 1/s. Heavy damping while frozen; they barely move.
      frozenRestitution: 0.55,// Frozen balls thud instead of bouncing.
      shatterImpulse: 190,    // px/s @ref. Outward pop when the freeze breaks.
      scoreEach: 3,           // Flat score per frozen ball, before multipliers.
      immuneTime: 1.6,        // s. Post-thaw immunity, so a ball cannot be chain-frozen forever.
    },
    GOLD: {
      weight: 3.43,           // ~2.0% of the pool once every type is unlocked (3.43/171.4). Rare on purpose.
      score: 26.0, unlockLevel: 8,
      label: 'GOLD',
      comboJump: 4,           // Combo steps granted by a gold hard impact.
      neverDespawn: true,     // Gold is never quietly removed by the population manager.
      glitterRate: 22,        // Glints per second (render only).
      scoreFlat: 150,         // Flat bonus on a gold hard impact, before multipliers.
    },
  },

  // Spawn order for level unlocks. Index i unlocks at types[key].unlockLevel.
  unlockOrder: ['VOLATILE', 'SPLITTER', 'MAGNET', 'PRISM', 'CHAIN', 'FROST', 'GOLD'],

  /* ----------------------------------------------------------- resonances -- */
  // Exactly three. Never explained in-game — they are for the player who notices.
  resonances: [
    {
      id: 'shatterNova',
      // A volatile detonating on/next to a FROZEN ball: the ice goes off too.
      when: 'detonate.frozen',
      radiusMul: 1.5,         // Blast radius multiplier for the nova.
      impulseMul: 1.45,       // Blast impulse multiplier.
      scoreMul: 2.0,          // Score multiplier on everything the nova touches.
      shatterAll: true,       // Every ball the nova reaches is thawed and popped.
    },
    {
      id: 'chainDetonate',
      // A chain jolt landing on a VOLATILE always detonates it, cooldown or not.
      when: 'chain.volatile',
      ignoreCooldown: true,   // Bypasses the per-ball effect cooldown.
      scoreMul: 1.5,          // Score multiplier for the forced detonation.
    },
    {
      id: 'magnetGold',
      // A MAGNET dragging GOLD into a hard impact: that hit scores double.
      when: 'magnet.gold',
      dragWindow: 0.85,       // s. How recently the magnet must have been pulling the gold.
      scoreMul: 2.0,          // The brief's "scores double".
    },
  ],

  /* --------------------------------------------------------------- scoring -- */
  score: {
    energyScale: 10,          // Score per unit of normalised impact energy. The master score knob.
    refSpeed: 300,            // px/s @ref. Impact speed that counts as "1 unit" of energy. Sets the
                              // whole score economy: energy is (vn/refSpeed)^2 * (massRatio).
    energyExp: 0.86,          // Exponent on impact energy; <1 keeps huge hits from dwarfing everything.
    minHit: 1,                // Minimum score a hard impact can award.
    globalMultBase: 1.0,      // Global multiplier at level 1.
    globalMultPerLevel: 0.055,// Added to the global multiplier per level past the last unlock.
    comboWindow: 2.5,         // s. Quiet time before the combo decays. The brief's ~2.5s.
    comboDecayStep: 0.55,     // s. Interval between decay ticks once the window has lapsed.
    comboDecayFrac: 0.12,     // Fraction of the REMAINING combo shed per tick (minimum one step).
                              // A flat one-per-tick would take an hour to unwind a 7000 combo;
                              // proportional decay unwinds any size in about the same wall time.
    comboMultScale: 0.55,     // Coefficient in mult = 1 + scale * count^exp.
    comboMultExp: 0.34,       // Sublinear growth exponent. Uncapped, but deliberately shallow:
                              // a busy screen lands a hard impact almost every frame, so the
                              // combo climbs into five figures during a long rally. At 0.62 that
                              // compounded into billions of points a minute and levels flew past
                              // faster than the unlock celebrations could play.
    comboStepPerHit: 1,       // Combo steps per hard impact.
    comboMaxPerStep: 1,       // Ceiling on combo growth per simulation step. The combo counts
                              // moments of contact, not individual collisions — a cascade fires
                              // hundreds of hard impacts per second, and tallying each one turned
                              // the combo into a five-figure collision counter. GOLD's jump is
                              // exempt from this cap.
    popupMinScore: 1,         // Smallest score that spawns a floating popup.
    popupMerge: 0.09,         // s. Popups at nearly the same spot inside this window merge.
    rollTau: 0.16,            // s. Counter roll time constant. The counter never snaps.
    rollSnapBelow: 0.5,       // Difference below which the rolling counter finally lands.
  },

  /* ---------------------------------------------------------------- levels -- */
  levels: {
    // XP needed to leave each level, as ANCHOR POINTS with power-law interpolation between
    // them (see levelThreshold in sim.js). A single base*n^exp formula cannot fit the real
    // shape: earnings sit almost flat through the early levels (few balls, few ball types)
    // and then climb steeply once the population and the multipliers open up. Fitting one
    // curve to both made the first ten levels either trivial or a wall.
    //
    // These were MEASURED, not guessed: a simulated engaged player was run for an hour with
    // levels forced to advance linearly, the score earned inside each level band recorded,
    // and the result made monotonic by isotonic regression. Cumulative XP over levels 1-99
    // lands within 0.2% of what that player actually earned in the hour.
    //
    // To re-pace the game, move these numbers. Bigger = slower. Past the last anchor the
    // final segment's exponent continues, so play never runs out of curve.
    // Scaled to 0.72 of the raw measurement: with the real level loop, upgrades arrive
    // later than the forced-linear pace assumed, and the lag compounds.
    // Level 1 is set below the fitted value on purpose: with the population starting at 30
    // the opening is quieter, and the first ball type should still arrive inside ~15s.
    curve: [
      [1, 8468], [2, 32764], [3, 48878], [5, 49664], [8, 50465], [12, 191050],
      [18, 1145940], [26, 6326778], [36, 18636561], [50, 40219966], [68, 76303876],
      [85, 177124289], [99, 226008873],
    ],
    cap: 100,                 // Level cap. Play continues past it, but the level stops rising
                              // and a one-time grand celebration fires on arrival.
    capCelebrateTime: 7.0,    // s. Length of the level-100 arrival display.
    maxCelebrated: 100,       // Levels above this celebrate quietly.
    capNudgeStart: 8,         // Level at which each level-up starts nudging the ball soft cap upward.
    capNudgePerLevel: 1.6,    // Soft-cap increase per level past capNudgeStart.
    unlockCelebrateTime: 2.4, // s. Length of a type-unlock celebration.
    levelCelebrateTime: 1.1,  // s. Length of an ordinary level-up flourish.
  },


  /* -------------------------------------------------------------- upgrades -- */
  // ONE named upgrade per level, 2..100. Every level-up hands the player something with a
  // name, and most of them are visible on screen rather than a number going up somewhere.
  //
  // Each entry is applied by mutating the sim's OWN config copy (createSim deep-clones what
  // it is given), so an upgrade automatically reaches physics and rendering alike without
  // any code needing to know it exists. On load, every upgrade up to the saved level is
  // re-applied in order.
  //
  //   kind 'type'    unlock a ball type          kind 'palette' unlock a colour world
  //   kind 'stat'    population / score numbers  kind 'mod'     retune an existing ball type
  //   kind 'gesture' retune push / gather / tap  kind 'visual'  purely how it looks
  //
  // op is one of: mul (multiply), add (add), set (assign).
  upgrades: [
    { level: 2, id: 'type.VOLATILE', kind: 'type', type: 'VOLATILE', label: 'VOLATILE', note: 'A new kind of ball joins the mix.' },
      // A new kind of ball joins the mix.
    { level: 3, id: 'type.SPLITTER', kind: 'type', type: 'SPLITTER', label: 'SPLITTER', note: 'A new kind of ball joins the mix.' },
      // A new kind of ball joins the mix.
    { level: 4, id: 'type.MAGNET', kind: 'type', type: 'MAGNET', label: 'MAGNET', note: 'A new kind of ball joins the mix.' },
      // A new kind of ball joins the mix.
    { level: 5, id: 'type.PRISM', kind: 'type', type: 'PRISM', label: 'PRISM', note: 'A new kind of ball joins the mix.' },
      // A new kind of ball joins the mix.
    { level: 6, id: 'type.CHAIN', kind: 'type', type: 'CHAIN', label: 'CHAIN', note: 'A new kind of ball joins the mix.' },
      // A new kind of ball joins the mix.
    { level: 7, id: 'type.FROST', kind: 'type', type: 'FROST', label: 'FROST', note: 'A new kind of ball joins the mix.' },
      // A new kind of ball joins the mix.
    { level: 8, id: 'type.GOLD', kind: 'type', type: 'GOLD', label: 'GOLD', note: 'A new kind of ball joins the mix.' },
      // A new kind of ball joins the mix.
    { level: 9, id: 'palette.1', kind: 'palette', label: 'DEEP SEA', note: 'A new colour world, unlocked forever.' },
      // A new colour world, unlocked forever. The label is the world's own name: "NEW SKY"
      // eleven times told you nothing about which sky you had just been given.
    { level: 10, id: 'cap.10', kind: 'stat', path: 'population.softCapBase', add: 6, label: 'MORE ORBS', note: 'Six more balls on screen.' },
      // Six more balls on screen.
    { level: 11, id: 'types.VOLATILE.blastRadius.11', kind: 'mod', path: 'types.VOLATILE.blastRadius', mul: 1.18, label: 'WIDER BLAST', note: 'Volatile detonations reach further.' },
      // Volatile detonations reach further.
    { level: 12, id: 'render.trailFade.12', kind: 'visual', path: 'render.trailFade', mul: 0.86, label: 'LONG TRAILS', note: 'Motion leaves longer streaks.' },
      // Motion leaves longer streaks.
    { level: 13, id: 'cap.13', kind: 'stat', path: 'population.softCapBase', add: 6, label: 'MORE ORBS', note: 'Six more balls on screen.' },
      // Six more balls on screen.
    { level: 14, id: 'types.VOLATILE.blastImpulse.14', kind: 'mod', path: 'types.VOLATILE.blastImpulse', mul: 1.2, label: 'HARDER BLAST', note: 'Detonations shove harder.' },
      // Detonations shove harder.
    { level: 15, id: 'palette.2', kind: 'palette', label: 'AURORA', note: 'A new colour world, unlocked forever.' },
      // A new colour world, unlocked forever. The label is the world's own name: "NEW SKY"
      // eleven times told you nothing about which sky you had just been given.
    { level: 16, id: 'tap.pulseRadius.16', kind: 'gesture', path: 'tap.pulseRadius', mul: 1.22, label: 'WIDE PULSE', note: 'Your tap pulse reaches further.' },
      // Your tap pulse reaches further.
    { level: 17, id: 'cap.17', kind: 'stat', path: 'population.softCapBase', add: 6, label: 'MORE ORBS', note: 'Six more balls on screen.' },
      // Six more balls on screen.
    { level: 18, id: 'render.bloomStrength.18', kind: 'visual', path: 'render.bloomStrength', mul: 1.15, label: 'BRIGHTER BLOOM', note: 'Everything glows harder.' },
      // Everything glows harder.
    { level: 19, id: 'types.VOLATILE.inertTime.19', kind: 'mod', path: 'types.VOLATILE.inertTime', mul: 0.78, label: 'FAST RECHARGE', note: 'Volatiles come back online sooner.' },
      // Volatiles come back online sooner.
    { level: 20, id: 'cap.20', kind: 'stat', path: 'population.softCapBase', add: 6, label: 'MORE ORBS', note: 'Six more balls on screen.' },
      // Six more balls on screen.
    { level: 21, id: 'palette.3', kind: 'palette', label: 'SYNTHWAVE', note: 'A new colour world, unlocked forever.' },
      // A new colour world, unlocked forever. The label is the world's own name: "NEW SKY"
      // eleven times told you nothing about which sky you had just been given.
    { level: 22, id: 'score.globalMultBase.22', kind: 'score', path: 'score.globalMultBase', add: 0.15, label: 'VALUE +', note: 'Everything scores more.' },
      // Everything scores more.
    { level: 23, id: 'types.VOLATILE.blastRadius.23', kind: 'mod', path: 'types.VOLATILE.blastRadius', mul: 1.15, label: 'WIDER BLAST II', note: 'Wider still.' },
      // Wider still.
    { level: 24, id: 'cap.24', kind: 'stat', path: 'population.softCapBase', add: 6, label: 'MORE ORBS', note: 'Six more balls on screen.' },
      // Six more balls on screen.
    { level: 25, id: 'balls.glowScale.25', kind: 'visual', path: 'balls.glowScale', mul: 1.1, label: 'BIGGER HALOS', note: 'Orbs carry a wider halo.' },
      // Orbs carry a wider halo.
    { level: 26, id: 'types.SPLITTER.splitSpeed.26', kind: 'mod', path: 'types.SPLITTER.splitSpeed', mul: 1.25, label: 'SHARP SPLIT', note: 'Children fly apart faster.' },
      // Children fly apart faster.
    { level: 27, id: 'cap.27', kind: 'stat', path: 'population.softCapBase', add: 6, label: 'MORE ORBS', note: 'Six more balls on screen.' },
      // Six more balls on screen.
    { level: 28, id: 'palette.4', kind: 'palette', label: 'MONOCHROME', note: 'A new colour world, unlocked forever.' },
      // A new colour world, unlocked forever. The label is the world's own name: "NEW SKY"
      // eleven times told you nothing about which sky you had just been given.
    { level: 29, id: 'tap.pulseImpulse.29', kind: 'gesture', path: 'tap.pulseImpulse', mul: 1.25, label: 'HARD PULSE', note: 'Your tap pulse shoves harder.' },
      // Your tap pulse shoves harder.
    { level: 30, id: 'effects.impactSparks.30', kind: 'visual', path: 'effects.impactSparks', add: 4, label: 'MORE SPARKS', note: 'Impacts throw more sparks.' },
      // Impacts throw more sparks.
    { level: 31, id: 'cap.31', kind: 'stat', path: 'population.softCapBase', add: 6, label: 'MORE ORBS', note: 'Six more balls on screen.' },
      // Six more balls on screen.
    { level: 32, id: 'types.SPLITTER.cooldown.32', kind: 'mod', path: 'types.SPLITTER.cooldown', mul: 0.7, label: 'RAPID SPLIT', note: 'Children can split again sooner.' },
      // Children can split again sooner.
    { level: 33, id: 'score.globalMultBase.33', kind: 'score', path: 'score.globalMultBase', add: 0.2, label: 'VALUE ++', note: 'Everything scores more again.' },
      // Everything scores more again.
    { level: 34, id: 'types.SPLITTER.childRadius.34', kind: 'mod', path: 'types.SPLITTER.childRadius', mul: 1.12, label: 'FAT CHILDREN', note: 'Split children keep more size.' },
      // Split children keep more size.
    { level: 35, id: 'cap.35', kind: 'stat', path: 'population.softCapBase', add: 6, label: 'MORE ORBS', note: 'Six more balls on screen.' },
      // Six more balls on screen.
    { level: 36, id: 'palette.5', kind: 'palette', label: 'SOLAR', note: 'A new colour world, unlocked forever.' },
      // A new colour world, unlocked forever. The label is the world's own name: "NEW SKY"
      // eleven times told you nothing about which sky you had just been given.
    { level: 37, id: 'render.trailFadeCalm.37', kind: 'visual', path: 'render.trailFadeCalm', mul: 0.82, label: 'CALM TRAILS', note: 'Quiet moments hold their streaks.' },
      // Quiet moments hold their streaks.
    { level: 38, id: 'types.SPLITTER.inheritSpeed.38', kind: 'mod', path: 'types.SPLITTER.inheritSpeed', mul: 1.12, label: 'MOMENTUM SPLIT', note: 'Children keep more of the parent speed.' },
      // Children keep more of the parent speed.
    { level: 39, id: 'cap.39', kind: 'stat', path: 'population.softCapBase', add: 6, label: 'MORE ORBS', note: 'Six more balls on screen.' },
      // Six more balls on screen.
    { level: 40, id: 'tap.vortexTime.40', kind: 'gesture', path: 'tap.vortexTime', mul: 1.3, label: 'LONG VORTEX', note: 'Vortices spin for longer.' },
      // Vortices spin for longer.
    { level: 41, id: 'sky.baseMag.41', kind: 'visual', path: 'sky.baseMag', mul: 1.2, label: 'BRIGHT STARS', note: 'Your constellation burns brighter.' },
      // Your constellation burns brighter.
    { level: 42, id: 'types.MAGNET.pull.42', kind: 'mod', path: 'types.MAGNET.pull', mul: 1.35, label: 'STRONGER PULL', note: 'Magnets pull harder.' },
      // Magnets pull harder.
    { level: 43, id: 'cap.43', kind: 'stat', path: 'population.softCapBase', add: 6, label: 'MORE ORBS', note: 'Six more balls on screen.' },
      // Six more balls on screen.
    { level: 44, id: 'score.comboMultScale.44', kind: 'score', path: 'score.comboMultScale', mul: 1.12, label: 'COMBO VALUE', note: 'Combos multiply harder.' },
      // Combos multiply harder.
    { level: 45, id: 'palette.6', kind: 'palette', label: 'ULTRAVIOLET', note: 'A new colour world, unlocked forever.' },
      // A new colour world, unlocked forever. The label is the world's own name: "NEW SKY"
      // eleven times told you nothing about which sky you had just been given.
    { level: 46, id: 'types.MAGNET.pullRadius.46', kind: 'mod', path: 'types.MAGNET.pullRadius', mul: 1.2, label: 'LONG REACH', note: 'Magnets reach further.' },
      // Magnets reach further.
    { level: 47, id: 'effects.detonateSparks.47', kind: 'visual', path: 'effects.detonateSparks', add: 10, label: 'BLAST SPARKS', note: 'Detonations throw more debris.' },
      // Detonations throw more debris.
    { level: 48, id: 'sky.nebulaCount.48', kind: 'visual', path: 'sky.nebulaCount', add: 1, label: 'NEBULA', note: 'A second colour cloud drifts into the sky.' },
      // A second colour cloud drifts into the sky.
    { level: 49, id: 'types.MAGNET.spikePull.49', kind: 'mod', path: 'types.MAGNET.spikePull', mul: 1.3, label: 'MAGNET SPIKE', note: 'A struck magnet yanks much harder.' },
      // A struck magnet yanks much harder.
    { level: 50, id: 'tap.vortexSpin.50', kind: 'gesture', path: 'tap.vortexSpin', mul: 1.25, label: 'FAST VORTEX', note: 'Vortices spin faster.' },
      // Vortices spin faster.
    { level: 51, id: 'render.bloomStrengthCalm.51', kind: 'visual', path: 'render.bloomStrengthCalm', mul: 1.25, label: 'CALM GLOW', note: 'A quiet screen glows more.' },
      // A quiet screen glows more.
    { level: 52, id: 'sky.vignette.52', kind: 'visual', path: 'sky.vignette', mul: 1.3, label: 'DEEP SKY', note: 'The edges of the world darken.' },
      // The edges of the world darken.
    { level: 53, id: 'types.MAGNET.fieldLines.53', kind: 'mod', path: 'types.MAGNET.fieldLines', add: 3, label: 'FIELD LINES', note: 'More visible magnet field lines.' },
      // More visible magnet field lines.
    { level: 54, id: 'palette.7', kind: 'palette', label: 'VENOM', note: 'A new colour world, unlocked forever.' },
      // A new colour world, unlocked forever. The label is the world's own name: "NEW SKY"
      // eleven times told you nothing about which sky you had just been given.
    { level: 55, id: 'score.globalMultBase.55', kind: 'score', path: 'score.globalMultBase', add: 0.25, label: 'VALUE +++', note: 'More still.' },
      // More still.
    { level: 56, id: 'types.PRISM.shards.56', kind: 'mod', path: 'types.PRISM.shards', add: 4, label: 'MORE SHARDS', note: 'Prisms throw more shards.' },
      // Prisms throw more shards.
    { level: 57, id: 'sky.horizonAlpha.57', kind: 'visual', path: 'sky.horizonAlpha', mul: 1.7, label: 'HORIZON', note: 'Light rises from below the bottom of the screen.' },
      // Light rises from below the bottom of the screen.
    { level: 58, id: 'sky.linksPerStars.58', kind: 'visual', path: 'sky.linksPerStars', mul: 1.3, label: 'CONSTELLATIONS', note: 'More lines join your stars.' },
      // More lines join your stars.
    { level: 59, id: 'types.PRISM.shardSpeed.59', kind: 'mod', path: 'types.PRISM.shardSpeed', mul: 1.2, label: 'FAST SHARDS', note: 'Shards travel faster.' },
      // Shards travel faster.
    { level: 60, id: 'tap.pulseRadius.60', kind: 'gesture', path: 'tap.pulseRadius', mul: 1.2, label: 'WIDE PULSE II', note: 'Wider still.' },
      // Wider still.
    { level: 61, id: 'palette.12', kind: 'palette', label: 'DRIFTWOOD', note: 'A new colour world, unlocked forever.' },
      // A new colour world, unlocked forever.
    { level: 62, id: 'effects.shockwaveTime.62', kind: 'visual', path: 'effects.shockwaveTime', mul: 1.3, label: 'LONG SHOCKWAVE', note: 'Shockwave rings linger.' },
      // Shockwave rings linger.
    { level: 63, id: 'palette.8', kind: 'palette', label: 'BLOODMOON', note: 'A new colour world, unlocked forever.' },
      // A new colour world, unlocked forever. The label is the world's own name: "NEW SKY"
      // eleven times told you nothing about which sky you had just been given.
    { level: 64, id: 'types.PRISM.shardLife.64', kind: 'mod', path: 'types.PRISM.shardLife', mul: 1.35, label: 'LONG SHARDS', note: 'Shards live longer.' },
      // Shards live longer.
    { level: 65, id: 'score.comboMultScale.65', kind: 'score', path: 'score.comboMultScale', mul: 1.12, label: 'COMBO VALUE II', note: 'Combos multiply harder again.' },
      // Combos multiply harder again.
    { level: 66, id: 'sky.nebulaAlpha.66', kind: 'visual', path: 'sky.nebulaAlpha', mul: 1.45, label: 'DEEP NEBULA', note: 'The clouds thicken.' },
      // The clouds thicken.
    { level: 67, id: 'types.PRISM.shards.67', kind: 'mod', path: 'types.PRISM.shards', add: 5, label: 'MORE SHARDS II', note: 'A full spray.' },
      // A full spray.
    { level: 68, id: 'filigree.alpha.68', kind: 'visual', path: 'filigree.alpha', mul: 1.3, label: 'BRIGHT FILIGREE', note: 'Ring ornament stands out.' },
      // Ring ornament stands out.
    { level: 69, id: 'types.CHAIN.targets.69', kind: 'mod', path: 'types.CHAIN.targets', add: 1, label: 'FOURTH ARC', note: 'Chains jolt one more ball.' },
      // Chains jolt one more ball.
    { level: 70, id: 'sky.starGlow.70', kind: 'visual', path: 'sky.starGlow', mul: 1.35, label: 'STARLIGHT', note: 'Every star carries a halo.' },
      // Every star carries a halo.
    { level: 71, id: 'tap.vortexRadius.71', kind: 'gesture', path: 'tap.vortexRadius', mul: 1.22, label: 'BIG VORTEX', note: 'Vortices reach further.' },
      // Vortices reach further.
    { level: 72, id: 'palette.9', kind: 'palette', label: 'COBALT', note: 'A new colour world, unlocked forever.' },
      // A new colour world, unlocked forever. The label is the world's own name: "NEW SKY"
      // eleven times told you nothing about which sky you had just been given.
    { level: 73, id: 'render.starTwinkle.73', kind: 'visual', path: 'render.starTwinkle', mul: 1.4, label: 'TWINKLE', note: 'Stars shimmer more.' },
      // Stars shimmer more.
    { level: 74, id: 'types.CHAIN.range.74', kind: 'mod', path: 'types.CHAIN.range', mul: 1.25, label: 'LONG ARC', note: 'Chains reach further.' },
      // Chains reach further.
    { level: 75, id: 'sky.shootingChancePerSec.75', kind: 'visual', path: 'sky.shootingChancePerSec', mul: 3.0, label: 'STARFALL', note: 'Shooting stars come three times as often.' },
      // Shooting stars come three times as often.
    { level: 76, id: 'types.CHAIN.depth.76', kind: 'mod', path: 'types.CHAIN.depth', add: 1, label: 'DEEPER CHAIN', note: 'Chains hop one more time.' },
      // Chains hop one more time.
    { level: 77, id: 'effects.shatterSparks.77', kind: 'visual', path: 'effects.shatterSparks', add: 8, label: 'ICE DEBRIS', note: 'Shattering ice throws more.' },
      // Shattering ice throws more.
    { level: 78, id: 'types.CHAIN.impulse.78', kind: 'mod', path: 'types.CHAIN.impulse', mul: 1.3, label: 'HARD JOLT', note: 'Chain jolts hit harder.' },
      // Chain jolts hit harder.
    { level: 79, id: 'gather.slingBase.79', kind: 'gesture', path: 'gather.slingBase', mul: 1.2, label: 'STRONG SLING', note: 'Released orbits are thrown harder.' },
      // Released orbits are thrown harder.
    { level: 80, id: 'sky.maxStars.80', kind: 'visual', path: 'sky.maxStars', add: 40, label: 'DEEP FIELD', note: 'Room for forty more stars.' },
      // Room for forty more stars.
    { level: 81, id: 'paletteRules.driftPeriod.81', kind: 'visual', path: 'paletteRules.driftPeriod', mul: 0.8, label: 'FASTER DRIFT', note: 'Colour worlds blend sooner.' },
      // Colour worlds blend sooner.
    { level: 82, id: 'types.FROST.maxTargets.82', kind: 'mod', path: 'types.FROST.maxTargets', add: 3, label: 'DEEP FREEZE', note: 'Frost catches more neighbours.' },
      // Frost catches more neighbours.
    { level: 83, id: 'types.FROST.radius.83', kind: 'mod', path: 'types.FROST.radius', mul: 1.22, label: 'WIDE FREEZE', note: 'Frost reaches further.' },
      // Frost reaches further.
    { level: 84, id: 'palette.10', kind: 'palette', label: 'BLOSSOM', note: 'A new colour world, unlocked forever.' },
      // A new colour world, unlocked forever. The label is the world's own name: "NEW SKY"
      // eleven times told you nothing about which sky you had just been given.
    { level: 85, id: 'render.bloomStrengthFrenzy.85', kind: 'visual', path: 'render.bloomStrengthFrenzy', mul: 1.2, label: 'FRENZY GLOW', note: 'Chaos burns brighter.' },
      // Chaos burns brighter.
    { level: 86, id: 'types.FROST.freezeTime.86', kind: 'mod', path: 'types.FROST.freezeTime', mul: 1.3, label: 'LONG FREEZE', note: 'Ice holds longer.' },
      // Ice holds longer.
    { level: 87, id: 'gather.radiusGather.87', kind: 'gesture', path: 'gather.radiusGather', mul: 1.15, label: 'DEEP GATHER', note: 'Your attractor reaches further.' },
      // Your attractor reaches further.
    { level: 88, id: 'sky.nebulaCount.88', kind: 'visual', path: 'sky.nebulaCount', add: 1, label: 'NEBULA II', note: 'A third cloud.' },
      // A third cloud.
    { level: 89, id: 'comet.chancePerSec.89', kind: 'visual', path: 'comet.chancePerSec', mul: 2.0, label: 'COMET WATCH', note: 'Comets appear more often.' },
      // Comets appear more often.
    { level: 90, id: 'types.FROST.shatterImpulse.90', kind: 'mod', path: 'types.FROST.shatterImpulse', mul: 1.4, label: 'HARD SHATTER', note: 'Thawing balls burst harder.' },
      // Thawing balls burst harder.
    { level: 91, id: 'types.GOLD.weight.91', kind: 'mod', path: 'types.GOLD.weight', mul: 1.6, label: 'MORE GOLD', convert: { type: 'GOLD', n: 3 }, note: 'Gold turns up more often.' },
      // Gold turns up more often.
    { level: 92, id: 'render.ringRadius.92', kind: 'visual', path: 'render.ringRadius', mul: 1.12, label: 'WIDE RING', note: 'Your finger ring is larger.' },
      // Your finger ring is larger.
    { level: 93, id: 'sky.vignetteFrenzy.93', kind: 'visual', path: 'sky.vignetteFrenzy', mul: 1.25, label: 'CRUSHED CORNERS', note: 'Chaos closes the frame in harder.' },
      // Chaos closes the frame in harder.
    { level: 94, id: 'types.GOLD.comboJump.94', kind: 'mod', path: 'types.GOLD.comboJump', add: 3, label: 'GOLD RUSH', note: 'Gold jumps the combo further.' },
      // Gold jumps the combo further.
    { level: 95, id: 'field.radius.95', kind: 'gesture', path: 'field.radius', mul: 1.12, label: 'BROAD FIELD', note: 'Your push field is wider.' },
      // Your push field is wider.
    { level: 96, id: 'palette.11', kind: 'palette', label: 'JADE', note: 'A new colour world, unlocked forever.' },
      // A new colour world, unlocked forever. The label is the world's own name: "NEW SKY"
      // eleven times told you nothing about which sky you had just been given.
    { level: 97, id: 'effects.maxParticles.97', kind: 'visual', path: 'effects.maxParticles', add: 250, label: 'DENSE PARTICLES', note: 'More particles on screen at once.' },
      // More particles on screen at once.
    { level: 98, id: 'types.GOLD.scoreFlat.98', kind: 'mod', path: 'types.GOLD.scoreFlat', mul: 1.8, label: 'GOLD VALUE', note: 'Gold is worth much more.' },
      // Gold is worth much more.
    { level: 99, id: 'types.GOLD.weight.99', kind: 'mod', path: 'types.GOLD.weight', mul: 1.5, label: 'MORE GOLD II', convert: { type: 'GOLD', n: 4 }, note: 'Gold again.' },
      // Gold again.
    { level: 100, id: 'field.flingGain.100', kind: 'gesture', path: 'field.flingGain', mul: 1.18, label: 'STRONG FLING', note: 'Swipes carry balls harder.' },
      // Swipes carry balls harder.
  ],

  /* ------------------------------------------------------------ milestones -- */
  milestones: {
    // Lifetime-score milestones. Generated as m * 10^k for each mantissa, ascending.
    mantissas: [1, 1.6, 2.5, 4, 6.3],  // Five per decade, log-even: 10k, 16k, 25k, 40k, 63k, 100k...
    startExp: 5,              // First decade: 10^5 = 100,000, reached around 30s of engaged play.
                              // Starting lower fired four celebrations inside the first fifteen
                              // seconds, on top of the first type unlock — which is not a
                              // milestone, it is noise.
    maxExp: 15,               // Last decade tracked: 10^15. Fifty-five rungs, so a regular can
                              // plausibly fill the 88-star sky over months (comets count too).
    celebrateTime: 2.8,       // s. Length of a milestone celebration.
    cometMilestone: true,     // Breaking a comet also counts as a milestone.
  },

  /* -------------------------------------------------------------- intensity -- */
  // CALM / ACTIVE / FRENZY. Drives every effect. The gap between calm and loud is the point.
  intensity: {
    riseTau: 0.22,            // s. How fast intensity climbs. Fast — reaction should feel instant.
    fallTau: 1.8,             // s. How fast it decays. Sized so that once the last cascade dies,
                              // intensity is comfortably under calmBelow within the brief's
                              // ten untouched seconds.
    touchWeight: 0.55,        // Contribution of an active finger.
    comboWeight: 0.055,       // Contribution per combo step, but ONLY while the combo is live
                              // (comboTimer > 0). A big combo sitting there decaying is not
                              // excitement, and letting it pin intensity kept the screen in
                              // permanent FRENZY long after everything had stopped moving.
    comboMaxContrib: 0.35,    // Ceiling on that contribution, so combo alone never means FRENZY.
                              // The contribution also fades with comboTimer/comboWindow: a combo
                              // one beat away from lapsing is not excitement either.
    impactWeight: 0.075,      // Contribution per hard impact this frame.
    effectWeight: 0.05,       // Contribution per type effect this frame.
    calmBelow: 0.18,          // Below this: CALM.
    frenzyAbove: 0.62,        // Above this: FRENZY. Between the two: ACTIVE.
    calmSettleTime: 10.0,     // s. Untouched time at which "genuinely quiet" is asserted (used by tests).
  },

  /* ------------------------------------------------------------------ proof -- */
  // Upgrades that change a distance draw themselves at that distance, and upgrades that add a
  // ball show you the ball. The one legibility pattern this game already had that worked was the
  // tap pulse: the event carries its radius and the renderer draws exactly that, so you can see
  // what "WIDE PULSE" bought you. Everything here is that idea, generalised.
  proof: {
    convertTime: 0.5,         // s. Length of one transmutation flourish.
    tracerTime: 0.9,          // s. The line drawn from the announcement to the ball it names.
    tracerBow: 40,            // px @ref. How far that line bows out from the straight chord.
  },

  /* ---------------------------------------------------------------- effects -- */
  effects: {
    maxPerFrame: 48,          // Hard budget on sim-emitted effect events per step. Excess is DROPPED,
                              // never queued — a queued backlog is how a phone dies.
    reservedForProgression: 6, // Slots of that budget held back for events that happen once and
                              // matter: upgrades, level-ups, milestones, unlock conversions, the
                              // cap. Ordinary effects stop at maxPerFrame minus this. Without it,
                              // a busy screen ate 12.2% of all upgrade announcements.
    maxParticles: 900,        // Renderer particle ceiling at full quality.
    particleShedFps: 48,      // fps below which particles start being shed.
    particleShedFloor: 0.25,  // Minimum fraction of the particle budget when shedding hard.
    bloomShedFps: 42,         // fps below which bloom resolution is halved.
    bloomMinScale: 0.14,      // Smallest bloom downscale factor.
    impactSparks: 7,          // Sparks per hard impact at full quality.
    detonateSparks: 26,       // Sparks per detonation.
    shatterSparks: 12,        // Sparks per freeze-shatter.
    novaShockStrength: 1.5,   // Shockwave strength multiplier for a resonance nova vs a plain blast.
    shockwaveTime: 0.45,      // s. Shockwave ring lifetime.
    flashTime: 0.14,          // s. Screen flash lifetime.
    flashMaxAlpha: 0.20,      // Peak screen-flash alpha at FRENZY. Never blinding.
    shakeMax: 7.5,            // px @ref. Peak screen shake.
    shakeDecay: 7.0,          // 1/s. Shake decay rate.
    popupRate: 6,             // Popups spawned per second, at most. Score is mostly aesthetic
                              // here — the point is the feeling of numbers going up, not a
                              // readout — so the screen stays legible instead of becoming a
                              // wall of digits during a cascade.
    popupMax: 12,             // Concurrent popups on screen at once.
    popupMergeRadius: 46,     // px @ref. Popups landing this close merge into one, and the
                              // merged one grows, so a cluster reads as one bigger number.
    popupLife: 1.05,          // s. Floating score popup lifetime.
    popupRise: 52,            // px @ref. Distance a popup floats upward.
  },

  /* ---------------------------------------------------------------- render -- */
  render: {
    dprCap: 2,                // devicePixelRatio ceiling. Above 2 costs fill rate and buys nothing.
    trailFade: 0.17,          // Per-frame alpha erased from the trail layer with 'destination-out'.
                              // A translucent black rect over a dark scene ghosts grey; this does not.
                              // Too LOW and the additive layer saturates to white, which then ghosts
                              // grey on its way out — same symptom, different cause.
    trailFadeCalm: 0.11,      // Slower trail fade in CALM: longer, lazier streaks.
    trailFadeIdle: 0.40,      // Trail fade once the screen has been untouched for idleFadeAfter.
                              // This is not a style choice, it is a leak fix. The fade is a
                              // MULTIPLY on an 8-bit layer, so it removes round(v * fade) per
                              // frame: at 0.11 every pixel at or below 4/255 subtracts zero and
                              // sticks forever. Composited additively and then bloomed twice, that
                              // stuck floor reads as a grey web of everywhere a ball has ever been,
                              // and it never goes away. Idle is exactly when nobody is watching the
                              // streak length and exactly when the screen is supposed to be empty.
    idleFadeAfter: 6.0,       // s untouched before the trail fade starts ramping toward that.
    idleFadeRamp: 4.0,        // s over which it ramps, so the web dissolves rather than snapping.
    trailFadeFrenzy: 0.24,    // Faster fade in FRENZY, or the screen turns to soup.
    bloomScale: 0.25,         // Bloom buffer size relative to the stage. The resample IS the blur.
    bloomPasses: 2,           // Upscale-composite passes with 'lighter'.
    bloomStrength: 0.42,      // Alpha of the bloom composite. This is added ON TOP of an already
                              // additive layer, so it saturates to flat white far sooner than it looks
                              // like it should.
    bloomStrengthCalm: 0.28,  // Gentler bloom when quiet.
    bloomStrengthFrenzy: 0.62,// Full bloom when loud.
    starTwinkle: 0.35,        // Amplitude of star twinkle.
    hudMargin: 16,            // px. HUD inset, applied *inside* env(safe-area-inset-*).
    hudAlphaCalm: 0.5,        // HUD opacity when calm — the numbers recede when nothing is happening.
    hudAlphaActive: 0.95,     // HUD opacity when playing.
    ringRadius: 34,           // px @ref. Radius of the combo ring drawn at each finger.
    ringWidth: 3.0,           // px @ref. Combo ring stroke width.
    fieldRingAlpha: 0.5,      // Base opacity of the finger ring.
    levelBarHeight: 3.0,      // px. Thickness of the level bar.
    lastUpgradeTime: 6.0,     // s. How long the name of the upgrade you just earned lingers under
                              // the level bar. Deliberately much longer than the 1.1s flash: the
                              // flash is for the player who was looking, this is for the one who
                              // looked up half a second late and wants to know what just happened.
    lastUpgradeFade: 1.0,     // s. Fade-out at the end of that.
    lastUpgradeScale: 0.85,   // Size relative to the 'LV n' label. Smaller — it is an aside.
    orbHueBase: 2,            // Orb hues in play at level 1, of the palette's four. Starting narrow
                              // is what gives the later fan-outs something to land against.
    orbHuePerPalettes: 3,     // One further orb hue enters play per this many colour worlds owned.
                              // A third of the population changes colour in a single frame, twice a
                              // run, and it costs no upgrade slot to do it.
    spriteCacheMax: 512,      // Glow sprites held before a hard clear. An unlock rush churns fast.
    fontStack: 'ui-rounded, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  },

  /* -------------------------------------------------------------- palettes -- */
  // Every few levels permanently unlocks a colour world. No picker, ever.
  // Long sessions drift gently between unlocked palettes.
  paletteRules: {
    driftPeriod: 95,          // s. Time to drift from one unlocked palette to the next.
    driftHold: 45,            // s. Time spent settled on a palette before drifting again.
    driftOnlyWhenCalm: false, // If true, ambient drift pauses outside CALM. An unlock rush ignores it.
    unlockDriftPeriod: 9.0,   // s. Crossfade into a world you JUST unlocked. Long enough to read as
                              // weather rather than a cut, short enough that the celebration that
                              // announced it is still on screen when the new world arrives.
    unlockHold: 90,           // s held on a freshly unlocked world before the round robin resumes.
                              // Arriving somewhere you immediately drift out of is barely arriving.
    unlockWashTime: 1.6,      // s. The expanding light-front that announces a new world.
    unlockWashAlpha: 0.55,    // Peak brightness of that front. Composited 'lighter' — a lift, not a veil.
    unlockTrailHoldMul: 0.8,  // Trail fade multiplier during a wash, so the outgoing world's streaks
                              // visibly burn off while the new world's balls draw over them.
    unlockMixStep: 12,        // Colour quantisation during a rush (6 normally). Coarser steps halve
                              // glow-sprite churn on the busiest frames in the game.
    blendChromaKeep: 0.85,    // 0 = plain sRGB lerp between worlds, which greys out at the midpoint.
                              // 1 = fully restore the chroma the pair implies. Ember->Deep Sea at the
                              // halfway point was #9aa49e, dead putty; this makes it a sea-green.
    gradeFullLevel: 88,       // Level at which the continuous colour grade reaches full strength.
    gradeChroma: 0.30,        // Max extra chroma on orb and type colours at full grade.
    gradeDepth: 0.40,         // Max darkening of bg0 toward black at full grade.
    gradeHorizon: 0.20,       // Max lift of bg1 toward the world's own fog at full grade.
    gradeSpread: 0.26,        // Max lightness fan across the orb hues, so a crowded late screen reads
                              // as a population with depth instead of one colour repeated 150 times.
    typeSeparation: 45,       // Minimum redmean colour distance between any two ball colours in a
                              // palette (the seven named types plus the base orb hue). Enforced by
                              // a test. Shipped worlds had CHAIN byte-identical to the orb hue in
                              // Solar and two types identical in Monochrome: a whole ball type you
                              // could not see was a ball type. Raising this number is a design
                              // decision; lowering it to make a palette pass is not.
  },

  palettes: [
    {
      name: 'Ember',          // Starting world. Warm coals on near-black.
      bg0: '#0b0607', bg1: '#1a0b08', fog: '#e0703a',
      hud: '#ffd9b0', hudDim: '#a6704e', ring: '#ff9a4d', star: '#ffd9a8',
      orbHues: ['#ff8a3d', '#ffb703', '#ff5f45', '#ffd08a'],
      type: {
        VOLATILE: '#ff2f14', SPLITTER: '#ffb703', MAGNET: '#ff8fa3',
        PRISM: '#ffe6b0', CHAIN: '#b6f36a', FROST: '#9fd8e0', GOLD: '#ffe066',
      },
    },
    {
      name: 'Deep Sea',       // Cold, quiet, bioluminescent.
      bg0: '#02060d', bg1: '#04182b', fog: '#2aa9c9',
      hud: '#c8f0ff', hudDim: '#4d7f96', ring: '#3fd4ff', star: '#bfeaff',
      orbHues: ['#38bdf8', '#22d3ee', '#5eead4', '#7dd3fc'],
      type: {
        VOLATILE: '#ff6b6b', SPLITTER: '#67e8f9', MAGNET: '#a78bfa',
        PRISM: '#fff4d8', CHAIN: '#b8f36a', FROST: '#e0f2fe', GOLD: '#ffd24a',
      },
    },
    {
      name: 'Aurora',         // Green-violet curtains.
      bg0: '#03080a', bg1: '#0a1f1c', fog: '#4ade80',
      hud: '#d7ffe9', hudDim: '#5f8f78', ring: '#5eead4', star: '#d9ffe8',
      orbHues: ['#4ade80', '#2dd4bf', '#a78bfa', '#86efac'],
      type: {
        VOLATILE: '#fb7185', SPLITTER: '#eaff8a', MAGNET: '#c084fc',
        PRISM: '#ecfeff', CHAIN: '#5eead4', FROST: '#cffafe', GOLD: '#fde047',
      },
    },
    {
      name: 'Synthwave',      // Magenta grid, loudest world.
      bg0: '#08030f', bg1: '#1d0630', fog: '#ff2fb9',
      hud: '#ffd6f7', hudDim: '#8d5c94', ring: '#ff4fd8', star: '#ffd0f3',
      orbHues: ['#ff2fb9', '#7c3aed', '#22d3ee', '#f472b6'],
      type: {
        VOLATILE: '#ff2d55', SPLITTER: '#f472b6', MAGNET: '#8b5cf6',
        PRISM: '#a5f3fc', CHAIN: '#22d3ee', FROST: '#c4b5fd', GOLD: '#ffe14d',
      },
    },
    {
      name: 'Monochrome',     // Pure light on pure dark. The calmest world. Orbs stay grey so the
                              // mood holds; each named type carries the minimum whisper of hue
                              // that tells it apart. PRISM keeps pure white — it is the
                              // all-colours ball, and the only pure white left on screen.
      bg0: '#050505', bg1: '#101012', fog: '#9aa0a6',
      hud: '#f2f2f2', hudDim: '#7a7a7a', ring: '#e6e6e6', star: '#ffffff',
      orbHues: ['#d8d8d8', '#b4b4b4', '#8e8e8e', '#c6c6c6'],
      type: {
        VOLATILE: '#ffb4a2', SPLITTER: '#9fb4c8', MAGNET: '#c3a8e0',
        PRISM: '#ffffff', CHAIN: '#8fd4bf', FROST: '#8ec8ff', GOLD: '#ffe08a',
      },
    },
    {
      name: 'Solar',          // White-hot cores, corona edges.
      bg0: '#0c0602', bg1: '#241102', fog: '#ffb020',
      hud: '#fff0cf', hudDim: '#a8794a', ring: '#ffc247', star: '#fff2cf',
      orbHues: ['#ffd166', '#ff9f1c', '#fff3b0', '#ff7b00'],
      type: {
        VOLATILE: '#ff3d00', SPLITTER: '#ffb703', MAGNET: '#ff9e80',
        PRISM: '#fffbe6', CHAIN: '#c86bff', FROST: '#cfe8ff', GOLD: '#fff08a',
      },
    },
    {
      name: 'Ultraviolet',    // Blacklight room. Violet dark, everything fluoresces.
      bg0: '#04030a', bg1: '#150a2b', fog: '#a44bff',
      hud: '#ead6ff', hudDim: '#7a5a9e', ring: '#b06bff', star: '#e3d1ff',
      orbHues: ['#8b3dff', '#a855f7', '#6d4dff', '#c07bff'],
      type: {
        VOLATILE: '#ff3860', SPLITTER: '#c47bff', MAGNET: '#4f46ff',
        PRISM: '#f7c9ff', CHAIN: '#3ef0ff', FROST: '#a8c8ff', GOLD: '#ffd24a',
      },
    },
    {
      name: 'Venom',          // Toxic swamp. Acid light; nothing here is safe.
      bg0: '#040603', bg1: '#0d1a05', fog: '#9ef01a',
      hud: '#e8ffc4', hudDim: '#6f8f45', ring: '#b9ff3d', star: '#ddffb0',
      orbHues: ['#a3e635', '#84cc16', '#c8ff2e', '#7ddf20'],
      type: {
        VOLATILE: '#ff4d1f', SPLITTER: '#c2f53f', MAGNET: '#b14dff',
        PRISM: '#f0ffd0', CHAIN: '#22e0ff', FROST: '#9fd0ff', GOLD: '#ffc61a',
      },
    },
    {
      name: 'Bloodmoon',      // Eclipse. Arterial reds, no daylight in it.
      bg0: '#060203', bg1: '#1c0409', fog: '#ff3b30',
      hud: '#ffd7d9', hudDim: '#9b5158', ring: '#ff4d5e', star: '#ffd0cf',
      orbHues: ['#e11d48', '#ff3355', '#c1121f', '#ff5c72'],
      type: {
        VOLATILE: '#ff5a1f', SPLITTER: '#ff2e63', MAGNET: '#d946ef',
        PRISM: '#ffe3e8', CHAIN: '#6b8cff', FROST: '#a9e6ff', GOLD: '#ffc42e',
      },
    },
    {
      name: 'Cobalt',         // Lapis and steel. Cold, hard, jewel-bright.
      bg0: '#02040c', bg1: '#08132e', fog: '#4d8cff',
      hud: '#d6e6ff', hudDim: '#5b7699', ring: '#5b9cff', star: '#cfe0ff',
      orbHues: ['#3b7dff', '#5566ff', '#2a5fe8', '#8aa8ff'],
      type: {
        VOLATILE: '#ff5a33', SPLITTER: '#7cf5c8', MAGNET: '#b76bff',
        PRISM: '#f0f6ff', CHAIN: '#00d0ff', FROST: '#a9c8ff', GOLD: '#ffcf3d',
      },
    },
    {
      name: 'Blossom',        // Night orchard. Rose and coral, the gentlest world.
      bg0: '#0a0407', bg1: '#1e0713', fog: '#ff7aa2',
      hud: '#ffe0e8', hudDim: '#a9707f', ring: '#ff8fb0', star: '#ffe4ef',
      orbHues: ['#ff5c8a', '#ff8a6b', '#ff9fbc', '#e94f8a'],
      type: {
        VOLATILE: '#ff3b1f', SPLITTER: '#ff6fae', MAGNET: '#b06bff',
        PRISM: '#fff2fb', CHAIN: '#00d5ff', FROST: '#9ec5ff', GOLD: '#ffc93d',
      },
    },
    {
      name: 'Jade',           // Imperial jade under brass lanterns.
      bg0: '#020705', bg1: '#08201a', fog: '#2fd6a0',
      hud: '#f3ead0', hudDim: '#93855e', ring: '#e8b84b', star: '#f6e7bd',
      orbHues: ['#12c98a', '#39dfa4', '#0bb07d', '#5ceec0'],
      type: {
        VOLATILE: '#ff4d2e', SPLITTER: '#3ee0a8', MAGNET: '#6f7bff',
        PRISM: '#eafff5', CHAIN: '#c8ff3d', FROST: '#8fd4ff', GOLD: '#ffcf3d',
      },
    },
    {
      name: 'Driftwood',      // Ash and ember-dust. The quiet one, and the only late reward that
                              // makes the screen calmer instead of louder — relief after sixty
                              // levels of neon is itself a kind of contrast.
      bg0: '#070504', bg1: '#1a1108', fog: '#c08a4e',
      hud: '#f0e2cd', hudDim: '#8f7a5e', ring: '#d9a862', star: '#f4e8d2',
      orbHues: ['#d99a5c', '#c4763f', '#e8c38a', '#a86b45'],
      type: {
        VOLATILE: '#ff4a22', SPLITTER: '#cfe05a', MAGNET: '#a98cd8',
        PRISM: '#fff6e4', CHAIN: '#5fd3d0', FROST: '#bcd9e8', GOLD: '#ffd24a',
      },
    },
  ],

  /* ------------------------------------------------------------------- sky -- */
  // Permanent, save-derived progression. Best visible in CALM. A regular's sky fills in.
  sky: {
    maxStars: 88,             // Star cap. Past this, further milestones brighten existing stars.
    brightenPerExtra: 0.045,  // Added brightness per post-cap milestone.
    maxBrighten: 1.6,         // Ceiling on that accumulated brightness.
    baseMag: 0.34,            // Base star brightness.
    magVariance: 0.5,         // Deterministic per-star brightness variation.
    edgeInset: 0.06,          // Fraction of the screen kept clear at each edge.
    linkDistance: 0.185,      // Normalised distance under which two stars may be linked.
    linksPerStars: 0.42,      // Links granted per star owned; constellations grow over weeks.
    maxLinks: 120,            // Cap on drawn constellation lines.
    linkAlpha: 0.30,          // Base opacity of a constellation line.
    calmOnlyAlpha: 0.28,      // Sky opacity multiplier outside CALM (it fades when it gets loud).
    twinkleRate: 0.45,        // 1/s. Twinkle speed.
    starGlow: 1.0,            // Multiplier on the soft halo drawn behind each star. Raised at 70.
    shootingChancePerSec: 0.02, // Chance per second of a shooting star, CALM ONLY. It is the one
                              // thing in the game that rewards sitting still and not touching
                              // anything, so it must never fire while you are playing. Raised at 75.
    shootingTime: 1.25,       // s. How long one crosses the sky.
    shootingLength: 0.16,     // Tail length as a fraction of the screen diagonal.
    shootingAlpha: 0.85,      // Peak brightness of the head.
    alphaBuckets: 4,          // Stars are drawn in this many alpha groups, one path each, instead
                              // of building 88 rgba strings and 88 separate fills a frame. On a
                              // star, rounding the alpha to a quarter is not visible.
    parallax: 0.45,           // How much of the screen shake the sky does NOT take. At 0 it moves
                              // in perfect lockstep, which reads as a decal stuck to the glass.
    shedStars: 34,            // Stars still drawn at the lowest atmosphere tier.
    shedTier1Fps: 46,         // Below this fps the FRENZY cloud flare stops being drawn.
    shedTier0Fps: 34,         // Below this the CALM desaturation pass and the constellation lines
                              // go too, and the star field is capped. Physics is never shed.

    /* -- the atmosphere plates ------------------------------------------------
     * Everything below is baked into cached bitmaps, so its per-frame cost is a
     * drawImage no matter how elaborate it gets. */
    plateScale: 0.5,          // Plates render at this fraction of CSS size and upscale. Everything
                              // on them is a soft gradient, so the resample is free blur — the same
                              // argument the bloom already makes.
    plateScaleMin: 96,        // px floor on either plate axis, so a tiny window still gets a plate.
    bgMidStop: 0.38,          // Position of the third gradient stop. Two stops read as one flat wash.
    bgMidMix: 0.55,           // How far that stop sits between bg0 and bg1. Above 0.5 keeps the top
                              // of the screen dark, which is what the balls burn against.
    bgFloorMix: 0.05,         // How much `fog` mixes into the bottom stop. Kept small at level 1 so
                              // the sky ladder has somewhere to climb from. The bottom third of the
                              // screen previously had no colour in it at all. Past about 0.15 the
                              // black floor lifts and the additive trails stop reading as the
                              // brightest thing on screen.
    horizonAlpha: 0.055,      // Peak alpha of the glow anchored below the bottom edge. Starts low on
                              // purpose: HORIZON at level 57 multiplies it by 1.7, and an upgrade
                              // that brightens something already bright is not an upgrade.
    horizonY: 1.06,           // Its centre, in units of plate height. Above 1 keeps it off-screen,
                              // so only the top of the falloff shows and it reads as light from
                              // under the world rather than a circle somebody drew.
    horizonRadius: 0.62,      // Its radius as a fraction of plate height.
    nebulaCount: 1,           // Colour clouds baked into the plate. Raised by upgrades.
    nebulaMax: 4,             // Ceiling, so a forced debug re-apply cannot run the count away.
    nebulaAlpha: 0.055,       // Peak centre alpha, composited 'lighter'. Small ON PURPOSE: the trail
                              // and two bloom passes are already additive and clip sooner than they
                              // look, and a bright sky is a sky competing with the balls.
    nebulaRadius: 0.85,       // Cloud radius as a fraction of the plate's short side.
    nebulaMidStop: 0.45,      // Middle gradient stop of a cloud.
    nebulaMidMul: 0.42,       // Alpha there, relative to nebulaAlpha. Below 0.5 gives the edgeless
                              // falloff that reads as cloud instead of as a drawn circle.
    nebulaSpots: [[0.24, 0.22, 1.00], [0.78, 0.62, 0.86], [0.50, 0.92, 1.20], [0.86, 0.14, 0.72]],
                              // Cloud centres as [x, y, radiusScale] in normalised plate space.
                              // Fixed rather than save-derived: a new player has no milestones and
                              // therefore no stars, and still deserves weather.
    nebulaFrenzyGain: 0.35,   // Extra additive pass of the cloud plate at full FRENZY.
    calmChromaDrop: 0.35,     // How far the background desaturates toward neutral in CALM. The balls
                              // keep all of their colour; the room around them goes quiet.
    grainAlpha: 0.35,         // Alpha of the noise tile baked into the plate.
    grainTile: 64,            // px. Noise tile size, tiled with createPattern.
    grainAmp: 10,             // 0-255 peak ALPHA of a noise pixel. The tile is white and varies only
                              // in alpha, never a grey fill: a grey fill composited additively would
                              // lift the black floor by its own mean.
    vignette: 0.22,           // Alpha of the black corner falloff at ACTIVE.
    vignetteCalm: 0.14,       // In CALM. The frame opens out when nothing is happening.
    vignetteFrenzy: 0.40,     // In FRENZY. The corners crush and the middle reads like a furnace.
                              // This one number carries more of the CALM/FRENZY contrast than any
                              // other, because it makes every orb read brighter without adding a
                              // single lumen to a stack that already clips.
    vignetteInner: 0.35,      // Inner radius as a fraction of max(w,h); fully transparent.
    vignetteOuter: 0.78,      // Outer radius as a fraction of max(w,h); full alpha.
  },

  /* -------------------------------------------------------------- filigree -- */
  // Lifetime best-combo tiers add permanent ornament to the finger ring. Cosmetic only.
  filigree: {
    tiers: [40, 150, 600, 2500, 10000, 35000, 100000],  // Best-combo thresholds; tier = how many passed.
                              // Scaled to the real combo range: a busy rally reaches five figures,
                              // so tiers topping out at 400 would all unlock in the first minute.
    arcCount: [0, 3, 4, 5, 6, 8, 10, 12],   // Ornament arcs per tier (index = tier).
    spinRate: 0.25,           // rad/s. Ornament rotation.
    alpha: 0.55,              // Ornament opacity.
  },

  /* ----------------------------------------------------------------- comet -- */
  // Rare, active-play only, fully ignorable.
  comet: {
    enabled: true,
    chancePerSec: 0.014,      // Spawn probability per second while ACTIVE or FRENZY.
    minGap: 75,               // s. Minimum time between comets.
    requireIntensity: 0.30,   // Minimum intensity for a comet to consider appearing.
    speed: 118,               // px/s @ref. Drift speed across the screen.
    radius: 15,               // px @ref. Comet body radius.
    hp: 5,                    // Hard impacts needed to break it.
    chipSpeed: 240,           // px/s @ref. Minimum impact speed that chips it.
    scorePerChip: 250,        // Flat score per chip, before multipliers.
    scoreBreak: 3000,         // Flat score for breaking it.
    lifetime: 26,             // s. Time to cross and leave.
    tailLength: 20,           // Tail samples kept (render only).
  },

  /* ------------------------------------------------------------------ save -- */
  save: {
    version: 3,               // Save schema version. Anything else loads clean defaults.
    key: 'orbs.save.v1',      // localStorage key. Version lives *inside* the payload.
    writeInterval: 4.0,       // s. Minimum time between writes; localStorage writes are synchronous.
    writeOnHide: true,        // Also flush on visibilitychange/pagehide.
  },

  /* ------------------------------------------------------------ tap powers -- */
  // Two single-finger gestures that sit alongside push and hold-to-gather. Recognition
  // lives in main.js (it has the clock); the sim just receives `input.taps`.
  tap: {
    maxTime: 0.19,            // s. Down-to-up faster than this, with little movement, is a tap.
    maxMove: 15,              // px @ref. Movement allowed during a tap before it is a drag.
    doubleWindow: 0.34,       // s. A second tap inside this window becomes a VORTEX instead.
    cooldown: 0.22,           // s. Minimum gap between two pulses, so tapping cannot machine-gun.

    // TAP -> PULSE: a sharp outward shove. The counterpart to the attractor: instant and
    // punchy where gather is slow and deliberate.
    pulseRadius: 155,         // px @ref. Reach of the pulse.
    pulseImpulse: 660,        // px/s @ref. Peak velocity change at the centre.
    pulseFalloffExp: 1.35,    // Exponent on the pulse falloff.
    pulseCharge: 1.3,         // s of charge granted to balls it touches, so pulses start cascades.
    pulseShake: 3.0,          // px @ref of screen shake.

    // DOUBLE TAP -> VORTEX: a spinning well that outlives the finger, winds balls into a
    // spiral, then lets go. Gather needs you to hold; this one you throw down and leave.
    vortexRadius: 200,        // px @ref. Reach.
    vortexPull: 780,          // px/s^2 @ref. Inward haul.
    vortexSpin: 540,          // px/s @ref. Tangential speed it drives balls toward.
    vortexSpinGain: 3.0,      // 1/s. How hard it drives toward that speed.
    vortexTime: 1.5,          // s. Lifetime.
    vortexFade: 0.35,         // Fraction of its life spent fading out at the end.
    vortexCharge: 1.6,        // s of charge granted to balls it holds.
    vortexMax: 4,             // Live vortices allowed at once; excess replaces the oldest.
  },

  /* ----------------------------------------------------------------- input -- */
  input: {
    maxPointers: 10,          // Independent fields tracked at once.
    hintFadeTime: 0.7,        // s. Fade-out of the first-run touch hint.
    hintPulsePeriod: 1.9,     // s. Pulse period of that hint.
    scatterTapCount: 3,       // Taps in the two-finger gesture that re-scatters balls.
    scatterTapWindow: 0.62,   // s. Maximum gap between those taps.
    scatterFingers: 2,        // Fingers required for the re-scatter gesture.
    debugFingers: 4,          // Fingers in the tap that toggles the debug overlay.
    debugTapMaxTime: 0.35,    // s. Maximum duration of that four-finger tap.
    upgradeMenuFingers: 3,    // Fingers in the tap that opens the upgrade menu. Only listened
                              // for while the debug overlay is already up, so it takes two
                              // deliberate gestures to reach and never fires during real play.
    soakPointers: 3,          // Synthetic pointers used by ?soak=1.
    soakChangeRate: 1.3,      // 1/s. How often a soak pointer picks a new target.
    soakHoldChance: 0.3,      // Probability a soak pointer holds still (exercising gather/sling).
  },

  /* ----------------------------------------------------------------- debug -- */
  debug: {
    enabled: false,           // Overlay off by default. 'D' or a four-finger tap toggles it.
    errorBufferSize: 12,      // Ring-buffer capacity for captured errors.
    frameFailSoftReset: 2,    // Consecutive frame-loop throws before the effects layer soft-resets.
    fpsWindow: 40,            // Frames averaged for the fps readout.
    wipeHoldTime: 1.6,        // s. Hold on the overlay's wipe target to erase the save.
    cornerSize: 56,           // px. Side of the top-left corner patch you hold to open the overlay.
                              // A phone has no D key, and iOS eats multi-finger taps, so one
                              // finger held in a corner is the only entry that reliably works.
    cornerHoldTime: 1.5,      // s. How long to hold there. Long enough that play never trips it.
    cornerArcDelay: 0.35,     // s. Silence before the progress arc appears, so an ordinary
                              // corner touch does not flash a widget at you.
  },
};

/* -------------------------------------------------------------------------- */

/**
 * Deep-clone CONFIG, optionally applying dotted-path overrides.
 * Tests use this to poke a single number without mutating the shared config:
 *   cloneConfig({ 'world.idleDriftStrength': 0 })
 */
export function cloneConfig(overrides) {
  const out = deepClone(CONFIG);
  if (overrides) {
    for (const path of Object.keys(overrides)) {
      setPath(out, path, overrides[path]);
    }
  }
  return out;
}

function deepClone(v) {
  if (Array.isArray(v)) return v.map(deepClone);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = deepClone(v[k]);
    return o;
  }
  return v;
}

function setPath(obj, path, value) {
  const parts = String(path).split('.');
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (node[parts[i]] == null || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

/** Ordered list of every ball-type key, ORB first. */
export const TYPE_KEYS = ['ORB', ...CONFIG.unlockOrder];

export default CONFIG;
