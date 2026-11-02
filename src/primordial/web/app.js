// Primordial browser client.
// Receives binary world frames over a WebSocket, draws them on a canvas,
// and sends commands (sliders, events, inspection) back as JSON.
"use strict";

const COLOURS = {
  ink: "#1e2b30",
  muted: "#5d6c68",
  line: "#d7dcc8",
  card: "#fafbf6",
  plant: "#4c7a35",
  forager: "#3b78a8",
  omnivore: "#c0951e",
  predator: "#b23a48",
  blue: [59, 120, 168],
  red: [178, 58, 72],
};
// Agar tint through the year: spring, summer, autumn, winter.
const SEASON_TINT = [[227, 232, 204], [219, 232, 188], [234, 228, 198], [226, 231, 214]];
const FORAGER_MAX = 0.35;
const PREDATOR_MIN = 0.65;
const NO_SPECIES = 65535;
const STRIDE = 32; // bytes per creature, must match primordial/protocol.py

const SLIDER_TEXT = {
  plant_growth: ["Plant growth", "New plants per tick, on average over a year."],
  plant_energy: ["Food value", "Energy in each plant."],
  season_strength: ["Seasons", "How much harder winter is than summer. 0 turns seasons off."],
  mutation_rate: ["Mutation rate", "Chance each brain connection changes in a child."],
  mutation_scale: ["Mutation size", "How big those changes are."],
  basal_cost: ["Cost of living", "Energy burnt every tick just by existing."],
  attack_damage: ["Bite strength", "Energy taken per bite."],
  meat_efficiency: ["Meat value", "How much of a victim's energy a predator keeps."],
};
const INPUT_LABELS = {
  food_sin: "food left/right", food_cos: "food ahead", food_near: "food close",
  other_sin: "other left/right", other_cos: "other ahead", other_near: "other close",
  other_bigger: "other bigger", other_diet: "other meatier", other_kin: "other is kin",
  energy: "my energy", clock: "clock",
};

// ---------------------------------------------------------------- state
const state = {
  world: { width: 1600, height: 1000, zones: [] },
  frame: null,
  pendingFrame: null,
  prev: null,
  frameAt: 0,
  framePeriod: 33,
  history: [],
  species: new Map(),
  config: {},
  tunable: {},
  tool: "inspect",
  colourMode: "species",
  selected: null,
  creature: null,
  highlight: null, // species id whose members are highlighted
  follow: false,
  status: { season_phase: 0 },
  view: { zoom: 1, cx: 800, cy: 500 }, // where the camera is heading
  eye: { zoom: 1, cx: 800, cy: 500 },  // where it is right now (eases towards view)
  microscope: "dark",
  hover: null,
  effects: [], // shockwaves for meteors, blooms and newcomers
  treeDirty: true,
};

const $ = (id) => document.getElementById(id);
// The GPU renderer (gl/) is used when WebGL2 works; otherwise the Canvas 2D
// renderer (art.js). "?renderer=2d" forces the fallback, which the tests use.
let canvas = $("world");
let gpu = null;
let ctx = null;
if (new URLSearchParams(location.search).get("renderer") !== "2d" && typeof GLRenderer !== "undefined" && GLRenderer.supported()) {
  try {
    gpu = new GLRenderer(canvas);
  } catch (err) {
    console.warn("GPU renderer unavailable, falling back to Canvas 2D:", err);
    const fresh = canvas.cloneNode(false); // a canvas can only ever have one kind of context
    canvas.replaceWith(fresh);
    canvas = fresh;
    gpu = null;
  }
}
if (!gpu) ctx = canvas.getContext("2d");
document.documentElement.dataset.renderer = gpu ? "gpu" : "2d";
let ws = null;
let retry = 0;

// ---------------------------------------------------------------- network
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  $("conn").hidden = false;
  ws.onopen = () => { retry = 0; $("conn").hidden = true; };
  ws.onclose = () => {
    $("conn").hidden = false;
    $("conn").textContent = "Lost the connection. Reconnecting…";
    setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
  };
  ws.onmessage = (ev) => {
    // Frames are only decoded when the screen is about to be drawn, and only
    // the newest one: a device that falls behind skips frames instead of
    // working through a growing backlog.
    if (ev.data instanceof ArrayBuffer) state.pendingFrame = ev.data;
    else handleMessage(JSON.parse(ev.data));
  };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Must match primordial/protocol.py. Each frame is parsed once into plain
// objects; the renderer then interpolates between the last two frames.
function decodeFrame(buf) {
  const view = new DataView(buf);
  const n = view.getUint32(8, true);
  const m = view.getUint32(12, true);
  const f32 = new Float32Array(buf, 16, n * 8);
  const u32 = new Uint32Array(buf, 16, n * 8);
  const u16 = new Uint16Array(buf, 16, n * 16);
  const u8 = new Uint8Array(buf, 16, n * STRIDE);
  const creatures = new Array(n);
  const byId = new Map();
  for (let i = 0; i < n; i++) {
    const b = i * 8, o = i * STRIDE + 20;
    const c = {
      id: u32[b], x: f32[b + 1], y: f32[b + 2], h: f32[b + 3], r: f32[b + 4],
      rgb: [u8[o], u8[o + 1], u8[o + 2]],
      diet: u8[o + 3] / 255,
      species: u16[i * 16 + 12],
      energy: u8[o + 6] / 128,
      biting: !!(u8[o + 7] & 1),
      ate: !!(u8[o + 7] & 2),
      speed: u8[o + 8] / 255,
      thrust: u8[o + 9] / 255,
      age: u8[o + 10] / 255,
      kills: u8[o + 11],
    };
    creatures[i] = c;
    byId.set(c.id, c);
  }
  return {
    tick: view.getUint32(4, true), creatures, byId, m,
    plants: new Uint16Array(buf, 16 + n * STRIDE, m * 2),
  };
}

function receiveFrame(frame) {
  const now = performance.now();
  const prev = state.frame;
  if (prev) {
    const gap = now - state.frameAt;
    state.framePeriod = Math.min(200, Math.max(16, 0.8 * state.framePeriod + 0.2 * gap));
    noticeBirthsAndDeaths(prev, frame, now);
  }
  state.prev = prev;
  state.frame = frame;
  state.frameAt = now;
  if (gpu) GPUWorld.onFrame(gpu, prev, frame, now);
}

