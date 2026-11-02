// Primordial creature and world art.
//
// Everything here is drawn procedurally from a creature's genes, so no two
// species look alike and you can read a creature's lifestyle off its body:
//
//   size gene    -> body size
//   speed gene   -> a sleeker body and a longer tail
//   diet gene    -> plant-eaters are round and fuzzy with cilia and side eyes;
//                   predators are long and spiky, with forward eyes and jaws
//   thrust       -> how hard the tail beats right now
//   energy       -> starving creatures go thin and pale; ready-to-breed ones glow
//   age          -> old creatures fade; newborns have big eyes
//   kills        -> veteran hunters carry scars
//   species      -> body colour and markings (spots, bands or a stripe)
//
// Drawing happens in the creature's own frame (facing +x), and detail is
// dropped as creatures get small on screen, so a full world of 1,500 stays
// smooth.
"use strict";

const Art = (() => {
  // ------------------------------------------------------------ colour
  const hexCache = new Map();
  function hexToRgb(hex) {
    if (!hexCache.has(hex)) {
      const n = parseInt(hex.slice(1), 16);
      hexCache.set(hex, [(n >> 16) & 255, (n >> 8) & 255, n & 255]);
    }
    return hexCache.get(hex);
  }
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const shade = (c, f) => [c[0] * f, c[1] * f, c[2] * f];
  const rgba = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  const WHITE = [255, 255, 255];
  const GREY = [150, 152, 145];
  const INK = [30, 43, 48];

  // cheap deterministic hash -> [0, 1)
  function hash(n) {
    let x = (n | 0) ^ 0x9e3779b9;
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  }

  // ------------------------------------------------------------ body plan
  // A "spec" is everything needed to draw one creature:
  // { r, diet, speed, thrust, energy, age, kills, biting, ate, color, marking, seed }
  // All of diet/speed/thrust/age are 0..1; energy is 0..2 (1 = ready to breed).
  function bodyPlan(s) {
    const lean = 0.45 * s.diet + 0.25 * s.speed;
    const hunger = Math.min(1, s.energy);
    return {
      L: s.r * (1.12 + lean),                           // half length
      W: s.r * (1.0 - 0.22 * s.diet) * (0.72 + 0.28 * hunger), // half width
      tail: s.r * (0.7 + 2.3 * s.speed),
      eyeR: s.r * (0.2 + 0.08 * (1 - Math.min(1, s.age * 8))), // newborns have big eyes
    };
  }

  function bodyColour(s) {
    let c = s.color;
    if (s.energy < 0.35) c = mix(c, GREY, 0.45 * (1 - s.energy / 0.35)); // starving
    if (s.age > 0.7) c = mix(c, GREY, (s.age - 0.7) * 1.2);                // old
    return c;
  }

  // ------------------------------------------------------------ the creature
  // A creature is drawn in two layers, both in its own frame (facing +x):
  //   motion: the parts that move every frame (tail, cilia, jaws)
  //   body:   everything else (shadow, spikes, shaded body, markings, scars,
  //           nucleus, eyes, mouth)
  // In the world view the body layer is cached as a sprite (see bodySprite),
  // so each creature costs one image draw plus a few strokes. Portraits draw
  // both layers live.
  //
  // lod 0: a coloured blob with a tail. lod 1: shaped, shaded body with eyes,
  // jaws and spikes. lod 2: everything, including cilia, markings and scars.

  function drawMotion(ctx, s, P, c, t, lod) {
    const { L, W } = P;
    const dark = shade(c, 0.55);
    const phase = s.seed * 6.283;

    // tail (flagellum): beats faster and wider the harder it swims
    const beat = t * (5 + 11 * s.thrust) + phase;
    const amp = s.r * (0.12 + 0.5 * s.thrust);
    ctx.lineCap = "round";
    ctx.strokeStyle = rgba(dark, 0.85);
    if (lod <= 1) {
      ctx.beginPath();
      ctx.moveTo(-L * 0.9, 0);
      ctx.quadraticCurveTo(-L - P.tail * 0.5, Math.sin(beat) * amp, -L * 0.9 - P.tail, Math.sin(beat - 3) * amp);
      ctx.lineWidth = Math.max(0.6, s.r * (lod ? 0.26 : 0.22));
      ctx.stroke();
    } else {
      const segs = 7;
      let px = -L * 0.9, py = 0;
      for (let k = 1; k <= segs; k++) {
        const u = k / segs;
        const nx = -L * 0.9 - P.tail * u;
        const ny = Math.sin(beat - u * 3.2) * amp * u;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(nx, ny);
        ctx.lineWidth = Math.max(0.6, s.r * 0.32 * (1 - u * 0.8));
        ctx.stroke();
        px = nx; py = ny;
      }
    }

    // cilia: the fine hairs plant-eaters sweep food in with
    if (lod >= 2 && s.diet < 0.55) {
      const n = 16;
      const len = s.r * 0.32 * (1 - s.diet);
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        if (Math.abs(Math.cos(a)) > 0.92) continue; // none at the very front or back
        const bx = Math.cos(a) * L, by = Math.sin(a) * W;
        const sway = Math.sin(t * 9 + i * 0.9 + phase) * 0.45;
        const na = Math.atan2(Math.sin(a) * L, Math.cos(a) * W) + sway;
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + Math.cos(na) * len, by + Math.sin(na) * len);
      }
      ctx.lineWidth = Math.max(0.5, s.r * 0.06);
      ctx.strokeStyle = rgba(dark, 0.7);
      ctx.stroke();
    }

    // jaws: predators get a pair of pincers that close in front of the
    // mouth, and snap open and shut while biting
    if (lod >= 1 && s.diet > 0.35) {
      const open = s.biting ? 0.3 + 0.7 * Math.abs(Math.sin(t * 26 + phase)) : 0.15;
      const jl = s.r * (0.45 + 0.55 * s.diet);
      ctx.lineWidth = Math.max(0.8, s.r * 0.17);
      ctx.strokeStyle = rgba(shade(c, 0.32));
      for (const side of [-1, 1]) {
        const bx = L * 0.78, by = side * W * 0.42;
        const tipX = L + jl * (0.75 - 0.15 * open);
        const tipY = side * (W * 0.06 + jl * 0.55 * open);
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.quadraticCurveTo(L + jl * 0.35, side * (W * 0.42 + jl * 0.5), tipX, tipY);
        ctx.stroke();
      }
    }
  }

  function drawBody(ctx, s, P, c, heading, lod, t, liveFace, face = true) {
    const { L, W } = P;
    const dark = shade(c, 0.55);
    const phase = s.seed * 6.283;

    // soft shadow, offset away from a light in the top left of the world
    if (lod >= 1) {
      const ox = 0.22 * s.r, oy = 0.34 * s.r;
      const cs = Math.cos(-heading), sn = Math.sin(-heading);
      ctx.beginPath();
      ctx.ellipse(ox * cs - oy * sn, ox * sn + oy * cs, L * 1.02, W * 1.02, 0, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(40, 52, 30, 0.16)";
      ctx.fill();
    }

    // spikes along the back half: more of them the more carnivorous
    if (lod >= 1 && s.diet > 0.4) {
      const n = Math.round(1 + 4 * s.diet);
      ctx.beginPath();
      for (const side of [-1, 1]) {
        for (let i = 0; i < n; i++) {
          const a = Math.PI * (0.55 + 0.38 * (i / Math.max(1, n - 1)));
          const bx = Math.cos(a) * L, by = Math.sin(a) * W * side;
          const tip = s.r * (0.25 + 0.3 * s.diet);
          ctx.moveTo(bx + 0.12 * s.r, by);
          ctx.lineTo(bx - tip * 0.9, by + side * tip * 0.75);
          ctx.lineTo(bx - 0.12 * s.r, by);
        }
      }
      ctx.fillStyle = rgba(shade(c, 0.42));
      ctx.fill();
    }

    // body: a soft membrane with light coming from the top left
    ctx.beginPath();
    ctx.ellipse(0, 0, L, W, 0, 0, Math.PI * 2);
    if (lod >= 1) {
      const lx = -0.35 * s.r, ly = -0.45 * s.r;
      const cs = Math.cos(-heading), sn = Math.sin(-heading);
      const hx = lx * cs - ly * sn, hy = lx * sn + ly * cs;
      const g = ctx.createRadialGradient(hx, hy, s.r * 0.08, 0, 0, Math.max(L, W) * 1.05);
      g.addColorStop(0, rgba(mix(c, WHITE, 0.55)));
      g.addColorStop(0.45, rgba(c));
      g.addColorStop(1, rgba(shade(c, 0.72)));
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = rgba(c);
    }
    ctx.fill();
    ctx.lineWidth = Math.max(0.7, s.r * (lod >= 1 ? 0.13 : 0.18));
    ctx.strokeStyle = rgba(dark, 0.9);
    ctx.stroke();

    if (lod >= 2) {
      // markings, clipped to the body: spots, bands or a dorsal stripe
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(0, 0, L * 0.94, W * 0.94, 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = rgba(shade(c, 0.68), 0.55);
      ctx.strokeStyle = rgba(shade(c, 0.68), 0.5);
      const m = s.marking;
      if (m < 0.34) {
        const n = 3 + Math.floor(m * 9);
        for (let i = 0; i < n; i++) {
          const a = hash(s.markSeed + i) * 6.283, d = 0.35 + 0.45 * hash(s.markSeed + i + 50);
          ctx.beginPath();
          ctx.arc(Math.cos(a) * L * d, Math.sin(a) * W * d, s.r * (0.1 + 0.08 * hash(s.markSeed + i + 99)), 0, 6.283);
          ctx.fill();
        }
      } else if (m < 0.67) {
        ctx.lineWidth = s.r * 0.16;
        for (let i = -1; i <= 1; i++) {
          ctx.beginPath();
          ctx.moveTo(i * L * 0.38 - L * 0.1, -W);
          ctx.quadraticCurveTo(i * L * 0.38 + L * 0.08, 0, i * L * 0.38 - L * 0.1, W);
          ctx.stroke();
        }
      } else {
        ctx.lineWidth = s.r * 0.2;
        ctx.beginPath();
        ctx.moveTo(-L, 0);
        ctx.quadraticCurveTo(0, -W * 0.18, L * 0.5, 0);
        ctx.stroke();
      }
      // scars on veteran hunters
      const scars = Math.min(4, Math.floor(s.kills / 4));
      ctx.strokeStyle = "rgba(250, 240, 228, 0.75)";
      ctx.lineWidth = Math.max(0.6, s.r * 0.07);
      for (let i = 0; i < scars; i++) {
        const sx = (hash(s.markSeed * 7 + i) - 0.5) * L * 1.1, sy = (hash(s.markSeed * 7 + i + 7) - 0.5) * W * 1.1;
        ctx.beginPath();
        ctx.moveTo(sx - s.r * 0.22, sy - s.r * 0.12);
        ctx.lineTo(sx + s.r * 0.22, sy + s.r * 0.12);
        for (let k = -1; k <= 1; k++) {
          ctx.moveTo(sx + k * s.r * 0.11 - s.r * 0.04, sy + k * s.r * 0.06 + s.r * 0.08);
          ctx.lineTo(sx + k * s.r * 0.11 + s.r * 0.04, sy + k * s.r * 0.06 - s.r * 0.08);
        }
        ctx.stroke();
      }
      ctx.restore();

      // nucleus: glows when the creature is ready to breed
      const ready = s.energy >= 1;
      const pulse = liveFace && ready ? 0.12 * Math.sin(t * 5 + phase) : 0;
      const nr = W * 0.32;
      ctx.beginPath();
      ctx.arc(-L * 0.28, 0, nr * (1 + pulse), 0, 6.283);
      ctx.fillStyle = ready ? "rgba(255, 246, 196, 0.85)" : rgba(shade(c, 0.6), 0.45);
      ctx.fill();
      if (ready) {
        ctx.beginPath();
        ctx.arc(-L * 0.28, 0, nr * 1.9, 0, 6.283);
        ctx.fillStyle = `rgba(255, 240, 170, ${0.18 + pulse})`;
        ctx.fill();
      }
    }

    if (lod >= 1 && face) drawFace(ctx, s, P, c, t, lod, liveFace);
  }

  // eyes: wide-set on grazers (to watch for danger), forward on hunters
  function drawFace(ctx, s, P, c, t, lod, live) {
    const { L, W } = P;
    const phase = s.seed * 6.283;
    const forward = s.diet;
    const ex = L * (0.42 + 0.22 * forward);
    const ey = W * (0.6 - 0.3 * forward);
    const er = P.eyeR;
    const blink = live && lod >= 2 && Math.sin(t * 0.9 + phase * 7) > 0.985;
    for (const side of [-1, 1]) {
      if (blink) {
        ctx.beginPath();
        ctx.moveTo(ex - er, side * ey);
        ctx.lineTo(ex + er, side * ey);
        ctx.lineWidth = Math.max(0.6, er * 0.35);
        ctx.strokeStyle = rgba(INK);
        ctx.stroke();
        continue;
      }
      ctx.beginPath();
      ctx.arc(ex, side * ey, er, 0, 6.283);
      ctx.fillStyle = "#fbfaf4";
      ctx.fill();
      if (lod >= 2) {
        ctx.lineWidth = Math.max(0.4, er * 0.18);
        ctx.strokeStyle = rgba(shade(c, 0.55), 0.8);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(ex + er * 0.3, side * ey * (forward > 0.5 ? 0.92 : 1.06), er * 0.55, 0, 6.283);
      ctx.fillStyle = rgba(INK);
      ctx.fill();
      if (lod >= 2) {
        ctx.beginPath();
        ctx.arc(ex + er * 0.12, side * ey - er * 0.22, er * 0.18, 0, 6.283);
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.fill();
      }
    }
    // grazers get a small mouth, which works away while they eat
    if (s.diet <= 0.35) {
      ctx.beginPath();
      const open = live && s.ate ? 0.35 + 0.25 * Math.sin(t * 20 + phase) : 0.2;
      ctx.arc(L * 0.86, 0, s.r * 0.16, Math.PI - open * 3, Math.PI + open * 3);
      ctx.lineWidth = Math.max(0.6, s.r * 0.08);
      ctx.strokeStyle = rgba(shade(c, 0.35));
      ctx.stroke();
    }
  }

  // Everything drawn live: used for portraits and the field guide.
  function drawCreature(ctx, x, y, heading, s, t, lod = 2) {
    const P = bodyPlan(s);
    const c = bodyColour(s);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(heading);
    drawMotion(ctx, s, P, c, t, lod);
    drawBody(ctx, s, P, c, heading, lod, t, true);
    ctx.restore();
  }

  // ------------------------------------------------------------ sprite cache
  // The body layer depends only on slowly changing things (genes, colour,
  // hunger, age, scars), so it's rendered once into a small canvas and reused.
  // Keys quantise those inputs; the cache is bounded and evicts the oldest.
  const sprites = new Map();
  const MAX_SPRITES = 3000;
  const stats = { hits: 0, misses: 0, size: 0 };
  let clock = 0; // bumped once per frame by the caller, for least-recently-used eviction

  function evict() {
    // drop the least recently used fifth in one go, so eviction stays rare
    const byAge = [...sprites.entries()].sort((a, b) => a[1].used - b[1].used);
    for (let i = 0; i < byAge.length / 5; i++) sprites.delete(byAge[i][0]);
  }

  const ENERGY_LEVELS = [0.15, 0.7, 1.2];
  const AGE_LEVELS = [0, 0.4, 0.9];
  const LOG_STEP = Math.log(1.25);

  function bodySprite(s, lod, rs) {
    // Quantise the inputs so that similar creatures share a sprite: pixel
    // radius in steps of 25%, diet in sixths, speed in fifths, three levels
    // each of hunger (starving, fed, ready to breed) and age (newborn, adult,
    // old), scars in eights, colour in steps of 24.
    const ri = Math.round(Math.log(Math.max(2, rs)) / LOG_STEP);
    const dq = Math.round(s.diet * 6), sq = Math.round(s.speed * 5);
    const eq = s.energy < 0.3 ? 0 : s.energy < 1 ? 1 : 2;
    const aq = s.age < 0.03 ? 0 : s.age < 0.75 ? 1 : 2;
    const kq = Math.min(3, s.kills >> 3);
    const cr = Math.round(s.color[0] / 24), cg = Math.round(s.color[1] / 24), cb = Math.round(s.color[2] / 24);
    const key = lod + "|" + ri + "|" + dq + "|" + sq + "|" + eq + "|" + aq + "|" + kq + "|" + cr + "," + cg + "," + cb + "|" + s.markSeed;
    let sp = sprites.get(key);
    if (sp) {
      stats.hits++;
      sp.used = clock;
      return sp;
    }
    stats.misses++;
    const rb = Math.exp(ri * LOG_STEP);
    const spec = {
      r: rb, diet: dq / 6, speed: sq / 5, thrust: 0, energy: ENERGY_LEVELS[eq], age: AGE_LEVELS[aq],
      kills: kq * 8, biting: false, ate: false, color: [cr * 24, cg * 24, cb * 24],
      marking: s.marking, markSeed: s.markSeed, seed: 0,
    };
    const P = bodyPlan(spec);
    const half = Math.ceil(Math.max(P.L + rb * 0.9, P.W + rb * 0.9) + 2);
    const cv = document.createElement("canvas");
    cv.width = cv.height = half * 2;
    const g = cv.getContext("2d");
    g.translate(half, half);
    drawBody(g, spec, P, bodyColour(spec), 0, lod, 0, false, lod < 2); // lod 2 draws its face live
    sp = { canvas: cv, half, rb, used: clock, spec };
    sprites.set(key, sp);
    if (sprites.size > MAX_SPRITES) evict();
    stats.size = sprites.size;
    return sp;
  }

  // The world view's version: live motion layer plus the cached body.
  // The camera maps world (wx, wy) to canvas (wx - x0) * k, (wy - y0) * k;
  // the creature's own frame is composed with it in one setTransform.
  // `grow` (0..1) scales a newborn up as it appears, without new sprites.
  function drawCreatureFast(ctx, x, y, heading, s, t, lod, cam, grow = 1) {
    const k = cam.k;
    const sp = bodySprite(s, lod, s.r * k);
    // shape the moving parts from the same quantised genes as the sprite, so they line up
    const P = bodyPlan({ r: s.r, diet: sp.spec.diet, speed: sp.spec.speed, energy: sp.spec.energy, age: sp.spec.age });
    const c = bodyColour(sp.spec);
    const cs = Math.cos(heading) * k * grow, sn = Math.sin(heading) * k * grow;
    ctx.setTransform(cs, sn, -sn, cs, (x - cam.x0) * k, (y - cam.y0) * k);
    drawMotion(ctx, s, P, c, t, lod);
    const scale = s.r / sp.rb; // sprite pixels -> world units
    const size = sp.canvas.width * scale;
    ctx.drawImage(sp.canvas, -sp.half * scale, -sp.half * scale, size, size);
    if (lod >= 2) drawFace(ctx, s, P, c, t, lod, true); // blinking eyes and a chewing mouth
  }

  // ------------------------------------------------------------ plants
  // Algae tufts, pre-rendered once per season and drawn as sprites.
  const SEASON_PLANTS = [
    { leaf: [[92, 150, 64], [120, 172, 72], [70, 128, 58]], flower: [236, 216, 92] },   // spring
    { leaf: [[56, 120, 52], [76, 140, 60], [40, 100, 46]], flower: [214, 92, 120] },    // summer
    { leaf: [[170, 150, 58], [196, 128, 48], [128, 138, 60]], flower: [230, 170, 70] }, // autumn
    { leaf: [[112, 128, 96], [130, 142, 112], [96, 112, 90]], flower: null },           // winter
  ];
  const VARIANTS = 8;
  const SPRITE = 48;
  const plantSprites = SEASON_PLANTS.map((pal, si) =>
    Array.from({ length: VARIANTS }, (_, v) => makePlant(pal, si * 31 + v * 7 + 3)));

  function makePlant(pal, seed) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = SPRITE;
    const g = cv.getContext("2d");
    g.translate(SPRITE / 2, SPRITE / 2);
    const leaves = 3 + Math.floor(hash(seed) * 4);
    for (let i = 0; i < leaves; i++) {
      const a = (i / leaves) * 6.283 + hash(seed + i) * 0.8;
      const len = SPRITE * (0.22 + 0.16 * hash(seed + i + 20));
      const col = pal.leaf[i % pal.leaf.length];
      g.save();
      g.rotate(a);
      g.beginPath();
      g.ellipse(len * 0.55, 0, len * 0.6, len * 0.24, 0, 0, 6.283);
      const grad = g.createLinearGradient(0, 0, len * 1.2, 0);
      grad.addColorStop(0, rgba(shade(col, 0.7)));
      grad.addColorStop(1, rgba(mix(col, WHITE, 0.25)));
      g.fillStyle = grad;
      g.fill();
      g.lineWidth = 1;
      g.strokeStyle = rgba(shade(col, 0.55), 0.8);
      g.stroke();
      g.beginPath();
      g.moveTo(len * 0.05, 0);
      g.lineTo(len * 1.0, 0);
      g.strokeStyle = rgba(shade(col, 0.6), 0.6);
      g.stroke();
      g.restore();
    }
    if (pal.flower && hash(seed + 77) < 0.4) {
      for (let i = 0; i < 3; i++) {
        const a = hash(seed + 90 + i) * 6.283, d = SPRITE * 0.12;
        g.beginPath();
        g.arc(Math.cos(a) * d, Math.sin(a) * d, SPRITE * 0.06, 0, 6.283);
        g.fillStyle = rgba(pal.flower);
        g.fill();
      }
    } else {
      g.beginPath();
      g.arc(0, 0, SPRITE * 0.07, 0, 6.283);
      g.fillStyle = rgba(shade(pal.leaf[2], 0.6));
      g.fill();
    }
    return cv;
  }

  function seasonIndex(phase) {
    return Math.floor((((phase % 1) + 1) % 1 + 0.125) * 4) % 4;
  }

  // ------------------------------------------------------------ ground
  // A world-sized texture of specks and blotches, drawn under everything.
  function makeGround(w, h, seed = 1) {
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const g = cv.getContext("2d");
    for (let i = 0; i < 260; i++) {
      const x = hash(seed + i) * w, y = hash(seed + i + 1e4) * h;
      const r = 20 + hash(seed + i + 2e4) * 90;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      const dark = hash(seed + i + 3e4) < 0.5;
      gr.addColorStop(0, dark ? "rgba(80, 90, 40, 0.06)" : "rgba(255, 255, 240, 0.07)");
      gr.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gr;
      g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    for (let i = 0; i < 9000; i++) {
      const x = hash(seed * 7 + i) * w, y = hash(seed * 7 + i + 5e4) * h;
      const v = hash(seed * 7 + i + 9e4);
      g.fillStyle = v < 0.5 ? `rgba(70, 80, 40, ${0.05 + v * 0.12})` : `rgba(255, 255, 235, ${0.04 + (v - 0.5) * 0.18})`;
      g.fillRect(x, y, 1 + (v > 0.92 ? 1 : 0), 1 + (v > 0.95 ? 1 : 0));
    }
    // a few faint long fibres, like scratches in the agar
    g.lineWidth = 0.8;
    for (let i = 0; i < 40; i++) {
      const x = hash(seed + i + 7e4) * w, y = hash(seed + i + 8e4) * h, a = hash(seed + i + 6e4) * 6.283;
      const len = 30 + hash(seed + i + 4e4) * 90;
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + Math.cos(a + 0.4) * len * 0.5, y + Math.sin(a + 0.4) * len * 0.5,
        x + Math.cos(a) * len, y + Math.sin(a) * len);
      g.strokeStyle = "rgba(90, 100, 60, 0.07)";
      g.stroke();
    }
    return cv;
  }

  // Moss for the fertile oases: a soft patch of tiny green dots.
  function makeMoss(seed = 3) {
    const S = 256;
    const cv = document.createElement("canvas");
    cv.width = cv.height = S;
    const g = cv.getContext("2d");
    const base = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    base.addColorStop(0, "rgba(120, 150, 70, 0.35)");
    base.addColorStop(0.55, "rgba(130, 160, 80, 0.18)");
    base.addColorStop(1, "rgba(130, 160, 80, 0)");
    g.fillStyle = base;
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 1400; i++) {
      const a = hash(seed + i) * 6.283, d = Math.sqrt(hash(seed + i + 1e3)) * S * 0.48;
      const x = S / 2 + Math.cos(a) * d, y = S / 2 + Math.sin(a) * d;
      const fade = 1 - d / (S * 0.5);
      g.fillStyle = `rgba(${70 + hash(seed + i + 2e3) * 50}, ${110 + hash(seed + i + 3e3) * 50}, 50, ${0.25 * fade})`;
      g.beginPath();
      g.arc(x, y, 0.8 + hash(seed + i + 4e3) * 1.8, 0, 6.283);
      g.fill();
    }
    return cv;
  }

  // ------------------------------------------------------------ icons
  // Small stand-alone drawings for the legend and the field guide.
  function specFor({ size = 1, speed = 2.5, diet = 0.1, color = "#3b78a8", id = 0, energy = 0.8, age = 0.3, kills = 0 }) {
    return {
      r: 5 * size,
      diet,
      speed: Math.min(1, speed / 8),
      thrust: 0.55,
      energy,
      age,
      kills,
      biting: false,
      ate: false,
      color: hexToRgb(color),
      marking: hash(id * 13 + 5),
      markSeed: id * 101,
      seed: hash(id + 11),
    };
  }

  function drawPortrait(canvas, spec, t, heading = -0.35) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    // fit the whole body, tail included, in the frame
    const P = bodyPlan({ ...spec, r: 1 });
    const extent = P.L * 2 + P.tail + 0.9;
    const scale = Math.min((w * 0.86) / extent, (h * 0.8) / (P.W * 2 + 1.2));
    const big = { ...spec, r: scale };
    const cx = w / 2 + (P.tail - 0.4) * scale * 0.5 * Math.cos(heading);
    const cy = h / 2 + (P.tail - 0.4) * scale * 0.5 * Math.sin(heading);
    drawCreature(g, cx, cy, heading, big, t, 2);
  }

  const tick = () => { clock++; };
  return { drawCreature, drawCreatureFast, tick, spriteStats: stats, drawPortrait, specFor, hexToRgb, mix, rgba, hash, plantSprites, seasonIndex, makeGround, makeMoss, SPRITE };
})();
