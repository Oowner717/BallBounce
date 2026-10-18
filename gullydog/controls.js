/*
 * controls.js — how the sticks feel. Pure functions: input.js and main.js use
 * them, test.js checks them.
 *
 * The movement stick's left-right axis steers. Held to one side, the view (and
 * the dog with it) swings round at a rate set by how far the stick is pushed:
 * nothing inside the dead zone, gently near the middle, fastest at the rim. That
 * rate eases in and out instead of jumping, so a turn is an arc, not a snap.
 * The right stick and the look keys work the same way.
 */

export const CONTROLS = {
  deadzone: 0.12,   // of the left-right travel: a thumb a little off centre still runs straight
  turnCurve: 1.7,   // > 1 is less sensitive near the middle (half way is about a quarter speed)
  maxTurn: 2.0,     // rad/s of steering at the rim, about 115 degrees a second
  backTurn: 0.35,   // steering while walking back toward the camera is weaker
  aimCurve: 1.5,    // how much a part-push to one side bends the dog's path
  lookDeadzone: 0.15,
  lookCurve: 1.8,
  maxLookX: 2.4,    // rad/s, right stick or look keys at the rim
  maxLookY: 1.2,
  ease: 9,          // 1/s: how quickly a turn rate catches up with the stick
};

/** One stick axis after the dead zone and the response curve: 0 at rest, ±1 at the rim. */
export function shapeAxis(v, deadzone, power) {
  const a = Math.abs(v);
  if (a <= deadzone) return 0;
  return Math.sign(v) * Math.pow(Math.min(1, (a - deadzone) / (1 - deadzone)), power);
}

/**
 * How fast the view swings, in rad/s (positive turns right), for the movement
 * stick at (x to the right, y forward), each -1..1.
 */
export function steerRate(x, y, C = CONTROLS) {
  const r = shapeAxis(x, C.deadzone, C.turnCurve) * C.maxTurn;
  return y < -0.2 ? r * C.backTurn : r;
}

/**
 * The movement stick with its sideways part softened, so a part-push to one side
 * bends the dog's path less than it used to. How far the stick is pushed (and so
 * the dog's speed) is kept; straight sideways stays straight sideways.
 */
export function aimStick(x, y, C = CONTROLS) {
  const m = Math.min(1, Math.hypot(x, y));
  if (m < 1e-4) return [0, 0];
  const cx = Math.sign(x) * Math.pow(Math.abs(x), C.aimCurve);
  const l = Math.hypot(cx, y);
  return l < 1e-9 ? [0, 0] : [(cx / l) * m, (y / l) * m];
}

/** Ease a rate toward its target. Exact for any frame time, so it feels the same at 30 or 120 fps. */
export function easeRate(current, target, dt, C = CONTROLS) {
  return target + (current - target) * Math.exp(-C.ease * dt);
}

/** Move v toward target by at most step: for ramping a digital key in and out. */
export function rampTo(v, target, step) {
  return v < target ? Math.min(target, v + step) : Math.max(target, v - step);
}