function handleMessage(msg) {
  switch (msg.type) {
    case "hello":
      state.world = msg.world;
      state.prev = null;
      particles.length = 0;
      bornAt.clear();
      state.config = msg.config;
      state.tunable = msg.tunable;
      state.history = msg.history;
      setSpecies(msg.species);
      state.selected = null;
      state.highlight = null;
      state.follow = false;
      showCreature(null);
      $("seed").value = msg.seed;
      buildSliders();
      $("log").innerHTML = "";
      addEvents(msg.events, false);
      guideIds = "";
      renderGuide();
      drawCharts();
      break;
    case "stats":
      state.history.push(...msg.rows);
      if (state.history.length > 4000) {
        // Thin the older half instead of dropping it, so charts keep the whole run.
        const half = state.history.length >> 1;
        state.history = state.history.slice(0, half).filter((_, i) => i % 2 === 0)
          .concat(state.history.slice(half));
      }
      if (msg.species) setSpecies(msg.species);
      renderGuide();
      addEvents(msg.events, true);
      state.treeDirty = true;
      drawCharts();
      break;
    case "status":
      state.status = msg;
      if (msg.zones) state.world.zones = msg.zones;
      renderStatus();
      break;
    case "config":
      state.config = msg.config;
      syncSliders();
      break;
    case "inspect":
      showCreature(msg.creature);
      break;
    case "error":
      toast(msg.message);
      break;
  }
}

function setSpecies(list) {
  state.species = new Map(list.map((s) => [s.id, s]));
  state.treeDirty = true;
}

// ---------------------------------------------------------------- text helpers
const escapeHtml = (t) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// The narrator wraps species names in *asterisks*.
const rich = (t) => escapeHtml(t).replace(/\*([^*]+)\*/g, "<em>$1</em>");
const fmt = (v) => Math.round(v).toLocaleString("en-IE");
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- camera
function halfSpan(v = state.eye) {
  return [state.world.width / (2 * v.zoom), state.world.height / (2 * v.zoom)];
}
function clampView(v = state.view) {
  v.zoom = Math.min(10, Math.max(1, v.zoom));
  const [hw, hh] = halfSpan(v);
  v.cx = Math.min(state.world.width - hw, Math.max(hw, v.cx));
  v.cy = Math.min(state.world.height - hh, Math.max(hh, v.cy));
}
// what's under the pointer, in the world as currently shown
function screenToWorld(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const u = (clientX - rect.left) / rect.width, v = (clientY - rect.top) / rect.height;
  const [hw, hh] = halfSpan(state.eye);
  return [state.eye.cx + (u - 0.5) * 2 * hw, state.eye.cy + (v - 0.5) * 2 * hh, u, v];
}
function zoomAt(factor, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  clientX ??= rect.left + rect.width / 2;
  clientY ??= rect.top + rect.height / 2;
  const [wx, wy, u, v] = screenToWorld(clientX, clientY);
  state.view.zoom *= factor;
  clampView();
  const [hw, hh] = halfSpan(state.view);
  if (!state.follow) {
    // keep the point under the pointer still once the zoom has settled
    state.view.cx = wx - (u - 0.5) * 2 * hw;
    state.view.cy = wy - (v - 0.5) * 2 * hh;
  }
  clampView();
}
// Ease the camera towards its target, framerate-independently. Zoom eases
// in log space so zooming in and out feel the same.
function easeCamera(dt) {
  const e = state.eye, v = state.view;
  if (Math.abs(e.cx - v.cx) > state.world.width / 3 || Math.abs(e.cy - v.cy) > state.world.height / 3) {
    e.cx = v.cx; e.cy = v.cy; // followed something across the wrap-around edge
  }
  const g = reducedMotion.matches ? 1 : 1 - Math.exp(-dt * 9);
  e.zoom = Math.exp(Math.log(e.zoom) + (Math.log(v.zoom) - Math.log(e.zoom)) * g);
  e.cx += (v.cx - e.cx) * g;
  e.cy += (v.cy - e.cy) * g;
  clampView(e);
}

// ---------------------------------------------------------------- world view
// The world is drawn in world units under a camera transform; art.js draws
// each creature from its genes. Positions are interpolated between the last
// two server frames so motion stays smooth at any frame rate.
const ground = { texture: null, moss: null, bg: null, key: null };

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  // cap the GPU's pixel count: the shaders are per-pixel, and past this the
  // extra sharpness isn't visible at normal viewing distance
  const scale = gpu ? Math.min(dpr, Math.sqrt(4.2e6 / Math.max(1, rect.width * rect.height))) : dpr;
  const w = Math.round(rect.width * scale), h = Math.round(rect.height * scale);
  if (gpu) gpu.resize(w, h);
  else { canvas.width = w; canvas.height = h; }
  ground.key = null;
}

const DIET_RGB = { forager: [59, 120, 168], omnivore: [192, 149, 30], predator: [178, 58, 72] };
function dietRgb(diet) {
  if (diet >= PREDATOR_MIN) return DIET_RGB.predator;
  if (diet >= FORAGER_MAX) return DIET_RGB.omnivore;
  return DIET_RGB.forager;
}

function seasonTint(phase) {
  const p = ((phase % 1) + 1) % 1 * 4;
  const i = Math.floor(p), t = p - i;
  const a = SEASON_TINT[i % 4], b = SEASON_TINT[(i + 1) % 4];
  return `rgb(${a.map((c, k) => Math.round(c + (b[k] - c) * t)).join(",")})`;
}

// How far into winter we are (0..1), for the frost.
function winterAmount(phase) {
  const d = Math.abs((((phase % 1) + 1) % 1) - 0.75);
  return Math.max(0, 1 - d / 0.14);
}

function creatureColour(c) {
  if (state.colourMode === "diet") return dietRgb(c.diet);
  if (state.colourMode === "family") return c.rgb;
  const sp = state.species.get(c.species);
  // species colour, with a little individual variation from the family colour
  return sp ? Art.hexToRgb(sp.color) : Art.mix([154, 160, 150], c.rgb, 0.3);
}

function specOf(c, r) {
  return {
    r, diet: c.diet, speed: c.speed, thrust: c.thrust, energy: c.energy, age: c.age,
    kills: c.kills, biting: c.biting, ate: c.ate, color: creatureColour(c),
    marking: Art.hash(c.species * 13 + 5), markSeed: c.species * 101, seed: Art.hash(c.id),
  };
}

// Where a creature is right now, between the last two frames.
function interpolated(c, alpha) {
  const p = state.prev && state.prev.byId.get(c.id);
  if (!p) return [c.x, c.y, c.h];
  const dx = c.x - p.x, dy = c.y - p.y;
  if (Math.abs(dx) > 100 || Math.abs(dy) > 100) return [c.x, c.y, c.h]; // wrapped round the world
  let dh = c.h - p.h;
  if (dh > Math.PI) dh -= 2 * Math.PI;
  if (dh < -Math.PI) dh += 2 * Math.PI;
  return [p.x + dx * alpha, p.y + dy * alpha, p.h + dh * alpha];
}

