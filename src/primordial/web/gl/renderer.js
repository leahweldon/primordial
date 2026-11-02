// The GPU renderer: draws the world into an HDR target, then bloom, lens
// and grain in a post-processing chain.
//
//   background (caustics, nutrient clouds)  -> scene target
//   plankton far layer, plants, creatures, particles, plankton near layer
//   bright pass -> blur at 1/2 and 1/4 res  -> bloom
//   composite: shockwave distortion, lens aberration, bloom, tone, vignette, grain
//
// Each creature is one instance of a quad: the whole population is a single
// draw call. The app fills instance data through addCreature() without
// allocating, then calls render().
"use strict";

class GLRenderer {
  static supported() {
    try {
      return !!document.createElement("canvas").getContext("webgl2");
    } catch {
      return false;
    }
  }

  constructor(canvas, { plankton = 420 } = {}) {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.canvas = canvas;
    this.hdr = !!gl.getExtension("EXT_color_buffer_float");
    const P = (name) => GLKit.program(gl, ...Shaders[name], name);
    this.p = {
      background: P("background"), plant: P("plant"), creature: P("creature"), particle: P("particle"),
      plankton: P("plankton"), bright: P("bright"), blur: P("blur"), composite: P("composite"),
    };
    const quad = GLKit.quad(gl);
    this.creatures = GLKit.instanced(gl, this.p.creature, quad, [
      ["a_p0", 3], ["a_p1", 3], ["a_body", 4], ["a_col", 3], ["a_motion", 4], ["a_flags", 4], ["a_look", 4], ["a_extra", 2],
    ]);
    this.plants = GLKit.instanced(gl, this.p.plant, quad, [["a_plant", 3]]);
    this.particles = GLKit.instanced(gl, this.p.particle, quad, [["a_pv", 4], ["a_life", 4], ["a_col", 3]]);
    this.motesFar = GLKit.instanced(gl, this.p.plankton, quad, [["a_mote", 4]]);
    this.motesNear = GLKit.instanced(gl, this.p.plankton, quad, [["a_mote", 4]]);
    this.emptyVao = gl.createVertexArray();
    this.nCreatures = 0;
    this.nParticles = 0;
    this.particleRing = 0;
    this.maxParticles = 6000;
    this.particles.reserve(this.maxParticles);
    this.makeMotes(plankton);
    this.size = [0, 0];
  }

  makeMotes(n) {
    // a far layer drawn under the creatures and a near, out-of-focus layer over them
    const far = [], near = [];
    for (let i = 0; i < n; i++) {
      const depth = Math.random() < 0.7 ? Math.random() * 0.5 : 0.62 + Math.random() * 0.38;
      (depth < 0.5 ? far : near).push(Math.random(), Math.random(), depth, Math.random());
    }
    this.motesFar.reserve(far.length / 4).set(far);
    this.motesNear.reserve(near.length / 4).set(near);
    this.nFar = far.length / 4;
    this.nNear = near.length / 4;
  }

  resize(w, h) {
    if (this.size[0] === w && this.size[1] === h) return;
    this.size = [w, h];
    this.canvas.width = w;
    this.canvas.height = h;
    for (const t of ["scene", "halfA", "halfB", "quarterA", "quarterB"]) this[t]?.free();
    const gl = this.gl;
    this.scene = GLKit.target(gl, w, h, this.hdr);
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    const qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    this.halfA = GLKit.target(gl, hw, hh, this.hdr);
    this.halfB = GLKit.target(gl, hw, hh, this.hdr);
    this.quarterA = GLKit.target(gl, qw, qh, this.hdr);
    this.quarterB = GLKit.target(gl, qw, qh, this.hdr);
  }

  // ---------------------------------------------------------------- instances
  beginCreatures(max) {
    this.cdata = this.creatures.reserve(max);
    this.nCreatures = 0;
  }

  // c, p: current and previous state ({x, y, h, r, diet, speed, energy, thrust, age, kills, biting, ate})
  addCreature(c, p, rgb, o) {
    const d = this.cdata, s = this.creatures.stride, i = this.nCreatures++ * s;
    d[i] = p.x; d[i + 1] = p.y; d[i + 2] = p.h;
    d[i + 3] = c.x; d[i + 4] = c.y; d[i + 5] = c.h;
    d[i + 6] = c.r * 1.35; d[i + 7] = c.diet; d[i + 8] = c.speed; d[i + 9] = c.energy;
    d[i + 10] = rgb[0] / 255; d[i + 11] = rgb[1] / 255; d[i + 12] = rgb[2] / 255;
    d[i + 13] = c.thrust; d[i + 14] = c.age; d[i + 15] = c.kills; d[i + 16] = o.seed;
    d[i + 17] = c.biting ? 1 : 0; d[i + 18] = c.ate ? 1 : 0; d[i + 19] = o.dissolve || 0; d[i + 20] = o.grow ?? 1;
    d[i + 21] = o.marking; d[i + 22] = o.markSeed; d[i + 23] = o.dim ? 1 : 0; d[i + 24] = o.ring || 0;
    d[i + 25] = o.killed ? 1 : 0; d[i + 26] = 0;
  }

