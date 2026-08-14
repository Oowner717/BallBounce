# Orbs

A full-screen canvas of small glowing balls drifting in near-zero gravity. Wherever you
touch, a soft force field follows your finger and shoves them around. Hold nearly still and
the field morphs into an attractor that gathers balls into orbit; let go and it slings the
whole orbit into the crowd. Hard collisions score, and every ball type does something
different when it gets hit hard.

No fail states, no timers, no streaks, no notifications. Nothing punishes you for stopping.

Vanilla JS and Canvas 2D. No frameworks, no libraries, no build step, no runtime
dependencies — just static files.

---

## Running it

### Locally (this is the flow that gives you offline + install)

```sh
cd orbs
python3 -m http.server 8080
```

Then open **http://localhost:8080/**.

`localhost` counts as a secure context, so the service worker registers and offline
reload works. You can prove it: load the page, wait a few seconds for the precache, turn
off the network, and reload.

### From your phone on the same WiFi — quick look only

```sh
# find your machine's LAN address
ipconfig getifaddr en0        # macOS
hostname -I                   # Linux
```

Then open `http://<that-address>:8080/` on the phone.

**Be honest with yourself about what this does and does not give you.** A plain-http LAN
address is *not* a secure context, so:

- the service worker will not register (the page is coded to not even try),
- there is no offline support,
- "Add to Home Screen" will produce a bookmark that needs the server running, not a real
  standalone install.

It is fine for glancing at the physics on a real touchscreen. It is not the install. For
that you need HTTPS — see Deployment below.

`file://` does not work at all: ES modules are blocked by CORS and service workers are
refused outright.

### Installing it properly on iPhone

From the **HTTPS** deployment, in **Safari** (not Chrome — only Safari can install to the
Home Screen on iOS):

1. Open the site.
2. **Share** → **Add to Home Screen**.
3. Launch it from the icon.

It opens borderless: no address bar, no toolbar, full bleed under the notch, with a
black-translucent status bar.

---

## Deployment

### GitHub Pages — needs one click from you first

`.github/workflows/pages.yml` is in the repo and working. It runs the tests, then publishes
`./orbs` as the **site root**, so the app ends up at `https://<owner>.github.io/<repo>/`
rather than at `/orbs/`.

**It cannot finish on its own, and has not.** The workflow asks the API to switch Pages on
(`actions/configure-pages` with `enablement: true`), but the default `GITHUB_TOKEN` is not
permitted to enable Pages on a repository where it has never been enabled. The run fails at
that step with:

```
Create Pages site failed. Error: Resource not accessible by integration
```

That is a repository setting, not something a workflow can grant itself. **There is no live
URL yet.** To get one:

1. **Settings → Pages → Build and deployment → Source: “GitHub Actions”.** This is the one
   click that cannot be automated from CI.
2. Re-run the workflow — Actions → *Deploy Orbs to GitHub Pages* → **Run workflow** — or just
   push any commit to the branch.

```sh
# or from a shell, once Pages is enabled:
gh workflow run "Deploy Orbs to GitHub Pages" --ref claude/orbs-physics-toy-6vnxwx
gh run watch
```

The published URL is printed by the last step of the run and shown on the Pages settings
page. It will almost certainly be `https://oowner717.github.io/BallBounce/` — but that is a
prediction, not a fact. Take the URL from the run output.

The `test` job is deliberately separate from `deploy`, so the test signal stays green and
meaningful whether or not Pages is enabled.

### Netlify, as an alternative

```sh
npm i -g netlify-cli
cd orbs
netlify deploy --dir . --prod
```

There is no build command and nothing to install; `--dir .` publishes the folder as-is.
Drag-and-dropping the `orbs` folder onto <https://app.netlify.com/drop> does the same
thing without a CLI.

### Every deploy must bump `CACHE_VERSION`

The first line of real code in `sw.js` is:

```js
const CACHE_VERSION = 'orbs-v1';
```

**Bump it on every deploy.** The browser decides a service worker has changed by
byte-diffing `sw.js` itself, so changing that literal is both the update trigger and the
cache invalidation. It deliberately is not imported from `config.js` — an imported constant
would leave `sw.js` byte-identical and the update would never be noticed. `sw.js` also has
to stay a classic script for the same reason.

