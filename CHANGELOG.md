# Changelog

## 0.4.0

- **A WebGL2 renderer, written from scratch.** No engine and no build step: a small toolkit (`gl/glkit.js`), hand-written GLSL (`gl/shaders.js`) and a frame graph (`gl/renderer.js`). The whole population is one instanced draw call.
- **Creatures as signed distance fields.** Every body, tail, cilium, spike, pincer, eye, organelle, marking and scar is evaluated per pixel in the fragment shader, so creatures stay crisp at any zoom and animate entirely on the GPU. Membranes are translucent, nuclei glow, and dead creatures dissolve.
- **A microscope, not a map.** Procedural caustics, nutrient haze and drifting debris in the background; algae fronds and diatoms for food; two layers of plankton with parallax, the near one out of focus.
- **HDR post-processing.** The scene renders to a half-float target, then a bright pass, two-level Gaussian bloom, shockwave distortion, chromatic aberration, tone roll-off, vignette and film grain.
- **Dark-field and bright-field modes**, switchable live.
- **Game feel.** Meteors land with a shockwave, debris and camera shake; food blooms burst; births, meals and deaths throw off GPU particles from a ring buffer with per-frame budgets. The camera eases to its target, zoom is eased in log space, and hovering a creature shows its name.
- **GPU portraits** in the inspector, legend and field guide.
- **Flow control.** Each viewer gets its own sender task; the server keeps only the newest world frame per client and sends it when the client has credit (the client acks each frame it draws), so a slow viewer gets fewer frames instead of falling seconds behind. The client also decodes only the newest frame at draw time.
- The Canvas 2D renderer from 0.3 remains as an automatic fallback (and with `?renderer=2d`). The browser test runs against both.

## 0.3.0

- **Procedural creature art.** Every creature is drawn from its genes and state: body plan from diet (round, ciliated grazers; long, spiky hunters with snapping pincers), tail length from speed, tail beat from current thrust, colour and markings from species, plus hunger, age, readiness to breed and battle scars.
- **A living dish.** Textured agar, swaying algae that change colour with the seasons, mossy drifting oases, a glass vignette and winter frost.
- **Smooth motion.** Positions and headings are interpolated between server frames.
- **Births, deaths and meals are visible.** Newborns pop in, deaths burst (red for kills, grey for starvation), and eating throws off sparkles.
- **Field guide and portraits.** A field guide draws every living species; the inspector shows a live portrait of the selected creature; the legend is drawn with the same art.
- **Rendering performance.** Body sprites are cached with quantised keys and least-recently-used eviction, detail drops with on-screen size, and the ground is cached.
- **Browser smoke test** with Playwright, run in its own CI job.
- Binary frame format is now 32 bytes per creature (adds the speed gene, thrust, age, kills and a recently-ate flag). Snapshot format version 2.

## 0.2.0

- **Species.** Creatures whose genomes drift far enough from their founders split off into new species, NEAT-style. Established species get generated Latin names (`Glyaoma rapax`) based on what sets them apart.
- **Tree of life.** A live phylogenetic tree in the browser: one band per species, as thick as its population. Click a species to highlight its members in the world.
- **Narrator.** Automatically spots and writes up new species, extinctions, the first predators, arms races, booms, crashes and dynasties. Headlines appear over the world view.
- **Live brains.** The inspector shows a creature's neurons firing in real time, plus a guess at what it is doing (hunting, running away, heading for food).
- **Camera.** Scroll to zoom, drag to pan, and follow a creature around the world.
- **Seasons and drifting oases.** Plant growth swings over a year and the fertile patches wander, so populations boom, crash and migrate.
- **Save and load worlds.** Snapshots restore the exact random generator state, so a loaded world continues identically. Uploads are validated and never unpickled.
- **Parallel sweeps.** `primordial sweep` runs a grid of worlds across all CPU cores and draws a phase diagram of when predators evolve.
- Binary frame format is now 28 bytes per creature (adds species, energy and flags).

## 0.1.0

- First release: vectorised simulation, live web app, inspector, headless runs, benchmarks, CI and Docker.
