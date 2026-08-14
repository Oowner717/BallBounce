# Orbs

A full-screen canvas of small glowing balls drifting in near-zero gravity. Wherever you
touch, a soft force field follows your finger and shoves them around. **Tap** for a pulse,
**double tap** to drop a vortex, or **hold still** and the field becomes an attractor that
gathers balls into orbit — let go and it slings the whole orbit into the crowd. Hard
collisions score, and every ball type does something different when it gets hit hard.

Levelling to the cap of 100 takes about an hour, and every level hands you a named upgrade
you can actually see land: it arrives in the colour of whatever it changed, and an upgrade that
changes a distance draws that distance at true size where your finger was. How close to an hour
depends a great deal on how you play — see the note on pacing below.

Hold a finger in the **bottom-right corner** for a moment and a help sheet opens, including one
row for every number your ninety-nine upgrades have touched, showing what it started at, what it
is now, and how many of the upgrades that feed it you own. Tap any row to watch it.

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

Being *offline* is the easy case — the fetch fails instantly and the cached shell is
served in well under a second. The case worth knowing about is **connected but dead**: a
captive portal, one bar of signal, a VPN reconnecting. There the socket is accepted and
nothing ever comes back, so navigation races a 2.5s deadline (`NAV_TIMEOUT_MS` in `sw.js`)
and paints from cache when the network loses. Without that, the platform's own timeout is
the only thing that ends the black screen — measured at 45s+ against a server that accepts
and never replies. The deadline is only armed when a cached shell exists, so a genuinely
slow first load is never turned into a failure.

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

### GitHub Pages — live

**https://oowner717.github.io/BallBounce/**

`.github/workflows/pages.yml` runs the tests, then publishes `./orbs` as the **site root**,
so the app is at the bare repo URL rather than at `/orbs/`. It triggers on pushes to
`main`, `master` or `claude/orbs-physics-toy-6vnxwx`, and can be run by hand from the
Actions tab.

Pages had to be switched on once by hand (Settings → Pages → Build and deployment →
Source: "GitHub Actions") because the default `GITHUB_TOKEN` is not permitted to enable
Pages on a repository where it never has been. That is done; every push now deploys on its
own.

To install it on the phone: open that URL in **Safari** → **Share** → **Add to Home
Screen**.

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
const CACHE_VERSION = 'orbs-v8';
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

### Picking up a new build

The worker calls `skipWaiting()` and `clients.claim()`, so a new version takes control the moment
it installs. That is not enough on its own, and the gap is worth writing down because it is
invisible until somebody is stuck in it:

- Claiming a page does **not reload** it. The modules already running are the old ones.
- An iOS home-screen app is **resumed** from the app switcher, not re-navigated, so it can go days
  without a fresh load.
- Assets are served **cache-first**. So even a reload, if it happens before the new worker has
  activated and swapped caches, hands the page back the exact build it was trying to leave.

So on resume — throttled to once a minute, and skipped entirely when `navigator.onLine` is false —
the app reads `CACHE_VERSION` straight out of `sw.js` and compares it to the value it booted with.
That fetch carries a unique query string, which is load-bearing: an already-installed **old**
worker is precisely what stands between a stuck app and the fix, and before the bail added to
`sw.js` it served its own script from its own cache, so a plain `./sw.js` fetch was answered with
the very build we were trying to move off, forever.

If the stamp has moved, the app deletes its own caches (only the `orbs-cache-` prefix — the origin
is shared) and reloads at the next quiet moment: two seconds untouched, or twenty-five if you never
stop playing. Deleting first is what makes the reload mean anything.

Asking `registration.update()` and waiting for the worker to claim the page was tried first and is
not dependable enough to hang this on — the call is advisory, and a fire-and-forget one frequently
did nothing at all. It is still called, because it is what actually swaps the cached assets; it is
just not what the decision to reload rests on.