Caches are namespaced by an `orbs-cache-` prefix and only that prefix is ever deleted.
`CacheStorage` is scoped per **origin**, not per path, and GitHub Pages puts every one of
your repositories on the same origin — an unprefixed cleanup would wipe the offline data of
every neighbouring project.

---

## Tests

```sh
cd orbs
node test.js
```

Zero installs, `node:assert` only, exits 0 on success. Takes about 70 seconds — most of
that is genuine simulation: a 12,000-step soak under random max-strength fields, two
4,000-step determinism runs, and a 5,000-step chaos run.

62 tests covering determinism, stability, energy conservation, the population cap, the
effect budget, timer recovery, score/combo/level invariants, save corruption, and the sky.

The two that earn their keep most often:

- **Determinism** — the same seed and the same scripted inputs must produce a bit-identical
  state hash after thousands of steps. This is what keeps `sim.js` honest about not
  reaching for `Date.now()` or `Math.random()`.
- **Energy sanity** — with idle drift zeroed and no input, total kinetic energy must be
  monotonically non-increasing across every window. This catches positional collision
  correction quietly pumping energy into the world, which makes an untouched screen slowly
  boil.

---

## Controls

|                              | |
|------------------------------|---|
| Touch / drag                 | Push balls. Swipe fast to fling them *along* the swipe. |
| Hold nearly still            | The field becomes an attractor and gathers an orbit. |
| Release (or flick) a gather  | Slings the whole orbit. This is how you spike big combos. |
| Multi-touch                  | Every finger is its own independent field. |
| Two-finger triple-tap        | Re-scatter the balls. Does not touch your score. |
| Four-finger tap, or `D`      | Debug overlay. |
| `R`                          | Re-scatter (desktop shortcut). |
| `?soak=1`                    | Synthesises random multi-touch for hands-free stress runs. |
| `?debug=1`                   | Start with the overlay open. |
| `?seed=12345`                | Fixed PRNG seed, for reproducing something. |

The debug overlay shows fps, physics and draw milliseconds, ball and particle counts,
sanitizer hits, dropped effect events, the error ring buffer, and a **hold-to-wipe** target
for erasing the save.

---

## Architecture

| File | |
|---|---|
| `config.js` | Every tunable, with a comment per entry. |
| `sim.js` | Pure simulation. No DOM, no canvas, no `Date.now()`, no `Math.random()`. |
| `main.js` | Rendering, input, effects, persistence, service-worker glue. |
| `test.js` | `node test.js`. |
| `sw.js` | Classic-script service worker. |
| `tools/make-icons.mjs` | Regenerates the icons. Node builtins only. |

**`config.js` is the tuning surface.** Nothing numeric hides in `sim.js`, and every key in
`config.js` is read by something — there are no dead controls.

Some knobs are coupled, and the file says so where they are. The one worth knowing about:
`gather.orbitRadius`, `orbitSpring` and `orbitSpin` together determine where balls actually
settle, which is *not* `orbitRadius` — a ball orbiting at speed `v` needs centripetal
acceleration `v²/d`, so the orbit settles where the spring supplies exactly that.
`main.js` solves for that radius when it draws the ring, so retuning any of the three keeps
the visual honest.

**`sim.js` is deterministic by construction.** Time is passed into `step()` and randomness
comes from an injected seeded PRNG. Same seed plus same inputs, same state, forever.

Rendering, in case it looks wrong later:

- Trails fade an **offscreen** layer with `destination-out`, then that layer is composited
  **additively**. A translucent black rect over a dark scene leaves permanent grey ghosting;
  so, less obviously, does compositing the trail layer with `source-over` once its
  accumulated alpha saturates, because that replaces the background instead of adding to it.
- Bloom draws the trail layer into a quarter-resolution offscreen canvas and draws it back
  upscaled with `lighter`. The resample *is* the blur. `ctx.filter` is not reliable on iOS.
- The simulation runs in CSS pixels; only the canvas backing store is scaled by
  `devicePixelRatio`, capped at 2. Forces and radii scale from a reference dimension, so an
  iPhone SE and an iPad feel the same.