function findInFrame(id) {
  return state.frame && id !== null ? state.frame.byId.get(id) || null : null;
}

// ---- particles: puffs when creatures die, sparkles when they eat
const particles = [];
const bornAt = new Map();

function noticeBirthsAndDeaths(prev, cur, now) {
  if (gpu) {
    for (const c of cur.creatures) if (!prev.byId.has(c.id)) bornAt.set(c.id, now);
    for (const p of prev.creatures) if (!cur.byId.has(p.id)) bornAt.delete(p.id);
    return; // GPUWorld.onFrame adds the particles and dissolves
  }
  if (particles.length > 1500) return; // e.g. right after a meteor
  for (const c of cur.creatures) {
    const p = prev.byId.get(c.id);
    if (!p) { bornAt.set(c.id, now); continue; }
    if (c.ate && !p.ate) {
      for (let k = 0; k < 3; k++) {
        const a = c.h + (Math.random() - 0.5) * 1.6;
        particles.push({ x: c.x + Math.cos(c.h) * c.r * 1.7, y: c.y + Math.sin(c.h) * c.r * 1.7,
          vx: Math.cos(a) * 6, vy: Math.sin(a) * 6, t: now, life: 500, size: c.r * 0.22,
          rgb: c.diet > 0.5 ? [196, 60, 70] : [120, 176, 70] });
      }
    }
  }
  for (const p of prev.creatures) {
    if (cur.byId.has(p.id)) continue;
    bornAt.delete(p.id);
    // killed if a biting creature was touching it; otherwise starved or died of old age
    let killed = false;
    for (const q of prev.creatures) {
      if (q.biting && q.id !== p.id && Math.hypot(q.x - p.x, q.y - p.y) < (q.r + p.r) * 1.4 + 4) { killed = true; break; }
    }
    const rgb = killed ? [190, 50, 60] : [170, 172, 160];
    const n = killed ? 9 : 6;
    for (let k = 0; k < n; k++) {
      const a = Math.random() * 6.283, sp = (killed ? 14 : 5) * (0.4 + Math.random());
      particles.push({ x: p.x, y: p.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: now,
        life: killed ? 700 : 1100, size: p.r * (killed ? 0.3 : 0.45) * (0.6 + Math.random() * 0.6), rgb });
    }
  }
}

function drawParticles(now) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const q = particles[i];
    const a = (now - q.t) / q.life;
    if (a >= 1) { particles.splice(i, 1); continue; }
    const s = a * q.life / 1000;
    ctx.beginPath();
    ctx.arc(q.x + q.vx * s, q.y + q.vy * s, q.size * (1 - a * 0.5), 0, 6.283);
    ctx.fillStyle = Art.rgba(q.rgb, 0.75 * (1 - a));
    ctx.fill();
  }
}

function background(W, H, x0, y0, k, phase) {
  const key = [W, H, x0.toFixed(2), y0.toFixed(2), k.toFixed(4), Math.round(phase * 200),
    state.world.zones.map((z) => z[0].toFixed(0) + z[1].toFixed(0)).join()].join("|");
  if (ground.key === key && ground.bg) return ground.bg;
  if (!ground.texture) {
    ground.texture = Art.makeGround(state.world.width, state.world.height, 7);
    ground.moss = Art.makeMoss(11);
  }
  if (!ground.bg || ground.bg.width !== W || ground.bg.height !== H) {
    ground.bg = document.createElement("canvas");
    ground.bg.width = W;
    ground.bg.height = H;
  }
  const g = ground.bg.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = seasonTint(phase);
  g.fillRect(0, 0, W, H);
  g.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
  g.drawImage(ground.texture, 0, 0, state.world.width, state.world.height);
  for (const [zx, zy, sigma] of state.world.zones) {
    const s = sigma * 2.6;
    g.drawImage(ground.moss, zx - s, zy - s, 2 * s, 2 * s);
  }
  ground.key = key;
  return ground.bg;
}

let drawStats = { ms: 0, frost: -1 };
const frostEl = document.getElementById("frost");
let lastDraw = performance.now();
function draw() {
  requestAnimationFrame(draw);
  if (state.pendingFrame) {
    receiveFrame(decodeFrame(state.pendingFrame));
    state.pendingFrame = null;
    send({ type: "ack" }); // ready for the next one (the server's flow control)
  }
  const started = performance.now();
  const dt = Math.min(0.1, (started - lastDraw) / 1000);
  lastDraw = started;
  const now = started, t = now / 1000;
  const f = state.frame;
  const alpha = f ? Math.min(1, (now - state.frameAt) / state.framePeriod) : 1;

  // follow camera: aim at the selected creature; easeCamera does the gliding
  const followed = state.follow && findInFrame(state.selected);
  if (followed) {
    const [x, y] = interpolated(followed, alpha);
    state.view.cx = x;
    state.view.cy = y;
    clampView();
  }
  easeCamera(dt);

  if (gpu) GPUWorld.draw(gpu, state.eye, now, alpha);
  else draw2D(now, alpha);

  // winter frost is a CSS layer over the bright views; dark field does its own
  const phase = state.status.season_phase || 0;
  const frost = gpu && state.microscope === "dark" ? 0 : Math.min(0.6, winterAmount(phase) * (state.config.season_strength ?? 0.5) * 0.9);
  if (Math.abs(frost - drawStats.frost) > 0.01) {
    frostEl.style.opacity = frost.toFixed(2);
    drawStats.frost = frost;
  }
  drawPortraits(t);
  drawStats.ms = 0.95 * drawStats.ms + 0.05 * (performance.now() - started);
}