A first launch never reloads itself. `hadController` is re-evaluated rather than captured once at
boot, because `main.js` runs before the worker is even registered — a value read once is `false`
forever, which both suppresses the first-run reload correctly and suppresses every later update
too.

---

## Tests

```sh
cd orbs
node test.js
```

Zero installs, `node:assert` only, exits 0 on success. Takes about 70 seconds — most of
that is genuine simulation: a 12,000-step soak under random max-strength fields, two
4,000-step determinism runs, and a 5,000-step chaos run.

100 tests covering determinism, stability, energy conservation, the population cap, the
effect budget, timer recovery, score/combo/level invariants, save corruption, the sky, the
comet, the resonances, the upgrade table, and the feel properties that are easy to fake.

The ones that earn their keep most often:

- **Determinism** — the same seed and the same scripted inputs must produce an identical
  state hash after thousands of steps. This is what keeps `sim.js` honest about not
  reaching for `Date.now()` or `Math.random()`. (That guarantee is per-engine: `Math.sin`
  and friends are implementation-defined in the last bit, so a replay is not promised to
  match across Node and Safari. Nothing depends on it.)
- **Energy sanity** — with idle drift zeroed and no input, total kinetic energy must be
  monotonically non-increasing across every window. This catches positional collision
  correction quietly pumping energy into the world, which makes an untouched screen slowly
  boil.
- **The gather actually gathers** — balls must reach the solved orbit shell *and* be
  circulating at close to `orbitSpin`. `radiusGather` once sat in the wrong config section,
  so the attractor applied no force at all — while the ring still drew, the morph still
  animated, and releasing still threw whatever had drifted nearby. It looked completely
  fine. Assert the physics, never the appearance.
- **Every config path the code reads exists** — a static scan of `sim.js` and `main.js` for
  `C.<section>.<key>` chains, resolved against `CONFIG`. That is the check that would have
  caught the above in a second rather than an afternoon.
- **A fast swipe flings along the swipe** — and measurably more so than a slow drag, so a
  regression to a plain radial push fails rather than passing quietly.
- **Unlocking a ball type puts that type on screen** — for four different types, within two
  seconds, with the population unchanged. Levels 2 to 8 used to announce seven ball types and
  spawn none of them; three of the seven never appeared at all in a fourteen-minute run.
- **Every MORE ORBS upgrade actually moves the cap** — ten of the original twenty raised a
  number that was already pinned behind the hard-cap clamp, and the test that should have
  noticed was itself measuring the wrong thing (it applied the upgrades without advancing the
  level, so it never saw the per-level nudge that does the pinning).
- **A level-up during an effect storm still announces its upgrade** — the cascade that earns a
  level used to fill the event buffer, so 12.2% of upgrades applied in silence.
- **No two ball colours in a palette are too close to tell apart** — a redmean distance gate.
  Solar shipped with CHAIN set to the exact hex of its base orb hue and Monochrome with two
  types both `#ffffff`: whole ball types that were invisible *as* types.
- **Every upgradeable number has a plain-English name** — otherwise a new upgrade is simply
  missing from the help screen, silently.

---

## Controls

|                              | |
|------------------------------|---|
| Touch / drag                 | Push balls. Swipe fast to fling them *along* the swipe. |
| **Tap**                      | **PULSE** — a sharp outward shove. Instant and punchy. |
| **Double tap**               | **VORTEX** — a spinning well that outlives your finger, winds balls into a spiral, then lets go. |
| Hold nearly still            | The field becomes an attractor and gathers an orbit. |
| Release (or flick) a gather  | Slings the whole orbit. This is how you spike big combos. |
| Multi-touch                  | Every finger is its own independent field. |
| Two-finger triple-tap        | Re-scatter the balls. Does not touch your score. |
| **Hold the bottom-right corner** | **Help.** Seven sections, and one live row per upgradeable number. |
| `?` `h`                      | Help (desktop shortcut). `Esc` closes it. |
| Four-finger tap, or `D`      | Debug overlay. |
| `R`                          | Re-scatter (desktop shortcut). |
| `?soak=1`                    | Synthesises random multi-touch for hands-free stress runs. Does not write to your save. |
| `?debug=1`                   | Start with the overlay open. |
| `?seed=12345`                | Fixed PRNG seed, for reproducing something. |
| `U`                          | Upgrade menu — every upgrade as a button, tap to fire it. |
| `←` `→`                      | Page through the upgrade menu. |