- White hot-centres are drawn on the crisp layer, never into the trail — in the trail they
  desaturate every streak to grey mush as it fades.

### Two mechanisms that are not obvious from reading the code

**Charge.** Type effects only fire on balls carrying "charge" — energy traceable back to a
finger. Touching a ball charges it; a hard impact passes on a decaying fraction; each effect
passes a fraction to whatever it catches. Without this, a detonation throws balls well past
the hard-impact threshold, which detonates more volatiles, forever: an untouched screen sat
at combo 27,000 and never calmed down. Scoring is *not* gated this way — a hard impact is a
hard impact. Only effects are.

**The combo counts moments of contact, not collisions.** A cascade fires hundreds of hard
impacts per second, so tallying each one turned the combo into a five-figure collision
counter within a minute and compounded into billions of points. `score.comboMaxPerStep`
caps its growth per step. GOLD's jump is exempt, because that jump is the point of finding
one.

---

## Resilience

Designed for a phone that never gets a debugger attached.

- A sanitizer runs every step. NaN, Infinity, or a ball that has left the world is repaired
  in place — respawned at an edge if it genuinely escaped — and counted in the overlay. The
  simulation cannot be killed.
- `window.onerror` and `unhandledrejection` feed a ring buffer shown in the overlay. If the
  frame loop throws twice in a row, the effects layer soft-resets and the simulation keeps
  running. The simulation step and the render step are wrapped separately, so a drawing bug
  cannot stop the physics.
- Saves are versioned and parsed defensively. Corrupt JSON, a wrong version, missing or
  hostile fields — anything wrong loads clean defaults and never throws.
- If `localStorage` is missing or full (private mode), play continues without persistence
  and the overlay says so.
- `pointercancel`, `pointerleave` and window blur all clear their fields. iOS fires
  `pointercancel` on system gestures, and a stuck invisible field is the bug you would
  otherwise spend an evening reproducing.
- The app pauses on `visibilitychange` and clamps the first frame after resuming, so
  returning to it does not teleport every ball.
- Resize and rotation re-measure and re-clamp every ball.
- Wiping the save resets the *running* session too. Deleting the key alone is not enough —
  the next autosave writes the old state straight back and the wipe silently un-happens.

Performance: physics costs about 0.2 ms per frame with ~90 balls and 0.42 ms at the full
150. If sustained fps drops, the renderer sheds particles and bloom resolution — never
physics.

---

## On-device checklist

Everything else has been verified here: `node test.js` is green, offline reload works on
`localhost`, a 5-minute `?soak=1` run leaves the error buffer empty, the save survives a
reload (and an offline reload), a wipe gives a clean first run, ten untouched seconds land
in CALM, three simultaneous fields work, `pointercancel` leaves no stuck field, rotation
re-clamps every ball, and play continues with `localStorage` throwing.

These are the ones that need a real iPhone, because a headless Chromium cannot tell you
about them:

- [ ] **Full-bleed under the notch.** Launched from the Home Screen icon: no address bar,
      no toolbar, black-translucent status bar, and the canvas paints edge to edge
      including under the notch and around the home indicator.
- [ ] **The HUD clears the notch.** Score, combo and level bar sit inside the safe area —
      not tucked under the sensor housing or the home indicator.
- [ ] **Nothing scrolls or bounces.** No rubber-band at the top or bottom, no pinch zoom,
      no double-tap zoom, no text selection, no long-press callout.
- [ ] **Three simultaneous fields** feel independent under three real fingers.
- [ ] **Gather → sling feels good.** Hold still until the ring forms, then release, and
      again with a flick. This is the thing most worth tuning by hand; the knobs are
      `gather.*` in `config.js` and the coupling note above explains which ones interact.
- [ ] **60fps.** Physics is 0.42 ms at 150 balls, but drawing was only ever measured under
      software rendering here — the GPU path is untested. If it drops, the debug overlay
      (four-finger tap) shows the split between `phys` and `draw`.
- [ ] **Install from HTTPS** via Safari → Share → Add to Home Screen.
- [ ] **Relaunch with WiFi off.** It should open and play normally.
- [ ] **The sky gains stars across sessions.** Best seen in CALM, after leaving it alone
      for ten seconds, over several days of milestones.