  setPlants(plants, count) {
    const d = this.plants.reserve(count);
    for (let i = 0; i < count; i++) {
      const x = plants[2 * i], y = plants[2 * i + 1];
      d[i * 3] = x;
      d[i * 3 + 1] = y;
      d[i * 3 + 2] = ((x * 3001 + y * 7) % 997) / 997; // stable per position
    }
    this.nPlants = count;
  }

  // Particles live in a ring buffer: old ones are simply overwritten.
  emit(x, y, vx, vy, t0, life, size, rgb, kind = 0) {
    const d = this.particles.reserve(this.maxParticles), s = this.particles.stride;
    const i = this.particleRing * s;
    d[i] = x; d[i + 1] = y; d[i + 2] = vx; d[i + 3] = vy;
    d[i + 4] = t0; d[i + 5] = life; d[i + 6] = size; d[i + 7] = kind;
    d[i + 8] = rgb[0]; d[i + 9] = rgb[1]; d[i + 10] = rgb[2];
    this.particleRing = (this.particleRing + 1) % this.maxParticles;
    this.nParticles = Math.min(this.maxParticles, this.nParticles + 1);
  }

  // ---------------------------------------------------------------- frame
  // view: { x0, y0, k } camera; o: { time, alpha, mode, zones, season, winter,
  // leaf, leaf2, flower, shocks, bloom }
  render(view, o) {
    const gl = this.gl;
    const [W, H] = this.size;
    const cam = [view.x0, view.y0, view.k];
    const res = [W, H];
    const dark = o.mode === 0;

    this.scene.bind();
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    // background
    const bg = this.p.background.use();
    const zones = new Float32Array(24);
    (o.zones || []).slice(0, 8).forEach((z, i) => zones.set([z[0], z[1], z[2]], i * 3));
    bg.set("u_cam", cam).set("u_res", res).set("u_time", o.time).set("u_mode", o.mode)
      .set("u_zones", zones).set("u_zoneCount", Math.min(8, (o.zones || []).length))
      .set("u_season", o.season).set("u_winter", o.winter);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND);
    const additive = () => gl.blendFunc(gl.ONE, gl.ONE);
    const over = () => gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // plankton behind the slide's focal plane
    const motes = this.p.plankton.use();
    motes.set("u_res", res).set("u_camCentre", [view.x0 + W / view.k / 2, view.y0 + H / view.k / 2])
      .set("u_zoom", view.zoom || 1).set("u_time", o.time).set("u_mode", o.mode);
    dark ? additive() : over();
    this.motesFar.draw(this.nFar);

    over();
    this.p.plant.use().set("u_cam", cam).set("u_res", res).set("u_time", o.time).set("u_mode", o.mode)
      .set("u_leaf", o.leaf).set("u_leaf2", o.leaf2).set("u_flower", o.flower);
    this.plants.draw(this.nPlants || 0);

    this.p.creature.use().set("u_cam", cam).set("u_res", res).set("u_time", o.time)
      .set("u_mode", o.mode).set("u_alpha", o.alpha);
    this.creatures.draw(this.nCreatures);

    this.p.particle.use().set("u_cam", cam).set("u_res", res).set("u_time", o.time).set("u_mode", o.mode);
    dark ? additive() : over();
    this.particles.draw(this.nParticles);

    // plankton in front of the focal plane, out of focus
    this.p.plankton.use();
    this.motesNear.draw(this.nNear);
    gl.disable(gl.BLEND);

    // ---- bloom
    gl.bindVertexArray(this.emptyVao);
    const tex = (unit, t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); };
    this.halfA.bind();
    this.p.bright.use().set("u_src", 0).set("u_threshold", dark ? 0.62 : 0.9);
    tex(0, this.scene.tex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const blur = this.p.blur.use().set("u_src", 0);
    const pass = (from, to, dx, dy) => { to.bind(); blur.set("u_dir", [dx / from.w, dy / from.h]); tex(0, from.tex); gl.drawArrays(gl.TRIANGLES, 0, 3); };
    pass(this.halfA, this.halfB, 1, 0);
    pass(this.halfB, this.halfA, 0, 1);
    pass(this.halfA, this.quarterA, 1, 0);
    pass(this.quarterA, this.quarterB, 0, 1);
    pass(this.quarterB, this.quarterA, 2, 0);
    pass(this.quarterA, this.quarterB, 0, 2);

    // ---- composite to the screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    const shocks = new Float32Array(16);
    (o.shocks || []).slice(0, 4).forEach((s, i) => shocks.set(s, i * 4));
    this.p.composite.use().set("u_scene", 0).set("u_bloomA", 1).set("u_bloomB", 2)
      .set("u_res", res).set("u_time", o.time).set("u_mode", o.mode)
      .set("u_bloom", o.bloom ?? (dark ? 1.0 : 0.25)).set("u_aberration", dark ? 0.009 : 0.004)
      .set("u_vignette", dark ? 0.55 : 0.22).set("u_shocks", shocks);
    tex(0, this.scene.tex);
    tex(1, this.halfA.tex);
    tex(2, this.quarterB.tex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
}