// The Canvas 2D renderer, used when WebGL2 isn't available.
function draw2D(now, alpha) {
  Art.tick();
  const t = now / 1000;
  const W = canvas.width, H = canvas.height;
  const f = state.frame;
  const [hw, hh] = halfSpan(state.eye);
  const x0 = state.eye.cx - hw, y0 = state.eye.cy - hh;
  const k = W / (2 * hw); // canvas px per world unit
  const phase = state.status.season_phase || 0;

  // ground: cached, and only repainted when the camera, season or oases move
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(background(W, H, x0, y0, k, phase), 0, 0);
  ctx.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);

  if (f) {
    // plants: algae tufts that sway, in this season's colours
    const sprites = Art.plantSprites[Art.seasonIndex(phase)];
    const ps = 9; // world units
    for (let i = 0; i < f.m; i++) {
      const px = f.plants[2 * i], py = f.plants[2 * i + 1];
      if (px < x0 - ps || py < y0 - ps || px > x0 + 2 * hw + ps || py > y0 + 2 * hh + ps) continue;
      const hsh = Art.hash(px * 3001 + py);
      const rot = hsh * 6.283 + Math.sin(t * 1.3 + hsh * 20) * 0.14;
      const cs = Math.cos(rot) * k, sn = Math.sin(rot) * k;
      ctx.setTransform(cs, sn, -sn, cs, (px - x0) * k, (py - y0) * k);
      ctx.drawImage(sprites[(hsh * 997) & 7], -ps / 2, -ps / 2, ps, ps);
    }
    ctx.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);

    // creatures, smallest first so big ones sit on top
    const hl = state.highlight;
    const cam = { k, x0, y0 };
    const list = f.sorted || (f.sorted = f.creatures.slice().sort((a, b) => a.r - b.r));
    let selectedAt = null;
    for (const c of list) {
      const [x, y, h] = interpolated(c, alpha);
      const r = c.r * 1.35;
      const reach = r * 4;
      if (x < x0 - reach || y < y0 - reach || x > x0 + 2 * hw + reach || y > y0 + 2 * hh + reach) continue;
      let grow = 1;
      const b = bornAt.get(c.id);
      if (b !== undefined) {
        const u = (now - b) / 450;
        if (u < 1) grow = 0.35 + 0.65 * (1 - (1 - u) ** 3);
        else bornAt.delete(c.id);
      }
      const rs = r * k;
      const lod = rs < 3.5 ? 0 : rs < 9 ? 1 : 2;
      if (hl !== null) ctx.globalAlpha = c.species !== hl ? 0.18 : 1;
      Art.drawCreatureFast(ctx, x, y, h, specOf(c, r), t, lod, cam, grow);
      if (c.id === state.selected) selectedAt = [x, y, r];
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);

    drawParticles(now);
    drawEffects();

    if (selectedAt) {
      const [x, y, r] = selectedAt;
      ctx.save();
      ctx.setLineDash([5 / k, 4 / k]);
      ctx.lineDashOffset = -t * 12 / k;
      ctx.lineWidth = 2 / k;
      ctx.strokeStyle = COLOURS.ink;
      ctx.beginPath();
      ctx.arc(x, y, r * 2.2 + 6 / k, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const EFFECT_COLOURS = { meteor: [178, 58, 72], bloom: [76, 122, 53], invasion: [30, 43, 48] };

// Shockwaves for meteors, blooms and newcomers (drawn in world units).
function drawEffects() {
  const now = performance.now();
  state.effects = state.effects.filter((e) => now - e.t < 1600);
  for (const e of state.effects) {
    const a = (now - e.t) / 1600;
    const [r, g, b] = EFFECT_COLOURS[e.kind] || EFFECT_COLOURS.invasion;
    const grow = reducedMotion.matches ? 1 : 0.35 + 0.75 * Math.sqrt(a);
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.r * grow, 0, Math.PI * 2);
    if (e.kind === "meteor") {
      ctx.fillStyle = `rgba(${r},${g},${b},${0.22 * (1 - a)})`;
      ctx.fill();
    }
    ctx.lineWidth = 1 + 4 * (1 - a);
    ctx.strokeStyle = `rgba(${r},${g},${b},${0.9 * (1 - a)})`;
    ctx.stroke();
  }
}

function nearestCreature(wx, wy) {
  const f = state.frame;
  if (!f) return null;
  let best = null, bestD = Infinity;
  for (const c of f.creatures) {
    const d = Math.hypot(c.x - wx, c.y - wy) - c.r * 1.35;
    if (d < bestD) { bestD = d; best = c.id; }
  }
  return bestD < 18 / state.eye.zoom ? best : null;
}

// click = tool action, drag = pan, wheel = zoom
let drag = null;
canvas.addEventListener("pointerdown", (ev) => {
  drag = { x: ev.clientX, y: ev.clientY, cx: state.eye.cx, cy: state.eye.cy, moved: false };
  canvas.setPointerCapture(ev.pointerId);
});
canvas.addEventListener("pointermove", (ev) => {
  if (!drag) { hoverAt(ev); return; }
  const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 5) return;
  if (state.view.zoom <= 1) return;
  drag.moved = true;
  setFollow(false);
  canvas.classList.add("is-dragging");
  const rect = canvas.getBoundingClientRect();
  const [hw] = halfSpan(state.eye);
  const perPx = (2 * hw) / rect.width;
  state.view.cx = drag.cx - dx * perPx;
  state.view.cy = drag.cy - dy * perPx;
  clampView();
  state.eye.cx = state.view.cx; // dragging should feel attached to the pointer
  state.eye.cy = state.view.cy;
});
canvas.addEventListener("pointerleave", () => { state.hover = null; hoverTip.hidden = true; });

// Hovering names the creature under the pointer.
const hoverTip = $("hover-tip");
function hoverAt(ev) {
  if (state.tool !== "inspect") { state.hover = null; hoverTip.hidden = true; return; }
  const [x, y] = screenToWorld(ev.clientX, ev.clientY);
  const id = nearestCreature(x, y);
  state.hover = id;
  const c = id !== null && findInFrame(id);
  if (!c) { hoverTip.hidden = true; return; }
  const sp = state.species.get(c.species);
  const kind = c.diet >= PREDATOR_MIN ? "hunter" : c.diet >= FORAGER_MAX ? "omnivore" : "grazer";
  hoverTip.innerHTML = sp ? `<em>${escapeHtml(sp.name)}</em>, a ${kind}` : `An unnamed ${kind}`;
  const wrap = canvas.parentElement.getBoundingClientRect();
  hoverTip.style.left = `${ev.clientX - wrap.left + 14}px`;
  hoverTip.style.top = `${ev.clientY - wrap.top + 14}px`;
  hoverTip.hidden = false;
}
canvas.addEventListener("pointerup", (ev) => {
  const wasDrag = drag && drag.moved;
  drag = null;
  canvas.classList.remove("is-dragging");
  if (wasDrag) return;
  const [x, y] = screenToWorld(ev.clientX, ev.clientY);
  if (state.tool === "inspect") {
    const id = nearestCreature(x, y);
    state.selected = id;
    send({ type: "inspect", id });
    if (id === null) { setFollow(false); showCreature(null); }
  } else {
    send({ type: "event", kind: state.tool, x, y });
  }
});
canvas.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  zoomAt(Math.exp(-ev.deltaY * 0.0015), ev.clientX, ev.clientY);
}, { passive: false });
$("zoom-in").addEventListener("click", () => zoomAt(1.5));
$("zoom-out").addEventListener("click", () => zoomAt(1 / 1.5));
$("zoom-fit").addEventListener("click", () => { setFollow(false); state.view.zoom = 1; clampView(); });

