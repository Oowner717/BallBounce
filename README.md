# BallBounce

Two apps, both vanilla JS with no build step and no dependencies, both installable
and playable offline. GitHub Pages serves them side by side.

**Orbs** — a physics toy for the iPhone Home Screen. Small glowing balls in near-zero
gravity; your finger is a force field. Canvas 2D.
Lives in [`orbs/`](orbs/); start with [`orbs/README.md`](orbs/README.md).
Play: **https://oowner717.github.io/BallBounce/**

**Gully Dog** — a 3D simulator: you are Bhura, a street dog, loose for a day in the busy,
crowded streets of an Indian neighbourhood. Traffic, crowds, cows, pigeons, other dogs,
and five things to do before bedtime. WebGL2.
Lives in [`gullydog/`](gullydog/); start with [`gullydog/README.md`](gullydog/README.md).
Play: **https://oowner717.github.io/BallBounce/gullydog/**

```sh
cd orbs && node test.js                  # tests: zero installs, node:assert only
cd orbs && python3 -m http.server 8080   # then open http://localhost:8080/

cd gullydog && node test.js
cd gullydog && python3 -m http.server 8080
```