## Help

**Hold one finger in the bottom-right corner for a moment.** A ring fills under your fingertip
as you hold, so the gesture teaches itself. After your first level-up ever — and only then —
that corner breathes once with a `?` in it: the one moment a player first wonders what just
happened is the only moment a wordless toy has any business pointing at its own documentation.

Seven sections: **start here**, **touch**, **on screen**, **the orbs**, **upgrades**, **your
run**, **about**. There is no settings page, no account, no FAQ, no search, no changelog and no
palette picker — a toy with no accounts, no settings and no network has no business shipping
the sections that exist to serve those things. The three type resonances stay undocumented; they
are meant to be found.

The upgrades page is the point of it. It is **one row per number, not one per upgrade** — twenty
rows reading MORE ORBS is noise, one reading `orbs on screen 30 → 90` is information. Each of
the 55 rows carries a plain-English name, the value read live off the running config, a bar from
its starting value to its ceiling, and one pip per upgrade that feeds it, lit for the ones you
own. **Tap any row** and the sheet fades to a tenth while the change draws itself at true size
over the live toy — anything measured in pixels is drawn at exactly that many pixels.

Below the bars, thirteen colour-world chips in their own hues, the current one outlined and the
locked ones dim. That is the first time the palette upgrades are visible as objects rather than
a word over an unchanged screen. Then every upgrade you have earned, newest first, each in the
colour of the thing it changed, with its description — plus exactly one locked row, the next.
The rest are not listed: a toy that keeps its secrets should not publish a schedule of its gifts.

Three ways out, and they are the three people reach for: the **✕**, a **tap outside** the sheet,
or **swipe it down**. The handle at the top is a real handle now — there used to be a full-width
rule there, which reads as one to anyone who has used a phone and was not, and an affordance that
promises a gesture it does not have is worse than no affordance at all.

Swipe and scroll share an axis, so they are resolved by where the drag starts and where the list
is: a drag beginning on the header always dismisses, and a drag in the body scrolls until the list
runs out of travel at the top, at which point it hands the gesture over to the sheet. The sheet
follows your finger with some resistance, the veil thins as it goes so the toy comes back before
you have committed, and on release it either flies out in the direction you threw it or springs
back. Distance or speed will do it — a short sharp flick is how people actually dismiss a sheet.

The upgrade menu takes the same swipe. Its actions had to move from press to release to get it:
firing on press means the first few pixels of every swipe also fire whatever row the swipe started
on, and on that panel the row applies an upgrade.

The simulation keeps running at full physics behind the sheet and receives no input, so it
settles into CALM within ten seconds and demonstrations play against a quiet field.

---

## The debug overlay

**Hold one finger in the top-left corner for a second and a half.** A ring fills around your
fingertip as you hold, so the gesture shows you it is working rather than being a secret you
have to know. That is the only entry point that can be relied on: there is no `D` key on a
phone, and iOS reserves three- and four-finger gestures for the system, so a multi-finger tap
may simply never reach the page. A hold anywhere else on the screen is an ordinary gather and
does nothing to the overlay. Holding the corner again closes it — **or tap the ✕** in the panel's
top-right, which is the way out that does not depend on getting a hold right.