function setFollow(on) {
  state.follow = on;
  $("i-follow").setAttribute("aria-pressed", String(on));
  $("i-follow").textContent = on ? "Following" : "Follow";
  if (on && state.view.zoom < 3) state.view.zoom = 3;
}

// ---------------------------------------------------------------- charts
function prepChart(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight || c.height;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return [g, w, h];
}

function drawStacked(c, rows, keys, colours) {
  const [g, w, h] = prepChart(c);
  if (rows.length < 2) return;
  const pad = { l: 34, r: 4, t: 6, b: 18 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const totals = rows.map((r) => keys.reduce((a, k) => a + r[k], 0));
  const maxY = niceMax(Math.max(...totals, 10));
  const x = (i) => pad.l + (i / (rows.length - 1)) * iw;
  const y = (v) => pad.t + ih - (v / maxY) * ih;

  g.font = "11px Atkinson Hyperlegible, system-ui, sans-serif";
  g.fillStyle = COLOURS.muted;
  g.strokeStyle = COLOURS.line;
  g.lineWidth = 1;
  for (const v of [0, maxY / 2, maxY]) {
    g.beginPath(); g.moveTo(pad.l, y(v)); g.lineTo(w - pad.r, y(v)); g.stroke();
    g.fillText(fmt(v), 2, y(v) + 4);
  }
  g.fillText(`tick ${fmt(rows[0].tick)}`, pad.l, h - 4);
  const end = `tick ${fmt(rows[rows.length - 1].tick)}`;
  g.fillText(end, w - pad.r - g.measureText(end).width, h - 4);

  const base = new Array(rows.length).fill(0);
  keys.forEach((k, ki) => {
    g.beginPath();
    rows.forEach((r, i) => { const v = base[i] + r[k]; i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)); });
    for (let i = rows.length - 1; i >= 0; i--) g.lineTo(x(i), y(base[i]));
    g.closePath();
    g.fillStyle = colours[ki];
    g.globalAlpha = 0.85;
    g.fill();
    g.globalAlpha = 1;
    rows.forEach((r, i) => { base[i] += r[k]; });
  });
}

function drawSpark(c, values, colour, fixedMax) {
  const [g, w, h] = prepChart(c);
  if (values.length < 2) return;
  const lo = fixedMax ? 0 : Math.min(...values);
  const hi = fixedMax ?? Math.max(...values);
  const span = hi - lo || 1;
  g.beginPath();
  values.forEach((v, i) => {
    const px = (i / (values.length - 1)) * w;
    const py = h - 3 - ((v - lo) / span) * (h - 6);
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  });
  g.strokeStyle = colour;
  g.lineWidth = 2;
  g.lineJoin = "round";
  g.stroke();
}

function drawCharts() {
  const rows = state.history;
  drawStacked($("chart-pop"), rows, ["foragers", "omnivores", "predators"],
    [COLOURS.forager, COLOURS.omnivore, COLOURS.predator]);
  const col = (k) => rows.map((r) => r[k]);
  drawSpark($("spark-size"), col("mean_size"), COLOURS.ink);
  drawSpark($("spark-speed"), col("mean_speed"), COLOURS.forager);
  drawSpark($("spark-diet"), col("mean_diet"), COLOURS.predator, 1);
  drawSpark($("spark-attack"), col("attack_rate"), COLOURS.omnivore);
  const last = rows[rows.length - 1];
  if (last) {
    $("v-size").textContent = last.mean_size.toFixed(2);
    $("v-speed").textContent = last.mean_speed.toFixed(2);
    $("v-diet").textContent = `${Math.round(last.mean_diet * 100)}%`;
    $("v-attack").textContent = `${(last.attack_rate * 100).toFixed(1)}%`;
    $("r-gen").textContent = fmt(last.max_generation);
    $("r-pred").textContent = fmt(last.predators);
    $("r-species").textContent = last.species_alive ?? 0;
  }
}

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return v;
}

// ---------------------------------------------------------------- tree of life
// One lane per named species, ordered depth-first so daughters sit just below
// their parents. Band thickness follows population over time.
let treeLayout = null;

function layoutTree() {
  const all = [...state.species.values()].sort((a, b) => a.born - b.born || a.id - b.id);
  const kids = new Map();
  const roots = [];
  for (const s of all) {
    const parent = s.ancestor; // nearest named ancestor, worked out by the server
    if (parent >= 0 && state.species.has(parent)) {
      if (!kids.has(parent)) kids.set(parent, []);
      kids.get(parent).push(s);
    } else roots.push(s);
  }
  const order = [];
  const visit = (s) => { order.push(s); (kids.get(s.id) || []).forEach(visit); };
  roots.forEach(visit);
  return order;
}

