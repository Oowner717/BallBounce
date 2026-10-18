/*
 * config.js — every gameplay number in Gully Dog, in one place.
 *
 * sim.js, traffic.js, crowd.js, fauna.js and tasks.js read from here and
 * hard-code nothing that a person might want to tune. Units are metres, seconds
 * of REAL time, and game hours where a value says so.
 *
 * The game clock runs at `time.scale` game minutes per real second, so the
 * working day from 6 am to 10 pm lasts a little over thirteen real minutes.
 */

export const CONFIG = {

  /* ----------------------------------------------------------------- time */
  time: {
    scale: 1.2,            // game minutes per real second
    sleepScale: 10,        // multiplier on scale while the dog is asleep
    startHour: 6.5,        // when a new day begins
    bedtime: 21.5,         // sleeping after this ends the day
    collapseHour: 2,       // too late: the dog falls asleep wherever it is
    maxDt: 0.05,           // a single step never integrates more than this
  },

  /* ------------------------------------------------------------------ dog */
  dog: {
    radius: 0.27,
    walkSpeed: 1.5,        // stick half-pushed
    trotSpeed: 3.4,        // stick fully pushed
    runSpeed: 7.0,         // sprinting (costs energy)
    tiredSpeed: 2.4,       // cap when energy is nearly gone
    accel: 18,             // m/s^2 on the ground
    airAccel: 5,
    turnRate: 10,          // rad/s toward the direction of travel
    gravity: 19.6,
    jumpSpeed: 5.3,        // ~0.7 m of jump: onto benches, charpais, the island kerb
    stepUp: 0.32,          // kerbs and steps are climbed without jumping
    barkCooldown: 0.45,
    barkRadius: 6,         // how far a bark startles people and birds
    sniffDuration: 4.5,
    sniffCooldown: 5,
    sniffRange: 60,        // how far away a scent can be picked up
    hitInvuln: 1.5,        // seconds of grace after being hit by a vehicle
    reach: 0.9,            // eating, picking up, grabbing
  },

  /* ---------------------------------------------------------------- needs */
  needs: {
    hungerPerHour: 11,     // 100 -> 0 in ~9 game hours
    thirstPerHour: 14,
    heatThirstMult: 1.9,   // standing in the midday sun
    runHunger: 0.22,       // extra per real second of sprinting
    runThirst: 0.3,
    runEnergy: 2.0,        // per real second sprinting
    trotEnergy: 0.12,
    walkEnergy: 0.02,
    sitEnergy: 0.35,       // recovered per real second
    lieEnergy: 0.9,
    sleepEnergy: 2.6,
    moodDecayPerHour: 3,   // mood drifts toward neutral
    moodNeutral: 55,
    healthRegen: 0.06,     // per real second while fed and watered
    starve: 0.25,          // health lost per second at 0 hunger or thirst
    heatStart: 11.5, heatEnd: 15.5, // when the sun is fierce
  },

  /* ---------------------------------------------------------------- food */
  food: {
    biscuit: { hunger: 8, mood: 2 },
    roti: { hunger: 16, mood: 3 },
    samosa: { hunger: 18, mood: 6 },
    jalebi: { hunger: 10, mood: 8 },
    ladoo: { hunger: 12, mood: 10 },
    bone: { hunger: 14, mood: 6 },
    milk: { hunger: 10, thirst: 22, mood: 4 },
    scraps: { hunger: 9, mood: 0, sick: 0.12 },
    eatTime: 1.6,
    drinkTime: 2.4,
    drinkGain: 34,
    rummageTime: 2.6,
    rummageFind: 0.55,     // chance a rummage turns something up
    rummageCooldown: 90,   // game minutes before the same pile has more
    itemLife: 5,           // game hours before dropped food is gone
    carryWhenFull: 75,     // hunger at or above which E picks food up instead of eating it
  },

  /* -------------------------------------------------------------- traffic */
  traffic: {
    maxVehicles: 58,
    // vehicles per real minute arriving on each arm, by time of day
    rate: { night: 6, morning: 30, day: 24, evening: 34 },
    mixMG: [[26, 'auto'], [24, 'scooter'], [14, 'bike'], [16, 'car'], [5, 'taxi'], [6, 'bus'], [4, 'truck'], [3, 'cycle'], [2, 'rickshaw']],
    mixBazaar: [[24, 'auto'], [28, 'scooter'], [14, 'bike'], [8, 'car'], [10, 'cycle'], [12, 'rickshaw'], [2, 'truck']],
    turn: { straight: 0.5, left: 0.25, right: 0.2, u: 0.05 },
    types: {
      auto: { model: 'auto', len: 2.4, halfW: 0.66, vmax: 9.5, accel: 2.4, decel: 6.5, honk: 0.9, horn: 'auto' },
      scooter: { model: 'scooter', len: 1.8, halfW: 0.36, vmax: 11.5, accel: 3.6, decel: 7, honk: 0.8, horn: 'scooter' },
      bike: { model: 'bike', len: 1.9, halfW: 0.36, vmax: 12.5, accel: 3.8, decel: 7, honk: 0.75, horn: 'scooter' },
      car: { model: 'car', len: 3.7, halfW: 0.8, vmax: 12.5, accel: 2.6, decel: 7, honk: 0.6, horn: 'car' },
      taxi: { model: 'car', len: 3.7, halfW: 0.8, vmax: 12, accel: 2.5, decel: 7, honk: 0.8, horn: 'car' },
      bus: { model: 'bus', len: 10.1, halfW: 1.28, vmax: 9.5, accel: 1.3, decel: 5, honk: 1.0, horn: 'bus' },
      truck: { model: 'truck', len: 7.2, halfW: 1.23, vmax: 8.5, accel: 1.1, decel: 5, honk: 1.0, horn: 'truck' },
      cycle: { model: 'cycle', len: 1.8, halfW: 0.33, vmax: 4.6, accel: 1.3, decel: 5, honk: 0.5, horn: 'bell' },
      rickshaw: { model: 'rickshaw', len: 2.6, halfW: 0.6, vmax: 3.6, accel: 1.0, decel: 4, honk: 0.5, horn: 'bell' },
    },
    lookBase: 3.5,         // lookahead = lookBase + v * lookPerSpeed
    lookPerSpeed: 1.6,
    minGap: 0.9,           // metres kept to whatever is ahead when stopped
    latMargin: 0.25,       // side clearance when passing
    latSpeed: 1.3,         // m/s of sideways weaving
    curveAccel: 4.5,       // m/s^2 lateral limit in the roundabout
    yieldWindow: 1.25,     // radians of ring upstream an entering vehicle checks
    impatient: 4.0,        // seconds of waiting before merging more aggressively
    creepAfter: 10,        // seconds stuck behind another stuck vehicle before creeping
    despawnStuck: 35,      // seconds fully stuck (and far from the dog) before removal
    randomHonk: 0.035,     // honks per second per moving vehicle, before honkiness
    honkCooldown: [1.4, 4],
    busStopTime: 7,
    hitSpeed: 1.0,         // m/s above which touching the dog is a hit
    hitDamage: [6, 3.2, 40], // base, per m/s, cap
  },

  /* ---------------------------------------------------------------- crowd */
  crowd: {
    // people out on the street by hour (interpolated)
    population: [[0, 25], [5, 25], [6.5, 90], [8, 165], [11, 185], [13, 140], [16, 175], [18, 215], [20.5, 160], [22, 80], [24, 25]],
    walkSpeed: [1.05, 1.45],
    radius: 0.24,
    personalSpace: 0.75,   // how close they let the dog come before stepping around it
    separation: 1.6,
    browseTime: [6, 22],
    sitTime: [20, 70],
    chatChance: 0.25,
    crossWait: 3.2,        // seconds of clear road a crosser needs
    disposition: [[45, 'kind'], [35, 'neutral'], [13, 'grumpy'], [7, 'timid']],
    snackChance: 0.22,     // a kind passer-by who happens to be carrying something
    begTime: 1.3,          // seconds of sitting nicely before someone responds
    petCooldown: 120,      // seconds before the same person pets again
    spontaneousPet: 0.04,  // per second, a kind passer-by stops for a resting dog
    bubbleTime: 2.6,
  },

  /* --------------------------------------------------------------- animals */
  animals: {
    cowSpeed: 0.55,
    cowIgnoreBarks: 3,     // barks in a few seconds before a cow moves off
    birdScatterDist: 3.2,
    birdFlySpeed: 7.5,
    birdReturn: [8, 22],
    dogTerritory: 9,
    dogGrowlDist: 6,
    dogChaseDist: 3.4,
    dogChaseSpeed: 6.2,
    dogNipDamage: 4,
    friendGreet: 12,       // friendship per greeting
    friendFood: 30,        // friendship for sharing food
    friendCalm: 0.5,       // per second of calm company (up to calmCap)
    calmCap: 40,
    friendAt: 60,
    goatFleeSpeed: 3.2,
  },

  /* ------------------------------------------------------------- cricket */
  cricket: {
    bowlEvery: [4, 7],
    hitSpeed: [9, 17],
    fielderSpeed: 3.2,
    giveUp: 25,            // seconds chasing a dog with the ball before sulking
  },

  /* -------------------------------------------------------------- scenes */
  scenes: {
    auntyFeed: [[7.5, 8.75], [18.5, 19.75]],
    aarti: [18.5, 19.2],
    chaiBiscuitCooldown: 75, // game minutes
    halwaiChaseSpeed: 4.6,
    halwaiChaseTime: 10,
    halwaiGiveUp: 17,      // metres
    samosaRefill: 40,      // game minutes per samosa back on the tray
  },

  /* ----------------------------------------------------------------- cred */
  cred: {
    ranks: [[0, "Nobody's Pup"], [60, 'Gali Dog'], [180, 'Mohalla Favourite'], [400, 'Bazaar Boss'], [750, 'Gully King']],
    pet: 3, fed: 2, scatter: 2, fetch: 12, friend: 25, stole: 8, task: 20, prasad: 5, crossed: 2,
  },
};

export function cloneConfig(over) {
  const c = JSON.parse(JSON.stringify(CONFIG));
  if (over) deepMerge(c, over);
  return c;
}

function deepMerge(a, b) {
  for (const k of Object.keys(b)) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') deepMerge(a[k], b[k]);
    else a[k] = b[k];
  }
}