Hold timers count **real** seconds, not the frame delta the physics integrates. That delta is
clamped to `world.maxDt` so one long frame cannot integrate a huge step, and feeding the clamped
value to a "hold for 1.5 seconds" timer made the timer run slow exactly when the scene was busy:
measured at 2.4–2.8s of wall clock for a 1.5s hold, worse once the overlay itself was drawing,
and inconsistent between attempts. It now fires at 1.57s.

The debug overlay shows fps, physics and draw milliseconds, ball and particle counts,
sanitizer hits, dropped effect events, soft resets, the error ring buffer, and three
targets you can press:

| Target | What it does |
| --- | --- |
| `HOLD TO WIPE SAVE` | Hold 1.6s. Erases the save entirely. |
| `UPGRADES` | Opens the upgrade menu. |
| `RESET TO LV 1` | One tap. Back to a clean level 1 — no upgrades, no score, starting population — and it is written to storage immediately, so it survives a reload. |

The **upgrade menu** has a ✕ of its own in its top-right. It covers the corner you would
otherwise hold, and it swallows every touch inside itself, so without that cross the only ways
out were a keyboard and a three-finger tap that iOS is entitled to eat. It lists all 99 upgrades
as tappable buttons — level, name and kind, with
the ones you already own marked. Tapping one fires it immediately, so any upgrade can be seen
without playing to it. `+1 LV` / `+10 LV` advance levels properly (granting each upgrade on
the way), `ALL` applies everything, `RESET` is the same clean level 1 as above.

---

## Progression

**One upgrade per level, 2 → 100.** Every level-up hands over something with a name, and
most of them are things you can see rather than a number moving somewhere.

| Levels | What arrives |
|---|---|
| 2–8 | The seven ball types, one per level: VOLATILE, SPLITTER, MAGNET, PRISM, CHAIN, FROST, GOLD. |
| Throughout | 11 more **colour worlds** (twelve in total), 20 **+6 ORBS** steps taking the population from 30 to the hard cap of 150, 28 **retunes of existing types** (wider blasts, deeper chains, longer freezes, more gold), 10 **gesture upgrades** (pulse reach, vortex duration, sling power), 18 **purely visual** ones (longer trails, brighter bloom, denser constellations), and 5 score multipliers. |
| 100 | The cap. A grand display fires once, and play continues — the level stops, the number does not. |

The level curve lives in `config.js` as `levels.curve`: anchor points with power-law
interpolation between them. It was **measured, not guessed** — a simulated player was run
for an hour with levels forced to advance linearly, the score earned inside each level band
recorded, and the result made monotonic by isotonic regression. A single `base * n^exp`
formula could not fit the real shape, which is nearly flat through the early levels and
then climbs steeply once the population and multipliers open up; one curve fitted to both
ends made the first ten levels either trivial or a wall.

The curve is scaled so that a **median** run reaches the cap in about an hour, and "median" is
doing real work in that sentence. Twelve simulated players at the shipped scale finished in
33, 36, 43, 48, 49, 54, **56**, 60, 73, 76, 82 and 91 minutes — median 55.5m, mean 58.4m. The
spread is not measurement error; it is the toy. Someone who parks a finger, gathers a fat
orbit and slings it into a packed screen earns several times what someone drifting through a
sparse one does, and a lucky FRENZY chain can pay for two levels at once. An hour is the
middle of the distribution, not a promise. Tuning it any tighter than that would be fitting
noise: the 12-sample median has a wider confidence interval than the last adjustment made.

The curve had to be re-scaled by 1.8× when unlocked ball types started actually appearing on
screen. That one fix roughly halved the time to the cap — seven types arriving at level 2 to 8
instead of never is a very large change to the scoring economy, and it is a good measure of how
much of the game those upgrades had silently not been delivering.

Upgrades work by mutating the sim's **own** copy of the config (`createSim` deep-clones what
it is handed), so an upgrade reaches physics and rendering alike without either side needing
to know it exists, and the shared `CONFIG` export is never touched. On load, every upgrade
up to the saved level is replayed in order.

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
