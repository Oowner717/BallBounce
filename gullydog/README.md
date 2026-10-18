# Gully Dog

You are **Bhura**, a brown Indie street dog, and this is your neighbourhood: a
roundabout with a clock tower, MG Road and Bazaar Road crossing at it, a temple on a
plinth, a sabzi mandi, a maidan where the kids play cricket, a bus stop, an auto
stand, and four districts of shopfronts in Hindi and English under a tangle of
wires, bunting and laundry. It is busy. Autos, scooters, buses and cycle-rickshaws
pour through the chowk on the left, honking; two hundred people go about their
evening; cows lie in the road, pigeons crowd the temple square, and the other
street dogs guard their patches.

Nothing is painted on. The traffic follows the car in front and weaves round
whatever is in the way; people walk to shops, benches and the bus, cross at the
zebras or jaywalk, and each has their own feelings about dogs. Sit nicely in front of
someone kind and you may be petted or thrown a samosa. Grumpy ones shoo you. Run
into someone with a snack and they drop it.

A day runs from 6:30 in the morning to bedtime, a little over twelve real minutes,
with hunger, thirst and energy to look after and five things to do. Day one teaches
the basics; after that the days roll their own errands — **steal a samosa from the
halwai and outrun him**, **bring the cricket ball back to the kids**, **get prasad
at the evening aarti**, **bark the cow off MG Road**, **share food with Lali's
puppies**, **befriend a street dog** — and the weather changes from day to day.
Street cred climbs through five ranks, from *Nobody's Pup* to *Gully King*, and at
*Mohalla Favourite* somebody ties a red collar on you.

Vanilla JavaScript and WebGL2: a small renderer written for this game, every model,
texture and sound made by code at load time. No frameworks, no libraries, no build
step, no assets, no runtime dependencies — just static files. The one outside request
is the Baloo 2 font from Google Fonts, and the game falls back to the system font
without it.

---

## Playing it

**https://oowner717.github.io/BallBounce/gullydog/**

It runs on phones, tablets and desktops in any browser with WebGL2. On a phone, open
that address in Safari or Chrome and **Add to Home Screen**: it installs as an app
and plays offline from then on.

The game saves itself every ten seconds and at the end of each day, in this
browser only. **Start over from day one** in the pause menu begins again.

### Controls

| | Keyboard | Touch | Gamepad |
|---|---|---|---|
| Walk / trot | WASD or arrows | left half of the screen is a stick | left stick or d-pad |
| Run (costs energy) | Shift | push the stick to the rim and hold | RB, RT or L3 |
| Jump | Space | **Jump** | A |
| Do the thing on the prompt | E | the big button, which shows the prompt | X |
| Bark | B | **Bark** | B |
| Sniff | F | **Sniff** | Y |
| Lie down; again to sleep | Z | **Lie / Sleep** | LB or LT |
| Look around | drag; wheel to zoom | drag the right half; pinch | right stick |
| Tasks · map · pause | T · M · Esc | tap the panels; **II** pauses | Back opens the map, Start pauses |

The action button does whatever the prompt at the bottom says: eat, drink, grab,
rummage, mark a post, greet a dog, sit and beg, drop or share what you are carrying.
On a full belly it picks food up instead of eating it, so you can carry it to
someone. **Sniff** lays scent trails to food, to water when you are thirsty, to a
friend, and always to the next task, however far away. **Sleep** speeds time up
tenfold; sleeping after 9:30 pm ends the day.

---

## A day on the street