function drawTree() {
  const c = $("tree");
  const rows = state.history;
  const order = layoutTree();
  // grow with the number of species so every lane stays readable
  c.style.height = `${Math.min(620, Math.max(220, 36 + order.length * 22))}px`;
  const [g, w, h] = prepChart(c);
  if (!rows.length || !order.length) {
    g.fillStyle = COLOURS.muted;
    g.font = "14px Atkinson Hyperlegible, system-ui, sans-serif";
    g.fillText("Species appear here once a group of creatures has drifted far enough from its ancestors.", 8, 24);
    treeLayout = null;
    return;
  }
  const pad = { l: 8, r: 8, t: 8, b: 20 };
  const t0 = rows[0].tick, t1 = Math.max(rows[rows.length - 1].tick, t0 + 1);
  const x = (t) => pad.l + ((t - t0) / (t1 - t0)) * (w - pad.l - pad.r);
  const lane = (h - pad.t - pad.b) / order.length;
  const yOf = new Map(order.map((s, i) => [s.id, pad.t + lane * (i + 0.5)]));
  const peak = Math.max(...order.map((s) => s.peak), 1);
  const maxHalf = Math.min(lane * 0.48 + 6, 16);

  // connectors from parent lane to daughter lane at the moment of birth
  g.lineWidth = 1;
  g.strokeStyle = "rgba(30,43,48,0.28)";
  for (const s of order) {
    if (!yOf.has(s.ancestor)) continue;
    const bx = x(Math.max(s.born, t0));
    g.beginPath();
    g.moveTo(bx, yOf.get(s.ancestor));
    g.lineTo(bx, yOf.get(s.id));
    g.stroke();
  }

  for (const s of order) {
    const y = yOf.get(s.id);
    const end = s.extinct ?? t1;
    // thin life line from birth to extinction
    g.strokeStyle = s.color;
    g.globalAlpha = 0.5;
    g.beginPath();
    g.moveTo(x(Math.max(s.born, t0)), y);
    g.lineTo(x(end), y);
    g.stroke();
    g.globalAlpha = state.highlight === null || state.highlight === s.id ? 0.9 : 0.25;

    // population band
    const key = String(s.id);
    const pts = [];
    for (const r of rows) {
      const n = r.species ? r.species[key] || 0 : 0;
      if (r.tick < s.born || r.tick > end + 10) continue;
      pts.push([x(r.tick), Math.sqrt(n / peak) * maxHalf]);
    }
    if (pts.length > 1) {
      g.beginPath();
      pts.forEach(([px, hh], i) => (i ? g.lineTo(px, y - hh) : g.moveTo(px, y - hh)));
      for (let i = pts.length - 1; i >= 0; i--) g.lineTo(pts[i][0], y + pts[i][1]);
      g.closePath();
      g.fillStyle = s.color;
      g.fill();
    }
    if (s.extinct !== null && s.extinct !== undefined) {
      g.globalAlpha = 0.8;
      g.fillStyle = COLOURS.ink;
      g.fillRect(x(end) - 1, y - 4, 2, 8);
    }
    g.globalAlpha = 1;
    if (state.highlight === s.id) {
      g.strokeStyle = COLOURS.ink;
      g.lineWidth = 1.5;
      g.strokeRect(pad.l - 2, y - lane / 2, w - pad.l - pad.r + 4, lane);
      g.lineWidth = 1;
    }
  }

  // names, where there's room: just after each species' first appearance
  if (lane >= 11) {
    g.font = `italic ${Math.min(13, lane * 0.8)}px Atkinson Hyperlegible, system-ui, sans-serif`;
    g.textBaseline = "middle";
    for (const s of order) {
      const y = yOf.get(s.id);
      const label = s.name;
      let lx = x(Math.max(s.established ?? s.born, t0)) + 6;
      const tw = g.measureText(label).width;
      if (lx + tw > w - pad.r) lx = w - pad.r - tw;
      g.fillStyle = "rgba(250,251,246,0.85)";
      g.fillRect(lx - 3, y - lane * 0.42, tw + 6, lane * 0.84);
      g.fillStyle = s.extinct != null ? COLOURS.muted : COLOURS.ink;
      g.fillText(label, lx, y);
    }
    g.textBaseline = "alphabetic";
  }

  g.font = "11px Atkinson Hyperlegible, system-ui, sans-serif";
  g.fillStyle = COLOURS.muted;
  g.fillText(`tick ${fmt(t0)}`, pad.l, h - 5);
  const endLabel = `tick ${fmt(t1)}`;
  g.fillText(endLabel, w - pad.r - g.measureText(endLabel).width, h - 5);
  treeLayout = { order, lane, top: pad.t };
}

function treeHit(ev) {
  if (!treeLayout) return null;
  const rect = $("tree").getBoundingClientRect();
  const y = ev.clientY - rect.top;
  const i = Math.floor((y - treeLayout.top) / treeLayout.lane);
  return treeLayout.order[i] || null;
}

$("tree").addEventListener("mousemove", (ev) => {
  const s = treeHit(ev);
  const tip = $("tree-tip");
  if (!s) { tip.hidden = true; return; }
  const parent = state.species.get(s.ancestor);
  const status = s.extinct != null
    ? `Extinct at tick ${fmt(s.extinct)}, after ${fmt(s.extinct - s.born)} ticks`
    : `Alive: ${fmt(state.history.at(-1)?.species?.[String(s.id)] ?? s.count)} right now`;
  tip.innerHTML = `<b>${escapeHtml(s.name)}</b><br>${cap(s.traits.strategy)}. ${status}.<br>`
    + `Appeared at tick ${fmt(s.born)}, peaked at ${fmt(s.peak)}.`
    + (parent ? `<br>Descended from <em>${escapeHtml(parent.name)}</em>.` : "");
  tip.hidden = false;
  const wrap = $("tree").getBoundingClientRect();
  const left = Math.min(ev.clientX - wrap.left + 14, wrap.width - tip.offsetWidth - 4);
  tip.style.left = `${Math.max(4, left)}px`;
  tip.style.top = `${ev.clientY - wrap.top + 14}px`;
});
$("tree").addEventListener("mouseleave", () => { $("tree-tip").hidden = true; });
$("tree").addEventListener("click", (ev) => {
  const s = treeHit(ev);
  setHighlight(s && s.id !== state.highlight ? s.id : null);
});

function setHighlight(id) {
  state.highlight = id;
  state.treeDirty = true;
  renderGuide();
  if (id !== null && state.species.get(id)?.extinct != null) toast("That species is extinct. Its band shows when it lived.");
}

setInterval(() => { if (state.treeDirty) { state.treeDirty = false; drawTree(); } }, 500);

// ---------------------------------------------------------------- status + notes
function renderStatus() {
  const s = state.status;
  $("r-tick").textContent = fmt(s.tick);
  $("r-pop").textContent = fmt(s.population);
  $("r-ms").textContent = s.step_ms.toFixed(2);
  $("r-viewers").textContent = s.viewers;
  $("r-season").textContent = cap(s.season || "spring");
  const pause = $("btn-pause");
  pause.textContent = s.paused ? "Resume" : "Pause";
  pause.setAttribute("aria-pressed", String(s.paused));
  const speed = $("speed");
  if (document.activeElement !== speed) speed.value = String(s.speed);
}

const headlines = [];
function addEvents(events, live) {
  const log = $("log");
  for (const e of events || []) {
    const li = document.createElement("li");
    if (e.level === "headline") li.className = "is-headline";
    li.innerHTML = `<time>tick ${fmt(e.tick)}</time>${rich(e.text)}`;
    log.prepend(li);
    if (live && e.level === "headline") headlines.push(e.text);
    if (live && e.x !== undefined) {
      const r = { meteor: e.radius || 120, bloom: 150, invasion: 70 }[e.kind] || 100;
      state.effects.push({ kind: e.kind, x: e.x, y: e.y, r, t: performance.now() });
      if (gpu) GPUWorld.onEvent(gpu, e, performance.now());
    }
  }
  while (log.children.length > 200) log.lastChild.remove();
  if (live) nextHeadline();
}

