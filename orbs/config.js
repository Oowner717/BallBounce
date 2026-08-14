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
    radius: 118,              // px @ref. Field reach.
    radiusGather: 250,        // px @ref. Reach once fully morphed into an attractor. Deliberately
                              // MUCH wider than the push radius: the push evacuates its own
                              // neighbourhood, so a same-size attractor would have nothing left
                              // to gather. Reaching past the hole is what makes gather work.
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
    stillSpeed: 130,          // px/s @ref. Field speed below which the finger counts as "held still".
    stillTime: 0.26,          // s. How long it must stay still before the morph starts.
    morphIn: 0.55,            // s. Time to fully become an attractor.
    morphOut: 0.22,           // s. Time to fall back to push once the finger moves again.
    orbitRadius: 46,          // px @ref. Radius of the orbit shell balls settle into.
    orbitSpring: 21.0,        // 1/s^2-ish. Radial spring pulling balls to the shell.
    orbitDamp: 3.1,           // 1/s. Damping on the radial velocity component. Kills bouncing in/out.
    orbitSpin: 430,           // px/s @ref. Tangential speed injected; this is what makes it *orbit*.
    orbitSpinGain: 3.4,       // 1/s. How hard tangential velocity is driven toward orbitSpin.
    spinRampTime: 0.5,        // s. Time for the spin to reach full strength after the morph.
    pull: 1900,               // px/s^2 @ref. Ceiling on the inward pull. The spring is clamped to
                              // this, which turns it into a near-constant haul at long range and a
                              // proper shell spring up close.
    pushOutCap: 0.5,          // Outward spring force inside the shell, as a fraction of `pull`.
    captureRadius: 175,       // px @ref. Balls inside this at release are considered "in the orbit".
    maxCapture: 46,           // Ceiling on balls a single sling can throw, for frame-time sanity.

    slingBase: 620,           // px/s @ref. Base speed added to every slung ball.
    slingPerBall: 5.2,        // px/s @ref added per additional captured ball. Big orbits hit harder.
    slingSpin: 0.55,          // Fraction of orbital tangential velocity retained through the sling.
    slingSpread: 0.34,        // Radians of random cone spread around the sling direction.
    flickSpeed: 290,          // px/s @ref. Release speed above which the sling follows the flick.
    flickGain: 1.15,          // Multiplier on flick velocity folded into the sling.
    slingChargeMax: 2.6,      // s. Hold time at which sling power saturates.
    slingChargeGain: 0.75,    // Extra sling power at full charge (0.75 = +75%).
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
  },

  /* ------------------------------------------------------------ population -- */
  population: {
    startCount: 74,           // Balls present on a brand-new save.
    softCapBase: 86,          // Target population at level 1. Levels nudge this up.
    softCapPerLevel: 1.6,     // Extra target population per level beyond the first.
    hardCap: 150,             // Absolute ceiling. Splitters may never push the count past this.
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
  },

  /* ----------------------------------------------------------------- balls -- */
  balls: {
    radiusMin: 5.0,           // px @ref. Smallest naturally spawned ball.
    radiusMax: 11.5,          // px @ref. Largest naturally spawned ball.
    radiusBias: 1.7,          // Exponent on the radius roll; >1 biases toward small balls.
    minSplitRadius: 3.4,      // px @ref. A splitter below this will not split again.
    densityExp: 2,            // mass = density * r^densityExp. 2 = "area", reads right in 2D.
    density: 0.022,           // Mass per r^densityExp. Only ratios matter.
    glowScale: 2.6,           // Halo radius as a multiple of ball radius (render only).
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
      scoreEach: 8,           // Flat score per ball caught in the blast, before multipliers.
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
      dragAssist: 0.2,        // How strongly a magnet drags a captured ball along its own motion.
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
      shardScore: 14,         // Flat score for a shard touching a ball, before multipliers.
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
      scoreEach: 12,          // Flat score per jolted ball, before multipliers.
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
      scoreEach: 10,          // Flat score per frozen ball, before multipliers.
      immuneTime: 1.6,        // s. Post-thaw immunity, so a ball cannot be chain-frozen forever.
    },
    GOLD: {
      weight: 3.43,           // ~2.0% of the pool once every type is unlocked (3.43/171.4). Rare on purpose.
      score: 26.0, unlockLevel: 8,
      label: 'GOLD',
      comboJump: 4,           // Combo steps granted by a gold hard impact.
      neverDespawn: true,     // Gold is never quietly removed by the population manager.
      glitterRate: 22,        // Glints per second (render only).
      scoreFlat: 260,         // Flat bonus on a gold hard impact, before multipliers.
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
    energyScale: 42,          // Score per unit of normalised impact energy. The master score knob.
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
    comboMultScale: 0.42,     // Coefficient in mult = 1 + scale * count^exp.
    comboMultExp: 0.62,       // Sublinear growth exponent. Uncapped, but never runaway.
    comboStepPerHit: 1,       // Combo steps per hard impact.
    popupMinScore: 1,         // Smallest score that spawns a floating popup.
    popupMerge: 0.09,         // s. Popups at nearly the same spot inside this window merge.
    rollTau: 0.16,            // s. Counter roll time constant. The counter never snaps.
    rollSnapBelow: 0.5,       // Difference below which the rolling counter finally lands.
  },

  /* ---------------------------------------------------------------- levels -- */
  levels: {
    base: 240,                // XP for level 2. Small so the first unlock lands inside ~15s.
    exp: 1.62,                // Threshold growth exponent. threshold(n) = base * n^exp + linear*n.
    linear: 130,              // Linear term, keeps early levels from being trivially close together.
    maxCelebrated: 999,       // Levels above this celebrate quietly (never reached in practice).
    capNudgeStart: 8,         // Level at which each level-up starts nudging the ball soft cap upward.
    capNudgePerLevel: 1.6,    // Soft-cap increase per level past capNudgeStart.
    unlockCelebrateTime: 2.4, // s. Length of a type-unlock celebration.
    levelCelebrateTime: 1.1,  // s. Length of an ordinary level-up flourish.
  },

  /* ------------------------------------------------------------ milestones -- */
  milestones: {
    // Lifetime-score milestones. Generated as m * 10^k for each mantissa, ascending.
    mantissas: [1, 2.5, 5],   // 1k, 2.5k, 5k, 10k, 25k, 50k, 100k...
    startExp: 3,              // First decade: 10^3 = 1,000.
    maxExp: 12,               // Last decade tracked: 10^12.
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

  /* ---------------------------------------------------------------- effects -- */
  effects: {
    maxPerFrame: 48,          // Hard budget on sim-emitted effect events per step. Excess is DROPPED,
                              // never queued — a queued backlog is how a phone dies.
    maxParticles: 900,        // Renderer particle ceiling at full quality.
    particleShedFps: 48,      // fps below which particles start being shed.
    particleShedFloor: 0.25,  // Minimum fraction of the particle budget when shedding hard.
    bloomShedFps: 42,         // fps below which bloom resolution is halved.
    bloomMinScale: 0.14,      // Smallest bloom downscale factor.
    impactSparks: 7,          // Sparks per hard impact at full quality.
    detonateSparks: 26,       // Sparks per detonation.
    shatterSparks: 12,        // Sparks per freeze-shatter.
    shockwaveTime: 0.45,      // s. Shockwave ring lifetime.
    flashTime: 0.14,          // s. Screen flash lifetime.
    flashMaxAlpha: 0.20,      // Peak screen-flash alpha at FRENZY. Never blinding.
    shakeMax: 7.5,            // px @ref. Peak screen shake.
    shakeDecay: 7.0,          // 1/s. Shake decay rate.
    popupLife: 1.05,          // s. Floating score popup lifetime.
    popupRise: 52,            // px @ref. Distance a popup floats upward.
  },

  /* ---------------------------------------------------------------- render -- */
  render: {
    dprCap: 2,                // devicePixelRatio ceiling. Above 2 costs fill rate and buys nothing.
    trailFade: 0.115,         // Per-frame alpha erased from the trail layer with 'destination-out'.
                              // A translucent black rect over a dark scene ghosts grey; this does not.
    trailFadeCalm: 0.055,     // Slower trail fade in CALM: long, lazy streaks.
    trailFadeFrenzy: 0.18,    // Faster fade in FRENZY, or the screen turns to soup.
    bloomScale: 0.25,         // Bloom buffer size relative to the stage. The resample IS the blur.
    bloomPasses: 2,           // Upscale-composite passes with 'lighter'.
    bloomStrength: 0.85,      // Alpha of the bloom composite.
    bloomStrengthCalm: 0.55,  // Gentler bloom when quiet.
    bloomStrengthFrenzy: 1.0, // Full bloom when loud.
    starTwinkle: 0.35,        // Amplitude of star twinkle.
    hudMargin: 16,            // px. HUD inset, applied *inside* env(safe-area-inset-*).
    hudAlphaCalm: 0.5,        // HUD opacity when calm — the numbers recede when nothing is happening.
    hudAlphaActive: 0.95,     // HUD opacity when playing.
    ringRadius: 34,           // px @ref. Radius of the combo ring drawn at each finger.
    ringWidth: 3.0,           // px @ref. Combo ring stroke width.
    fieldRingAlpha: 0.5,      // Base opacity of the finger ring.
    levelBarHeight: 3.0,      // px. Thickness of the level bar.
    fontStack: 'ui-rounded, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  },

  /* -------------------------------------------------------------- palettes -- */
  // Every few levels permanently unlocks a colour world. No picker, ever.
  // Long sessions drift gently between unlocked palettes.
  paletteRules: {
    unlockEvery: 3,           // Levels between palette unlocks.
    driftPeriod: 95,          // s. Time to drift from one unlocked palette to the next.
    driftHold: 45,            // s. Time spent settled on a palette before drifting again.
    driftOnlyWhenCalm: false, // If true, drift pauses during FRENZY. Off: drift is slow enough to hide.
  },

  palettes: [
    {
      name: 'Ember',          // Starting world. Warm coals on near-black.
      bg0: '#0b0607', bg1: '#1a0b08', fog: '#e0703a',
      hud: '#ffd9b0', hudDim: '#a6704e', ring: '#ff9a4d', star: '#ffd9a8',
      orbHues: ['#ff8a3d', '#ffb703', '#ff5f45', '#ffd08a'],
      type: {
        VOLATILE: '#ff4d2e', SPLITTER: '#ffb703', MAGNET: '#ff8fa3',
        PRISM: '#ffe6b0', CHAIN: '#ffd166', FROST: '#9fd8e0', GOLD: '#ffe066',
      },
    },
    {
      name: 'Deep Sea',       // Cold, quiet, bioluminescent.
      bg0: '#02060d', bg1: '#04182b', fog: '#2aa9c9',
      hud: '#c8f0ff', hudDim: '#4d7f96', ring: '#3fd4ff', star: '#bfeaff',
      orbHues: ['#38bdf8', '#22d3ee', '#5eead4', '#7dd3fc'],
      type: {
        VOLATILE: '#ff6b6b', SPLITTER: '#67e8f9', MAGNET: '#a78bfa',
        PRISM: '#ccfbf1', CHAIN: '#7dd3fc', FROST: '#e0f2fe', GOLD: '#ffd24a',
      },
    },
    {
      name: 'Aurora',         // Green-violet curtains.
      bg0: '#03080a', bg1: '#0a1f1c', fog: '#4ade80',
      hud: '#d7ffe9', hudDim: '#5f8f78', ring: '#5eead4', star: '#d9ffe8',
      orbHues: ['#4ade80', '#2dd4bf', '#a78bfa', '#86efac'],
      type: {
        VOLATILE: '#fb7185', SPLITTER: '#86efac', MAGNET: '#c084fc',
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
      name: 'Monochrome',     // Pure light on pure dark. The calmest world.
      bg0: '#050505', bg1: '#101012', fog: '#9aa0a6',
      hud: '#f2f2f2', hudDim: '#7a7a7a', ring: '#e6e6e6', star: '#ffffff',
      orbHues: ['#f5f5f5', '#c9c9c9', '#9e9e9e', '#e0e0e0'],
      type: {
        VOLATILE: '#ffffff', SPLITTER: '#d4d4d4', MAGNET: '#b0b0b0',
        PRISM: '#ffffff', CHAIN: '#e8e8e8', FROST: '#f0f6ff', GOLD: '#fff3c4',
      },
    },
    {
      name: 'Solar',          // White-hot cores, corona edges.
      bg0: '#0c0602', bg1: '#241102', fog: '#ffb020',
      hud: '#fff0cf', hudDim: '#a8794a', ring: '#ffc247', star: '#fff2cf',
      orbHues: ['#ffd166', '#ff9f1c', '#fff3b0', '#ff7b00'],
      type: {
        VOLATILE: '#ff3d00', SPLITTER: '#ffb703', MAGNET: '#ff9e80',
        PRISM: '#fffbe6', CHAIN: '#ffd166', FROST: '#cfe8ff', GOLD: '#fff08a',
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
  },

  /* -------------------------------------------------------------- filigree -- */
  // Lifetime best-combo tiers add permanent ornament to the finger ring. Cosmetic only.
  filigree: {
    tiers: [8, 20, 40, 75, 130, 220, 400],  // Best-combo thresholds. Tier = count of thresholds passed.
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
    scorePerChip: 420,        // Flat score per chip, before multipliers.
    scoreBreak: 5200,         // Flat score for breaking it.
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