| When | What |
|---|---|
| 6:30 am | You wake on the sacks beside Raju's chai stall at the chowk. |
| 7:12 am – 6:36 pm | Gully cricket on the maidan (not in the rain). Get the ball when it is hit your way. |
| 7:30 – 8:45 am, 6:30 – 7:45 pm | Aunty puts out rotis and milk by her door in Pump Wala Chowk, and calls you by name. |
| All day | Raju has a biscuit for a dog who sits nicely, about once an hour and a quarter. The halwai on MG Road leaves samosas on his counter; the tray refills every forty minutes. |
| 11:30 am – 3:30 pm | The sun is fierce: out of the shade, thirst runs almost twice as fast. |
| Noon – 4:30 pm | A nap in the shade counts for *Siesta*. Under a tree or an awning, lie down twice. |
| 6:30 pm | The evening aarti: bells, and the pujari hands out ladoos to a dog sitting at the foot of the temple steps. |
| After 9:30 pm | Lie down twice to sleep and end the day. Stay up past 2 am and you drop where you stand. |

Needs run down by the game hour, faster when you sprint. At zero hunger or thirst you
start losing health, and a dog who runs out of health faints and wakes up at Aunty's
an hour and a half later. Being hit by traffic costs health too: vehicles brake for a
dog in the road, but a dog who darts out under a moving auto gets hit.

The other street dogs — **Kalu** at the bus stop, **Moti** under the peepal tree,
**Sheru** in the mandi and **Lali** with her puppies in Gali No. 7 — growl at a stranger
and chase one who lingers. Greet them, keep calm company, share food, and they become
friends who follow you about.

---

## Running it locally

```sh
cd gullydog
python3 -m http.server 8080
```

Then open **http://localhost:8080/**. `localhost` counts as a secure context, so the
service worker registers and offline reload works there too. Any static server does;
there is nothing to build.

### URL parameters

For looking at a particular moment without playing up to it:

| Parameter | Effect |
|---|---|
| `?autoplay` | Skip the start screen. |
| `?fresh` | Ignore the saved game (without deleting it). |
| `?hour=18.6` | Set the clock. |
| `?weather=rain` | `clear`, `hazy`, `rain`, `holi` or `diwali`. |
| `?x=-36&z=-30&yaw=3.1` | Put the dog somewhere. |
| `?seed=7` | World and simulation seed (7 is the neighbourhood everyone plays). |
| `?quality=low` | `low`, `medium` or `high`, overriding the setting. |
| `?fixedstep` | Advance exactly 1/30 s per frame, however slow the frame. For headless browsers. |
| `?debug` | Frame timings, draw calls, triangles, counts and the dog's state. |

For example `?autoplay&fresh&hour=18.6&x=-36&z=-36` stands you in front of the temple as
the aarti starts.

---

## Deployment

`.github/workflows/pages.yml` tests both apps, then publishes **Orbs at the site
root and Gully Dog at `/gullydog/`**. It runs on pushes to `main`, `master` and
`claude/orbs-physics-toy-6vnxwx`, and by hand from the Actions tab.

The two apps share an origin and Orbs' service worker scope (`/BallBounce/`) contains
Gully Dog, so a first visit to `/gullydog/` arrives at Orbs' worker. That worker passes
anything under `./gullydog/` straight through; Gully Dog's own worker then registers
with the narrower scope and takes over. Each worker deletes only caches with its own
prefix (`orbs-cache-`, `gullydog-cache-`), and Gully Dog's only ever reads its own.

### Every deploy must bump `CACHE_VERSION`

The first line of real code in `sw.js` is:

```js
const CACHE_VERSION = 'gullydog-v1';
```

Bump it whenever anything here changes. Browsers notice a new service worker by
byte-diffing `sw.js`, so that literal is both the update trigger and the cache
invalidation. When you add or rename a file, add it to `PRECACHE` too; the tests check
that every module the game imports is precached and that every precached file exists.

---

## Tests

```sh
cd gullydog && node test.js        # zero installs, node:assert only, about 15 s
```

Most of the tests play the game. They put Bhura somewhere, press the buttons a player
would press, and check that the street answers: begging gets petted, the pump gives
water, the samosa heist works both ways, the ladoo from the aarti lands where the task
points, a cow barked at in the road ends up off it, a dog greeted often enough becomes
a friend and follows, a dog run down by an auto takes damage exactly once, a day ends
with a summary and a new one begins. Others hold the line on things that rot quietly:

- **Determinism.** Same seed, same buttons, same result, checked by hashing the state
  every second; and the simulation never calls `Math.random`, `Date.now` or
  `performance.now` (the test replaces them with functions that throw).
- **The world is read-only.** Every value reachable from it is hashed before and after
  a sim runs on it.
- **Nobody freezes.** Across four seeds and times of day, no walker stands stuck for
  more than twelve seconds; at rush hour no vehicle sits still for long and none has
  to be cleared from a jam.
- **The world's invariants:** one connected pavement network reaching all eight ways
  off the map, vehicle routes on the carriageway, traffic on the left and clockwise
  round the chowk, nothing solid in the road but the median, every place named.
- **Saves** survive garbage, out-of-range numbers and a garbled day in progress.
- **The pictures:** atlas packing, every mesh's indices and normals, the city under its
  triangle budget, the rig never posing anything to NaN, the light finite at every
  hour, the atlas painting on a stand-in canvas.
- **The app:** the precache list against the import graph, icons at the sizes the
  manifest claims.

Set `GULLYDOG_TEST_STACK=1` for full stack traces on failure.

---

## How it is put together

```
index.html     the page: canvas, HUD, touch controls, menus (all markup and CSS)
main.js        boot, the loop, the camera, turning the sim into draw calls and sound
sim.js         the game: the dog, needs, actions, the day, saves, the state hash
  simcore.js   events, speech bubbles, items on the ground, ground height
  traffic.js   vehicles: routes, following, weaving, yielding, honking
  crowd.js     people: plans, A* on the pavement graph, crossings, reactions
  fauna.js     cows, goats, pigeons, the street dogs
  scenes.js    Raju, the halwai, Aunty, the pujari, the traffic cop, the cricket
  tasks.js     the tasks, cred and ranks
  spatial.js   a uniform grid for "who is near"
config.js      every gameplay number, in one place
world.js       the neighbourhood: layout, buildings, props, routes, pavement graph
data.js        names, signs, palettes, clothes, what people say
env.js         sun, sky, fog and light by hour and weather
gfx.js         the WebGL2 renderer
geom.js        a mesh builder writing straight into packed vertex buffers
cityMesh.js    the static city, built from the world in chunks
models.js      the dog, people, animals, vehicles and things, as skinned meshes
rig.js         poses and gaits: turns "what is it doing" into bone matrices
textures.js    the texture atlas (signs, ads, rangoli, number plates) and noise
audio.js       procedural sound: plucked strings and a tanpura drone, horns, bells, barks
hud.js         HUD, minimap, toasts, speech bubbles, the day's summary
input.js       keyboard, touch and gamepad, merged
sw.js          the service worker
tools/make-icons.mjs   draws the app icons (no image library) and encodes the PNGs
```

**The simulation is pure.** Nothing under `sim.js` touches the DOM, the clock or
`Math.random`; randomness comes from the sim's own seeded generator and time only
from the `dt` it is given. It steps at whatever rate it is called at, capped at 50 ms
a step. The front end drains its events every frame for sounds, toasts and the HUD.
Animation lives in the renderer, not the sim, so the state hash is about gameplay.

**The world is generated, not modelled.** `generateWorld(7)` lays out the roads and
plots on a half-metre surface grid, fills the plots with buildings, shops and props,
and derives everything the sim needs from them: colliders, shade, the vehicle routes
through the roundabout, and a pavement graph with zebra and jaywalking edges. It
takes about a tenth of a second; `cityMesh.js` turns it into roughly 360,000
triangles in about half a second more.

**The renderer** draws the city as 25 m chunks culled against the view, and every
creature and vehicle as an instanced skinned mesh whose bone matrices come from a
float texture: one draw call per kind of thing, however many there are. One
directional shadow map is anchored to the world so it does not shimmer, eight point
lights come on at night, windows glow in the evening, and fog, a procedural sky and an
ACES tone curve finish it. Resolution adapts to hold the frame rate, and the quality
setting trades shadows, draw distance and pixel density.

---

## Licence

MIT, as for the rest of this repository.