let headlineTimer = null;
function nextHeadline() {
  if (headlineTimer || !headlines.length) return;
  if (headlines.length > 3) headlines.splice(0, headlines.length - 3); // keep it current
  const el = $("headline");
  el.innerHTML = rich(headlines.shift());
  el.hidden = false;
  el.classList.remove("is-leaving");
  headlineTimer = setTimeout(() => {
    el.classList.add("is-leaving");
    headlineTimer = setTimeout(() => {
      el.hidden = true;
      headlineTimer = null;
      nextHeadline();
    }, 450);
  }, 5500);
}

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---------------------------------------------------------------- inspector
function showCreature(c) {
  state.creature = c;
  $("inspect-empty").hidden = !!c;
  $("inspect-body").hidden = !c;
  if (!c) {
    if (state.selected !== null) {
      $("inspect-empty").textContent = "That creature has died. Click another one.";
      state.selected = null;
      setFollow(false);
      send({ type: "inspect", id: null });
    }
    return;
  }
  const sp = c.species;
  $("i-swatch").style.background = sp.color || `rgb(${c.color.map((v) => Math.round(v * 255)).join(",")})`;
  $("i-name").textContent = `Creature #${c.id}, a ${c.strategy}`;
  const speciesHtml = sp.name
    ? `<button class="sp-link" data-species="${sp.shown}"><em>${escapeHtml(sp.name)}</em></button>${sp.subspecies ? " (a new offshoot)" : ""}`
    : "an unnamed species";
  const family = c.parent < 0 ? "Founder of its family." : `Generation ${c.generation}.`;
  $("i-sub").innerHTML = `${speciesHtml}. ${family} ${c.lineage_size} relatives alive.`;
  $("i-doing").textContent = c.doing;
  const traits = [
    ["Age", fmt(c.age)], ["Energy", fmt(c.energy)], ["Children", c.children],
    ["Size", c.size.toFixed(2)], ["Top speed", c.speed.toFixed(2)], ["Meat in diet", `${Math.round(c.diet * 100)}%`],
    ["Plants eaten", c.meals], ["Kills", c.kills], ["Generation", c.generation],
  ];
  $("i-traits").innerHTML = traits.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
  drawBrain(c.brain, c.activity);
}

$("i-sub").addEventListener("click", (ev) => {
  const btn = ev.target.closest(".sp-link");
  if (btn) setHighlight(Number(btn.dataset.species) === state.highlight ? null : Number(btn.dataset.species));
});

function activityColour(a, alpha = 1) {
  const [r, g, b] = a >= 0 ? COLOURS.blue : COLOURS.red;
  return `rgba(${r},${g},${b},${alpha})`;
}

function drawBrain(brain, act) {
  const c = $("brain");
  const [g, w, h] = prepChart(c);
  const ins = brain.inputs, outs = brain.outputs;
  const hidden = brain.W1.length;
  const colX = [112, w / 2 + 6, w - 92];
  const layerY = (n, i) => 10 + ((h - 20) * (i + 0.5)) / n;
  const pos = [
    ins.map((_, i) => [colX[0], layerY(ins.length, i)]),
    Array.from({ length: hidden }, (_, i) => [colX[1], layerY(hidden, i)]),
    outs.map((_, i) => [colX[2], layerY(outs.length, i)]),
  ];
  const vals = [act.in, act.hidden, act.out];

  // edges: the signal actually flowing = weight x source activation
  const edge = (a, b, signal) => {
    const s = Math.min(1, Math.abs(signal));
    if (s < 0.04) return;
    g.beginPath();
    g.moveTo(a[0], a[1]);
    g.lineTo(b[0], b[1]);
    g.strokeStyle = activityColour(signal, 0.15 + 0.75 * s);
    g.lineWidth = 0.6 + 3 * s;
    g.stroke();
  };
  brain.W1.forEach((row, hI) => row.forEach((wgt, iI) => edge(pos[0][iI], pos[1][hI], wgt * act.in[iI])));
  brain.W2.forEach((row, oI) => row.forEach((wgt, hI) => edge(pos[1][hI], pos[2][oI], wgt * act.hidden[hI])));

  g.font = "11px Atkinson Hyperlegible, system-ui, sans-serif";
  g.textBaseline = "middle";
  pos.forEach((layer, li) => layer.forEach(([x, y], i) => {
    const a = Math.max(-1, Math.min(1, vals[li][i]));
    g.beginPath();
    g.arc(x, y, 4 + 3 * Math.abs(a), 0, Math.PI * 2);
    g.fillStyle = COLOURS.card;
    g.fill();
    g.fillStyle = activityColour(a, 0.25 + 0.75 * Math.abs(a));
    g.fill();
    g.lineWidth = 1.2;
    g.strokeStyle = COLOURS.ink;
    g.stroke();
    g.fillStyle = COLOURS.muted;
    if (li === 0) {
      const label = INPUT_LABELS[ins[i]] || ins[i];
      g.fillText(label, x - 12 - g.measureText(label).width, y);
    } else if (li === 2) {
      g.fillStyle = COLOURS.ink;
      g.fillText(outputLabel(outs[i], a), x + 12, y);
    }
  }));
  g.textBaseline = "alphabetic";
}

function outputLabel(name, a) {
  switch (name) {
    case "turn": return Math.abs(a) < 0.15 ? "turn: straight" : `turn: ${a < 0 ? "left" : "right"}`;
    case "thrust": return `thrust: ${Math.round(((a + 1) / 2) * 100)}%`;
    case "attack": return a > 0 ? "attack: yes" : "attack: no";
    case "reproduce": return a > 0 ? "breed: yes" : "breed: no";
    default: return name;
  }
}

$("i-close").addEventListener("click", () => {
  state.selected = null;
  setFollow(false);
  send({ type: "inspect", id: null });
  $("inspect-empty").textContent = "Click any creature to watch its brain think.";
  showCreature(null);
});
$("i-follow").addEventListener("click", () => setFollow(!state.follow));

// ---------------------------------------------------------------- portraits
// The legend, the field guide and the inspector all draw creatures with the
// same art as the world, just bigger.
const LEGEND_SPECS = {
  grazer: { size: 1, speed: 2.2, diet: 0.08, color: "#5c9e5a", id: 3 },
  hunter: { size: 1.2, speed: 3.4, diet: 0.92, color: "#8e5aa8", id: 4 },
  ready: { size: 1, speed: 2.2, diet: 0.1, color: "#3b78a8", id: 0, energy: 1.3 },
  starving: { size: 1, speed: 2.2, diet: 0.1, color: "#d08c2c", id: 1, energy: 0.08, age: 0.9 },
  fast: { size: 0.8, speed: 7, diet: 0.15, color: "#2a9d9a", id: 2 },
};
// Specs for GPU portraits, from species traits or legend presets.
function gpuSpec({ size = 1, speed = 2.5, diet = 0.1, color = "#3b78a8", id = 0, energy = 0.8, age = 0.3, kills = 0, species = id }) {
  return { r: 5 * size, diet, speed: Math.min(1, speed / 8), energy, thrust: 0.5, age, kills, biting: false, ate: false,
    species, id, rgb: Art.hexToRgb(color) };
}

