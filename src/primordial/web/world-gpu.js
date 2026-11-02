// The game-feel layer for the GPU renderer: feeding it instances each frame,
// deaths that dissolve, particles, shockwaves and camera shake, seasonal
// palettes, and portraits rendered on the GPU for the inspector, field guide
// and legend. Uses the app's state (app.js) at call time.
"use strict";

const GPUWorld = (() => {
  // Plant colours through the year (0..1 RGB): spring, summer, autumn, winter.
  const SEASON_LEAF = [
    [[0.42, 0.66, 0.26], [0.58, 0.76, 0.3], [0.95, 0.86, 0.36]],
    [[0.24, 0.56, 0.24], [0.34, 0.66, 0.28], [0.9, 0.4, 0.52]],
    [[0.7, 0.58, 0.2], [0.8, 0.46, 0.18], [0.95, 0.66, 0.26]],
    [[0.42, 0.5, 0.42], [0.5, 0.56, 0.48], [0.8, 0.85, 0.9]],
  ];
  const SEASON_TINT_DARK = [[1, 1, 1], [1.02, 1.08, 0.98], [1.1, 1.0, 0.86], [0.86, 0.94, 1.12]];

  function seasonal(table, phase) {
    const p = ((((phase % 1) + 1) % 1) + 0.875) % 1 * 4; // centre each season on its quarter
    const i = Math.floor(p), f = p - i;
    const a = table[i % 4], b = table[(i + 1) % 4];
    const lerp = (x, y) => x.map((v, k) => v + (y[k] - v) * f);
    return Array.isArray(a[0]) ? a.map((row, k) => lerp(row, b[k])) : lerp(a, b);
  }

  // ---- dying creatures dissolve over DIE_MS, then are forgotten
  const DIE_MS = 750;
  const dying = [];
  let shake = 0;
  const shocks = [];

  function seconds(ms) { return ms / 1000; }

  // Called when a new server frame arrives.
  // Only creatures on (or just off) screen make particles, and each kind has
  // a budget per frame, so a busy world or a slow device that skips frames
  // can't flood the particle buffer and push out the ones that matter.
  function onScreen(c, margin = 40) {
    const hw = state.world.width / (2 * state.eye.zoom) + margin, hh = state.world.height / (2 * state.eye.zoom) + margin;
    return Math.abs(c.x - state.eye.cx) < hw && Math.abs(c.y - state.eye.cy) < hh;
  }

  function onFrame(gpu, prev, cur, now) {
    gpu.setPlants(cur.plants, cur.m);
    if (!prev) return;
    const t = seconds(now);
    let births = 24, meals = 30, deaths = 30;
    for (const c of cur.creatures) {
      if (!onScreen(c)) continue;
      const p = prev.byId.get(c.id);
      if (!p) {
        if (births-- <= 0) continue;
        // a birth: a little ring of light where the newborn appears
        gpu.emit(c.x, c.y, 0, 0, t, 0.6, c.r * 2.4, [0.75, 1.0, 0.9], 1);
        continue;
      }
      if (c.ate && !p.ate && meals-- > 0) {
        const meat = c.diet > 0.5;
        for (let k = 0; k < 4; k++) {
          const a = c.h + (Math.random() - 0.5) * 2;
          gpu.emit(c.x + Math.cos(c.h) * c.r * 1.8, c.y + Math.sin(c.h) * c.r * 1.8,
            Math.cos(a) * 16, Math.sin(a) * 16, t, 0.55, c.r * 0.3,
            meat ? [1.0, 0.35, 0.3] : [0.55, 1.0, 0.45]);
        }
      }
    }
    for (const p of prev.creatures) {
      if (cur.byId.has(p.id) || !onScreen(p)) continue;
      let killed = false;
      for (const q of prev.creatures) {
        if (q.biting && q.id !== p.id && Math.hypot(q.x - p.x, q.y - p.y) < (q.r + p.r) * 1.4 + 4) { killed = true; break; }
      }
      if (dying.length < 400) dying.push({ c: p, t0: now, killed, seed: Art.hash(p.id) });
      if (deaths-- <= 0) continue;
      const n = killed ? 12 : 6;
      for (let k = 0; k < n; k++) {
        const a = Math.random() * 6.283, sp = (killed ? 34 : 10) * (0.3 + Math.random());
        gpu.emit(p.x, p.y, Math.cos(a) * sp, Math.sin(a) * sp, t, killed ? 0.9 : 1.4,
          p.r * (killed ? 0.4 : 0.55) * (0.6 + Math.random() * 0.8),
          killed ? [1.0, 0.28, 0.25] : [0.75, 0.8, 0.78]);
      }
    }
  }

  // Called for each live world event (meteor, bloom, newcomers).
  function onEvent(gpu, e, now) {
    const t = seconds(now);
    if (e.kind === "meteor") {
      shocks.push({ x: e.x, y: e.y, t0: now });
      shake = Math.min(1.5, shake + 1);
      gpu.emit(e.x, e.y, 0, 0, t, 0.9, (e.radius || 120) * 0.9, [1.0, 0.7, 0.45], 1);
      for (let k = 0; k < 90; k++) {
        const a = Math.random() * 6.283, sp = 60 + Math.random() * 240;
        gpu.emit(e.x, e.y, Math.cos(a) * sp, Math.sin(a) * sp, t, 0.8 + Math.random() * 0.8,
          2 + Math.random() * 5, k % 3 ? [1.0, 0.55, 0.25] : [1.0, 0.9, 0.7]);
      }
    } else if (e.kind === "bloom") {
      for (let k = 0; k < 70; k++) {
        const a = Math.random() * 6.283, sp = 20 + Math.random() * 90;
        gpu.emit(e.x, e.y, Math.cos(a) * sp, Math.sin(a) * sp, t, 1.2 + Math.random(), 2 + Math.random() * 3,
          [0.5, 1.0, 0.5]);
      }
      gpu.emit(e.x, e.y, 0, 0, t, 1.1, 150, [0.45, 1.0, 0.55], 1);
    } else if (e.kind === "invasion") {
      gpu.emit(e.x, e.y, 0, 0, t, 1.0, 70, [0.7, 0.85, 1.0], 1);
    }
  }

  // One frame. `eye` is the eased camera; returns nothing.
  function draw(gpu, eye, now, alpha) {
    const f = state.frame;
    const W = gpu.size[0], H = gpu.size[1];
    const hw = state.world.width / (2 * eye.zoom), hh = state.world.height / (2 * eye.zoom);
    // camera shake after impacts, decaying quickly
    shake *= 0.9;
    const jitter = reducedMotion.matches ? 0 : shake * 6 / eye.zoom;
    const x0 = eye.cx - hw + (Math.random() - 0.5) * jitter;
    const y0 = eye.cy - hh + (Math.random() - 0.5) * jitter;
    const k = W / (2 * hw);
    const t = seconds(now);
    const phase = state.status.season_phase || 0;
    const dark = state.microscope !== "bright";

    if (f) {
      const n = f.creatures.length + dying.length;
      gpu.beginCreatures(n);
      const hl = state.highlight;
      const list = f.sorted || (f.sorted = f.creatures.slice().sort((a, b) => a.r - b.r));
      for (const c of list) {
        const p = (state.prev && state.prev.byId.get(c.id)) || c;
        const wrapped = Math.abs(c.x - p.x) > 100 || Math.abs(c.y - p.y) > 100;
        let grow = 1;
        const b = bornAt.get(c.id);
        if (b !== undefined) {
          const u = (now - b) / 450;
          if (u < 1) grow = 0.3 + 0.7 * (1 - (1 - u) ** 3);
          else bornAt.delete(c.id);
        }
        gpu.addCreature(c, wrapped ? c : p, creatureColour(c), {
          seed: Art.hash(c.id),
          marking: Art.hash(c.species * 13 + 5),
          markSeed: (c.species * 101) % 997,
          grow,
          dim: hl !== null && c.species !== hl,
          ring: c.id === state.selected ? 2 : c.id === state.hover ? 1 : 0,
        });
      }
      for (let i = dying.length - 1; i >= 0; i--) {
        const d = dying[i];
        const u = (now - d.t0) / DIE_MS;
        if (u >= 1) { dying.splice(i, 1); continue; }
        gpu.addCreature(d.c, d.c, creatureColour(d.c), {
          seed: d.seed, marking: Art.hash(d.c.species * 13 + 5), markSeed: (d.c.species * 101) % 997,
          dissolve: Math.max(0.02, u), killed: d.killed, dim: hl !== null && d.c.species !== hl,
        });
      }
    }

    // shockwaves, in screen space (uv, radius in screen heights)
    const shockData = [];
    for (let i = shocks.length - 1; i >= 0; i--) {
      const s = shocks[i];
      const a = (now - s.t0) / 1100;
      if (a >= 1) { shocks.splice(i, 1); continue; }
      shockData.push([(s.x - x0) * k / W, 1 - (s.y - y0) * k / H, 0.02 + a * 0.75, (1 - a) * (1 - a)]);
    }

    const [leaf, leaf2, flower] = seasonal(SEASON_LEAF, phase);
    gpu.render({ x0, y0, k, zoom: eye.zoom }, {
      time: t,
      alpha,
      mode: dark ? 0 : 1,
      zones: state.world.zones,
      season: seasonal(SEASON_TINT_DARK, phase),
      winter: winterAmount(phase) * Math.min(1, (state.config.season_strength ?? 0.5) * 2),
      leaf, leaf2, flower,
      shocks: shockData,
    });
  }

  // ---- portraits: one creature, rendered on a small GPU canvas and copied
  let portraitGL = null;
  const PW = 480, PH = 240;
  function portraits() {
    if (portraitGL === null) {
      try {
        const cv = document.createElement("canvas");
        portraitGL = new GLRenderer(cv, { plankton: 40 });
        portraitGL.resize(PW, PH);
      } catch (err) {
        console.warn("GPU portraits unavailable:", err);
        portraitGL = false;
      }
    }
    return portraitGL;
  }

  // spec: { r (world units), diet, speed, energy, thrust, age, kills, biting, ate, species, id, rgb }
  function drawPortrait(target, spec, now, heading = -0.3) {
    const R = portraits();
    if (!R) return false;
    const L = 1.12 + 0.45 * spec.diet + 0.25 * spec.speed;
    const tail = 0.7 + 2.3 * spec.speed;
    const r = spec.r * 1.35;
    const extent = (L * 2 + tail + 1.4) * r;             // nose to tail tip, plus jaws
    const tw = target.clientWidth || target.width, th = target.clientHeight || target.height;
    const aspect = tw / th;
    // fit the creature in the part of the portrait that will be shown
    const visW = Math.min(PW, PH * aspect);
    const k = Math.min(visW * 0.85 / extent, PH * 0.75 / ((1.0 + 1.6) * r * 2));
    const cx = (tail - 0.4) * r * 0.5 * Math.cos(heading), cy = (tail - 0.4) * r * 0.5 * Math.sin(heading);
    const c = { ...spec, x: cx, y: cy, h: heading };
    R.beginCreatures(1);
    R.addCreature(c, c, spec.rgb, {
      seed: Art.hash(spec.id), marking: Art.hash(spec.species * 13 + 5), markSeed: (spec.species * 101) % 997,
    });
    R.setPlants(new Uint16Array(0), 0);
    const dark = state.microscope !== "bright";
    R.render({ x0: -PW / 2 / k, y0: -PH / 2 / k, k, zoom: 1 }, {
      time: now / 1000, alpha: 1, mode: dark ? 0 : 1, zones: [[0, 0, 60]], season: [1, 1, 1], winter: 0,
      leaf: [0.4, 0.6, 0.3], leaf2: [0.5, 0.7, 0.3], flower: [1, 0.8, 0.4], shocks: [], bloom: dark ? 0.8 : 0.2,
    });
    // copy the middle of the portrait, cropped to the target's shape
    const dpr = window.devicePixelRatio || 1;
    if (target.width !== Math.round(tw * dpr)) { target.width = Math.round(tw * dpr); target.height = Math.round(th * dpr); }
    const g = target.getContext("2d");
    const sw = Math.min(PW, PH * aspect), sh = sw / aspect;
    g.drawImage(R.canvas, (PW - sw) / 2, (PH - sh) / 2, sw, sh, 0, 0, target.width, target.height);
    return true;
  }

  return { onFrame, onEvent, draw, drawPortrait, available: () => !!portraits() };
})();