function drawLegend() {
  document.querySelectorAll(".legend-icon").forEach((cv) => {
    const preset = LEGEND_SPECS[cv.dataset.icon];
    if (gpu && GPUWorld.drawPortrait(cv, gpuSpec(preset), 2200, 0)) return;
    Art.drawPortrait(cv, Art.specFor(preset), 2.2, 0);
  });
}

let guideIds = "";
function renderGuide() {
  const latest = state.history.at(-1)?.species || {};
  const living = [...state.species.values()]
    .filter((s) => s.extinct == null)
    .map((s) => ({ s, n: latest[String(s.id)] ?? s.count }))
    .sort((a, b) => b.n - a.n);
  const list = $("guide");
  const ids = living.map((x) => x.s.id).join();
  if (ids !== guideIds) {
    guideIds = ids;
    list.innerHTML = living.length ? "" : '<li class="guide-empty">No species named yet.</li>';
    for (const { s } of living) {
      const li = document.createElement("li");
      li.innerHTML = `<button data-species="${s.id}" aria-pressed="false">
        <canvas aria-hidden="true"></canvas>
        <span class="g-name">${escapeHtml(s.name)}</span>
        <span class="g-meta"></span></button>`;
      li.querySelector("button").addEventListener("click", () =>
        setHighlight(state.highlight === s.id ? null : s.id));
      list.append(li);
    }
  }
  for (const { s, n } of living) {
    const btn = list.querySelector(`[data-species="${s.id}"]`);
    if (!btn) continue;
    btn.querySelector(".g-meta").textContent =
      `${cap(s.traits.strategy)}, ${fmt(n)} alive. Named at tick ${fmt(s.established ?? s.born)}.`;
    btn.setAttribute("aria-pressed", String(state.highlight === s.id));
  }
}

let portraitFrame = 0;
function drawPortraits(t) {
  const useGpu = gpu && GPUWorld.available();
  portraitFrame++;
  // field guide: each species drawn from the traits it had when it was named
  // (on the GPU these refresh at 15 frames a second; they're small)
  if (!useGpu || portraitFrame % 4 === 0) {
    for (const btn of $("guide").querySelectorAll("button")) {
      const s = state.species.get(Number(btn.dataset.species));
      if (!s) continue;
      const traits = { size: s.traits.size, speed: s.traits.speed, diet: s.traits.diet, color: s.color, id: s.id, species: s.id };
      if (useGpu) { GPUWorld.drawPortrait(btn.querySelector("canvas"), gpuSpec(traits), (t + s.id) * 1000, -0.3); continue; }
      const spec = Art.specFor(traits);
      spec.thrust = 0.45;
      Art.drawPortrait(btn.querySelector("canvas"), spec, t + s.id, -0.3);
    }
  }
  // inspector: the selected creature as it is right now
  const c = findInFrame(state.selected);
  if (c && !$("inspect-body").hidden) {
    if (useGpu) {
      GPUWorld.drawPortrait($("portrait"), { ...c, thrust: Math.max(c.thrust, 0.25), rgb: creatureColour(c) }, t * 1000, -0.25);
      return;
    }
    const spec = specOf(c, c.r * 1.35);
    spec.thrust = Math.max(spec.thrust, 0.25);
    Art.drawPortrait($("portrait"), spec, t, -0.25);
  }
}

// ---------------------------------------------------------------- controls
function buildSliders() {
  const box = $("sliders");
  box.innerHTML = "";
  for (const [key, spec] of Object.entries(state.tunable)) {
    const [label, help] = SLIDER_TEXT[key] || [key, ""];
    const wrap = document.createElement("div");
    wrap.className = "slider";
    wrap.innerHTML = `
      <label for="s-${key}"><span>${label}</span><output id="o-${key}"></output></label>
      <p>${help}</p>
      <input id="s-${key}" type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}">`;
    box.append(wrap);
    const input = wrap.querySelector("input");
    input.value = state.config[key];
    $(`o-${key}`).textContent = state.config[key];
    input.addEventListener("input", () => { $(`o-${key}`).textContent = input.value; });
    input.addEventListener("change", () => send({ type: "set", key, value: Number(input.value) }));
  }
}

function syncSliders() {
  for (const key of Object.keys(state.tunable)) {
    const input = $(`s-${key}`);
    if (!input || document.activeElement === input) continue;
    input.value = state.config[key];
    $(`o-${key}`).textContent = Number(state.config[key]).toString();
  }
}

document.querySelectorAll(".tool").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("is-active", b === btn));
    state.tool = btn.dataset.tool;
    canvas.dataset.tool = state.tool;
  });
});
canvas.dataset.tool = "inspect";

$("btn-pause").addEventListener("click", () => send({ type: "pause", paused: !state.status.paused }));
$("speed").addEventListener("change", (e) => send({ type: "speed", value: Number(e.target.value) }));
$("colour-mode").addEventListener("change", (e) => { state.colourMode = e.target.value; });
function setMicroscope(mode) {
  state.microscope = mode;
  document.documentElement.dataset.microscope = mode;
  $("microscope").value = mode;
  try { localStorage.setItem("primordial.microscope", mode); } catch { /* private mode */ }
  drawLegend();
}
$("microscope").addEventListener("change", (e) => setMicroscope(e.target.value));
if (!gpu) $("microscope").closest("label").hidden = true; // the 2D renderer only has one look
$("btn-reset").addEventListener("click", () => {
  const raw = $("seed").value.trim();
  send({ type: "reset", seed: raw === "" ? null : Number(raw) });
});
$("load-world").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const res = await fetch("/api/snapshot", { method: "POST", body: file });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "That file couldn't be loaded.");
    toast(`Loaded a world at tick ${fmt(body.tick)} with ${fmt(body.population)} creatures.`);
  } catch (err) {
    toast(`Couldn't load that world: ${err.message}`);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, textarea")) return;
  if (e.code === "Space") { e.preventDefault(); send({ type: "pause", paused: !state.status.paused }); }
  if (e.key === "Escape") { setHighlight(null); setFollow(false); }
});

window.addEventListener("resize", () => { resizeCanvas(); drawCharts(); state.treeDirty = true; });
resizeCanvas();
if (gpu) state.view.zoom = 1.5; // start a little closer, so the creatures read; Fit shows the whole dish
try { setMicroscope(localStorage.getItem("primordial.microscope") || "dark"); } catch { setMicroscope("dark"); }
drawLegend();
document.fonts?.ready.then(drawLegend);
connect();
requestAnimationFrame(draw);
