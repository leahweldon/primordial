// GLSL for the GPU renderer. Every visual is procedural: there are no image
// assets. Creatures are signed distance fields evaluated per pixel, so they
// stay crisp at any zoom and every moving part animates on the GPU.
"use strict";

const Shaders = (() => {
  const header = `#version 300 es
precision highp float;
`;

  // ---------------------------------------------------------------- shared
  const common = `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
// world units -> clip space, given the camera (x0, y0, pixels per unit)
vec4 toClip(vec2 world, vec3 cam, vec2 res) {
  vec2 px = (world - cam.xy) * cam.z;
  return vec4(px.x / res.x * 2.0 - 1.0, 1.0 - px.y / res.y * 2.0, 0.0, 1.0);
}
`;

  // ---------------------------------------------------------------- full screen
  const fullscreenVS = `${header}
out vec2 v_uv;
void main() {
  // one triangle that covers the screen
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  // The slide itself: water with drifting caustic light, nutrient clouds
  // over the fertile oases, and fine debris. Dark field: lit from the side
  // so the background is near black. Bright field: lit from below, pale.
  const backgroundFS = `${header}${common}
in vec2 v_uv;
uniform vec3 u_cam;
uniform vec2 u_res;
uniform float u_time;
uniform float u_mode;        // 0 = dark field, 1 = bright field
uniform vec3 u_zones[8];     // x, y, sigma
uniform int u_zoneCount;
uniform vec3 u_season;       // tint
uniform float u_winter;      // 0..1
out vec4 o;

// Moving light filaments from the edges of drifting cells (my own take on
// caustics: the difference of the two nearest cell distances).
float cells(vec2 p, float t) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(x, y);
    vec2 o = hash22(i + g);
    o = 0.5 + 0.42 * sin(t * 0.55 + 6.2831 * o);
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
  }
  return 1.0 - smoothstep(0.0, 0.16, d2 - d1);
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
  vec2 w = u_cam.xy + px / u_cam.z;            // world position of this pixel
  float t = u_time;

  vec2 warp = vec2(fbm(w * 0.004 + t * 0.03), fbm(w * 0.004 - t * 0.025 + 9.0)) * 60.0;
  float caustic = cells((w + warp) * 0.011, t) * 0.65 + cells((w - warp) * 0.019 + 3.7, t * 1.3) * 0.35;

  float haze = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= u_zoneCount) break;
    vec2 d = w - u_zones[i].xy;
    float s = u_zones[i].z * 1.35;
    haze += exp(-dot(d, d) / (2.0 * s * s));
  }
  float cloud = fbm(w * 0.012 + vec2(t * 0.02, -t * 0.015));
  haze *= 0.55 + 0.9 * cloud;

  // fine debris on the slide: tiny specks on a world-space grid
  vec2 cell = floor(w / 9.0);
  vec2 spot = (cell + 0.2 + 0.6 * hash22(cell)) * 9.0;
  float speck = (1.0 - smoothstep(0.35, 0.9, length(w - spot))) * step(0.82, hash12(cell + 3.1));

  vec3 col;
  if (u_mode < 0.5) {
    vec3 deep = mix(vec3(0.010, 0.030, 0.040), vec3(0.018, 0.052, 0.060), fbm(w * 0.0025));
    col = deep;
    col += vec3(0.05, 0.13, 0.13) * caustic * (0.55 + 0.45 * cloud);
    col += vec3(0.05, 0.17, 0.09) * haze;
    col += vec3(0.10, 0.13, 0.12) * speck * 0.6;
    col *= u_season;
    col = mix(col, col * vec3(0.8, 0.95, 1.25) + vec3(0.0, 0.01, 0.025), u_winter);
  } else {
    vec3 agar = mix(vec3(0.86, 0.89, 0.79), vec3(0.92, 0.93, 0.85), fbm(w * 0.006));
    col = agar;
    col += vec3(0.05, 0.05, 0.03) * caustic;
    col = mix(col, vec3(0.62, 0.74, 0.50), clamp(haze * (0.35 + 0.4 * cloud), 0.0, 0.7));
    col -= vec3(0.25, 0.25, 0.2) * speck * 0.35;
    col *= mix(vec3(1.0), u_season, 0.6);
    col = mix(col, vec3(0.88, 0.92, 0.95), u_winter * 0.35);
  }
  o = vec4(col, 1.0);
}`;

  // ---------------------------------------------------------------- plants
  // Algae tufts: a few fronds around a holdfast, swaying in the current.
  // In dark field they fluoresce.
  const plantVS = `${header}${common}
in vec2 a_corner;
in vec3 a_plant;           // x, y, seed
uniform vec3 u_cam;
uniform vec2 u_res;
out vec2 v_q;
flat out float v_seed;
const float SIZE = 6.0;
void main() {
  v_q = a_corner;
  v_seed = a_plant.z;
  gl_Position = toClip(a_plant.xy + a_corner * SIZE, u_cam, u_res);
}`;

  const plantFS = `${header}${common}
in vec2 v_q;
flat in float v_seed;
uniform float u_time;
uniform float u_mode;
uniform vec3 u_leaf;
uniform vec3 u_leaf2;
uniform vec3 u_flower;
out vec4 o;

void main() {
  float aa = fwidth(v_q.x) * 1.2;
  vec3 col;
  float alpha, d, inner;
  if (v_seed < 0.22) {
    // a diatom: a glassy disc with radial ribs, slowly turning
    vec2 p = rot(u_time * 0.2 + v_seed * 30.0) * v_q;
    float r = length(p);
    d = r - 0.42;
    float ribs = 0.5 + 0.5 * cos(atan(p.y, p.x) * 16.0);
    float ring = 1.0 - smoothstep(0.0, 0.04, abs(r - 0.28));
    vec3 gold = mix(vec3(0.78, 0.62, 0.25), vec3(0.92, 0.8, 0.4), ribs);
    inner = clamp(-d / 0.42, 0.0, 1.0);
    col = gold * (0.55 + 0.45 * ribs * inner) + gold * ring * 0.4;
  } else {
    // an algal tuft: slender curved fronds around a holdfast, swaying
    float n = 3.0 + floor(fract(v_seed * 7.3) * 4.0);
    float sway = sin(u_time * 1.1 + v_seed * 40.0) * 0.25;
    d = 1e3;
    float tipGlow = 0.0, along = 0.0, hue = 0.0;
    for (int i = 0; i < 7; i++) {
      if (float(i) >= n) break;
      float fi = float(i);
      float h = hash12(vec2(v_seed * 13.0, fi));
      float a = v_seed * 6.2831 + fi * 6.2831 / n + sway * (0.5 + h);
      vec2 v = rot(-a) * v_q;
      float len = 0.55 + 0.38 * h;
      float curl = (h - 0.5) * 1.4;
      v.y -= curl * v.x * v.x;                    // fronds curve
      float x = clamp(v.x / len, 0.0, 1.0);
      float width = 0.15 * sin(3.1416 * pow(x, 0.8)) + 0.02;
      float di = max(abs(v.y) - width, max(-v.x, v.x - len));
      if (di < d) { d = di; along = x; hue = h; }
      tipGlow = max(tipGlow, exp(-length(v - vec2(len, 0.0)) * 16.0));
    }
    d = min(d, length(v_q) - 0.1);
    inner = clamp(-d / 0.12, 0.0, 1.0);
    vec3 leaf = mix(u_leaf, u_leaf2, hue);
    col = mix(leaf * 0.7, leaf * 1.15, along);
    col = mix(col, u_flower, tipGlow * step(0.6, v_seed) * 0.9);
    if (u_mode < 0.5) col += leaf * tipGlow * 0.8;
  }
  float cover = 1.0 - smoothstep(-aa, aa, d);
  if (u_mode < 0.5) {
    // fluorescing in dark field: bright edges, glowing halo
    float rim = exp(-max(-d, 0.0) * 18.0);
    vec3 c = col * (0.35 + 1.1 * rim);
    float glow = exp(-max(d, 0.0) * 12.0) * 0.32;
    alpha = cover * 0.95;
    o = vec4(c * alpha + col * glow * (1.0 - cover), max(alpha, glow * 0.5));
  } else {
    float rim = 1.0 - smoothstep(0.0, 0.05, -d);
    vec3 c = mix(col * 1.05, col * 0.45, rim);
    alpha = cover * 0.9;
    o = vec4(c * alpha, alpha);
  }
  if (o.a < 0.003) discard;
}`;

  // ---------------------------------------------------------------- creatures
  // One instance per creature. The vertex shader interpolates between the
  // last two server frames and sizes a quad around the body; the fragment
  // shader draws the whole animal as a distance field.
  const creatureVS = `${header}${common}
in vec2 a_corner;
in vec3 a_p0;        // previous frame: x, y, heading
in vec3 a_p1;        // current frame
in vec4 a_body;      // radius, diet, speed gene, energy (1 = ready to breed)
in vec3 a_col;
in vec4 a_motion;    // thrust, age, kills, seed
in vec4 a_flags;     // biting, ate, dissolve, grow
in vec4 a_look;      // marking, mark seed, dim, ring (1 hover, 2 selected)
in vec2 a_extra;     // killed, newborn
uniform vec3 u_cam;
uniform vec2 u_res;
uniform float u_alpha;
out vec2 v_q;
flat out vec4 v_shape;   // L, W, tail length, pixels per body radius
flat out vec4 v_genes;   // diet, speed, energy, thrust
flat out vec4 v_motion;  // age, kills, seed, killed
flat out vec4 v_flags;   // biting, ate, dissolve, dim
flat out vec4 v_look;    // marking, mark seed, ring, ringRadius
flat out vec3 v_col;
void main() {
  vec2 pos = mix(a_p0.xy, a_p1.xy, u_alpha);
  float dh = a_p1.z - a_p0.z;
  dh = atan(sin(dh), cos(dh));
  float h = a_p0.z + dh * u_alpha;
  float r = a_body.x * a_flags.w;
  float diet = a_body.y, speed = a_body.z, energy = a_body.w;
  float L = 1.12 + 0.45 * diet + 0.25 * speed;
  float W = (1.0 - 0.22 * diet) * (0.72 + 0.28 * min(energy, 1.0));
  float tail = 0.7 + 2.3 * speed;
  float back = L * 0.85 + tail + 0.45;
  float front = L + 0.75 + 0.75 * diet;
  float side = W + 0.95;
  float ringR = max(L, W) + 1.25;
  if (a_look.w > 0.5) { back = max(back, ringR + 0.4); front = max(front, ringR + 0.4); side = max(side, ringR + 0.4); }
  vec2 local = vec2(a_corner.x < 0.0 ? -back : front, a_corner.y * side);
  vec2 world = pos + rot(h) * local * r;
  gl_Position = toClip(world, u_cam, u_res);
  v_q = local;
  v_shape = vec4(L, W, tail, r * u_cam.z);
  v_genes = vec4(diet, speed, energy, a_motion.x);
  v_motion = vec4(a_motion.y, a_motion.z, a_motion.w, a_extra.x);
  v_flags = vec4(a_flags.x, a_flags.y, a_flags.z, a_look.z);
  v_look = vec4(a_look.x, a_look.y, a_look.w, ringR);
  v_col = a_col;
}`;

  const creatureFS = `${header}${common}
in vec2 v_q;
flat in vec4 v_shape;
flat in vec4 v_genes;
flat in vec4 v_motion;
flat in vec4 v_flags;
flat in vec4 v_look;
flat in vec3 v_col;
uniform float u_time;
uniform float u_mode;
out vec4 o;

float sdEllipse(vec2 p, vec2 ab) {      // fast approximation, exact on the axes
  float k0 = length(p / ab);
  float k1 = length(p / (ab * ab));
  return k0 * (k0 - 1.0) / max(k1, 1e-4);
}
float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
// distance to a circular arc between angles a0 < a1, and how far along it we are
vec2 sdArc(vec2 p, float R, float a0, float a1) {
  float a = atan(p.y, p.x);
  if (a > a0 && a < a1) return vec2(abs(length(p) - R), (a - a0) / (a1 - a0));
  vec2 e0 = R * vec2(cos(a0), sin(a0)), e1 = R * vec2(cos(a1), sin(a1));
  float d0 = length(p - e0), d1 = length(p - e1);
  return d0 < d1 ? vec2(d0, 0.0) : vec2(d1, 1.0);
}
// Anti-aliased coverage of a distance field. The blur width comes from the
// screen-space derivative, capped at about a pixel: where a field jumps
// (outside a part's range) the derivative would otherwise smear a seam.
float g_px = 0.1;   // size of one pixel in body radii, set at the top of main()
float fill(float d) { float aa = clamp(fwidth(d), 1e-4, g_px * 1.2); return 1.0 - smoothstep(-aa, aa, d); }

// paint one layer over another (premultiplied)
void over(inout vec4 acc, vec3 col, float a) { acc.rgb = col * a + acc.rgb * (1.0 - a); acc.a = a + acc.a * (1.0 - a); }

void main() {
  float L = v_shape.x, W = v_shape.y, tailLen = v_shape.z, ppr = v_shape.w;
  g_px = 1.0 / max(ppr, 0.5);
  float diet = v_genes.x, speed = v_genes.y, energy = v_genes.z, thrust = v_genes.w;
  float age = v_motion.x, kills = v_motion.y, seed = v_motion.z, killed = v_motion.w;
  float biting = v_flags.x, ate = v_flags.y, dissolve = v_flags.z, dim = v_flags.w;
  float t = u_time;
  float phase = seed * 6.2831;
  bool dark = u_mode < 0.5;
  vec3 c = v_col;
  // starving creatures go pale, old ones fade
  c = mix(c, vec3(0.55), clamp((0.35 - energy) / 0.35, 0.0, 1.0) * 0.5);
  c = mix(c, vec3(0.55), clamp((age - 0.7) * 1.3, 0.0, 0.5));

  // the whole body flexes as it swims: the back swings, the head stays steady
  float beat = t * (5.0 + 11.0 * thrust) + phase;
  vec2 q = v_q;
  float flex = (0.05 + 0.16 * thrust) * sin(q.x * 1.6 - beat) * clamp((L - q.x) / (2.0 * L), 0.0, 1.0);
  vec2 b = vec2(q.x, q.y - flex);

  // ---- body: an ellipse with a gently rippling membrane
  float theta = atan(b.y / W, b.x / L);
  float dBody = sdEllipse(b, vec2(L, W)) + 0.025 * sin(theta * 7.0 + t * 2.3 + phase);

  // spikes on the back half, raked backwards; more of them on hunters
  float dSpikes = 1e3;
  if (diet > 0.4) {
    float n = 1.0 + 4.0 * diet;
    float a = abs(theta);
    float m = (a - 1.75) / 1.2 * (n - 0.5) - dBody * 0.9;
    float tri = max(0.0, 1.0 - abs(fract(m) - 0.5) * 3.2);
    float on = step(1.7, a) * step(a, 3.0);
    float len = 0.25 + 0.3 * diet;
    dSpikes = dBody - len * tri * on;
  }

  // ---- tail: a tapered wave whose beat follows how hard it swims
  float x0 = -L * 0.82;
  float u = (x0 - b.x) / tailLen;
  float amp = 0.12 + 0.5 * thrust;
  float dTail = 1e3;
  if (u > -0.05 && u < 1.1) {
    float uc = clamp(u, 0.0, 1.0);
    float yc = sin(beat - uc * 3.2) * amp * uc;
    float dydu = amp * (sin(beat - uc * 3.2) - 3.2 * uc * cos(beat - uc * 3.2));
    float slope = dydu / tailLen;
    float thick = 0.17 * (1.0 - 0.8 * uc);
    dTail = abs(b.y - yc) / sqrt(1.0 + slope * slope) - thick;
    if (u > 1.0) dTail = length(vec2(b.x - (x0 - tailLen), b.y - yc)) - thick;
  }

  // ---- pincers: two arcs around the mouth that open while biting
  float dJaw = 1e3;
  if (diet > 0.35) {
    float open = biting > 0.5 ? 0.3 + 0.7 * abs(sin(t * 26.0 + phase)) : 0.12;
    float R = 0.3 + 0.42 * diet;
    vec2 cJ = b - vec2(L * 0.9 + R * 0.55, 0.0);
    float tip = 0.3 + 0.75 * open;          // angle of the tips from straight ahead
    vec2 j1 = sdArc(cJ, R, tip, 2.55);
    vec2 j2 = sdArc(vec2(cJ.x, -cJ.y), R, tip, 2.55);
    // thick at the base, sharp at the tip
    float th1 = 0.03 + 0.1 * j1.y, th2 = 0.03 + 0.1 * j2.y;
    dJaw = min(j1.x - th1, j2.x - th2);
  }

  // ---- cilia: a fringe of hairs that beat in a travelling wave
  float cilia = 0.0;
  float ciliaLen = 0.34 * (1.0 - diet);
  if (diet < 0.55 && ppr > 5.0 && dBody > -0.02 && dBody < ciliaLen) {
    float k = 18.0;
    float along = theta / 6.2831 * k;
    float bend = 0.35 * sin(t * 8.0 - theta * 5.0 + phase) * (dBody / ciliaLen);
    float lineD = abs(fract(along + bend) - 0.5) / k * 6.2831 * (L + W) * 0.5;
    float aa = fwidth(lineD) + 1e-4;
    float hair = 1.0 - smoothstep(0.035 - aa, 0.035 + aa, lineD);
    float ends = step(abs(cos(theta)), 0.93);
    cilia = hair * ends * (1.0 - dBody / ciliaLen) * smoothstep(0.0, 0.25, ppr / 12.0);
  }

  // ---- compose, back to front
  vec4 acc = vec4(0.0);
  vec3 limb = dark ? mix(c, vec3(1.0), 0.25) * 1.25 : c * 0.42;
  float limbA = dark ? 0.85 : 0.95;

  if (dark) {
    // a soft glow around the whole animal
    float halo = exp(-max(min(dBody, dTail + 0.1), 0.0) * 5.5) * 0.28;
    acc = vec4(c * halo, halo * 0.6);
  } else {
    // a soft contact shadow on the slide
    float sh = exp(-max(sdEllipse(b - vec2(0.18, 0.32), vec2(L, W)), 0.0) * 7.0) * 0.22;
    acc = vec4(vec3(0.0), sh);
  }
  over(acc, limb, fill(dTail) * limbA);
  over(acc, limb, fill(dJaw) * limbA);
  over(acc, dark ? c * 0.9 : c * 0.4, fill(dSpikes) * (dark ? 0.75 : 0.95));
  over(acc, limb * (dark ? 0.9 : 1.0), cilia * (dark ? 0.7 : 0.75));

  float body = fill(dBody);
  if (body > 0.0) {
    float inside = max(-dBody, 0.0);
    vec3 bc;
    float ba;
    // organelles drifting round the cell (cytoplasmic streaming)
    float org = 0.0;
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      vec2 h = hash22(vec2(seed * 91.0, fi));
      float ang = h.x * 6.2831 + t * (0.35 + 0.25 * h.y) * (mod(fi, 2.0) < 0.5 ? 1.0 : -1.0);
      vec2 op = vec2(cos(ang) * L * 0.55, sin(ang) * W * 0.5);
      float orr = 0.07 + 0.07 * h.y;
      org = max(org, 1.0 - smoothstep(orr * 0.6, orr, length(b - op)));
    }
    // markings: spots, bands or a dorsal stripe, fixed per species
    float mark = 0.0;
    float m = v_look.x, ms = v_look.y;
    if (m < 0.34) {
      for (int i = 0; i < 6; i++) {
        vec2 h = hash22(vec2(ms, float(i) * 3.1));
        vec2 sp = vec2((h.x - 0.5) * 1.4 * L, (h.y - 0.5) * 1.3 * W);
        mark = max(mark, 1.0 - smoothstep(0.1, 0.17, length(b - sp)));
      }
    } else if (m < 0.67) {
      mark = smoothstep(0.55, 0.8, sin(b.x * 5.5 + b.y * 0.8 + ms));
    } else {
      mark = 1.0 - smoothstep(0.07, 0.14, abs(b.y + 0.08 * sin(b.x * 2.0)));
      mark *= step(b.x, L * 0.55);
    }
    // nucleus, which glows and pulses when ready to breed
    float ready = step(1.0, energy);
    vec2 np = b - vec2(-L * 0.28, 0.0);
    float nr = W * 0.32 * (1.0 + ready * 0.12 * sin(t * 5.0 + phase));
    float nuc = 1.0 - smoothstep(nr * 0.85, nr, length(np));
    float nucGlow = ready * exp(-max(length(np) - nr, 0.0) * 6.0);

    if (dark) {
      // translucent cytoplasm with a bright membrane: dark-field microscopy
      float rim = exp(-inside * 7.0);
      bc = c * 0.16 + mix(c, vec3(1.0), 0.45) * rim * 1.5;
      bc += c * mark * 0.22 + vec3(0.55, 0.75, 0.7) * org * 0.35;
      bc = mix(bc, mix(c, vec3(1.0), 0.3) * 0.55, nuc * 0.7);
      bc += vec3(1.0, 0.93, 0.6) * (nuc * ready * 1.6 + nucGlow * 0.9);
      ba = 0.55 + 0.45 * rim;
    } else {
      // stained specimen on a lit slide: tinted body, dark membrane
      float rim = 1.0 - smoothstep(0.0, 0.11, inside);
      float light = 0.5 + 0.5 * clamp(dot(normalize(b + vec2(0.001)), normalize(vec2(-0.5, -0.8))), -1.0, 1.0);
      bc = mix(c, vec3(1.0), 0.32 + 0.18 * light * (1.0 - rim));
      bc = mix(bc, c * 0.62, mark * 0.6);
      bc = mix(bc, c * 0.9 + 0.08, org * 0.5);
      bc = mix(bc, c * 0.55, nuc * 0.75);
      bc = mix(bc, vec3(1.0, 0.95, 0.7), nuc * ready * 0.8);
      bc = mix(bc, c * 0.38, rim);
      ba = 0.9;
    }

    // scars on veteran hunters
    float scars = min(3.0, floor(kills / 8.0));
    float scar = 0.0;
    for (int i = 0; i < 3; i++) {
      if (float(i) >= scars) break;
      vec2 h = hash22(vec2(seed * 13.0, float(i)));
      vec2 sc = vec2((h.x - 0.5) * L, (h.y - 0.5) * W);
      float cut = sdSegment(b, sc - vec2(0.24, 0.12), sc + vec2(0.24, 0.12));
      float st = 1e3;
      for (int j = -1; j <= 1; j++) {
        vec2 sj = sc + vec2(0.12, 0.06) * float(j);
        st = min(st, sdSegment(b, sj + vec2(-0.04, 0.08), sj + vec2(0.04, -0.08)));
      }
      scar = max(scar, fill(min(cut, st) - 0.025));
    }
    bc = mix(bc, dark ? vec3(1.0, 0.85, 0.8) : vec3(0.97, 0.92, 0.88), scar * 0.8);

    over(acc, bc, body * ba);

    // eyes: wide-set on grazers, forward-facing on hunters; they blink
    float ex = L * (0.42 + 0.22 * diet), ey = W * (0.6 - 0.3 * diet);
    float er = 0.2 + 0.08 * (1.0 - min(1.0, age * 8.0));
    float blink = step(0.985, sin(t * 0.9 + phase * 7.0));
    for (int s = -1; s <= 1; s += 2) {
      vec2 e = b - vec2(ex, float(s) * ey);
      e.y /= mix(1.0, 0.12, blink);
      float white = fill(length(e) - er);
      vec2 pp = e - vec2(er * 0.3, float(s) * er * (diet > 0.5 ? -0.08 : 0.06));
      float pupil = fill(length(pp) - er * 0.55) * (1.0 - blink);
      float glint = fill(length(e - vec2(er * 0.12, -er * 0.25)) - er * 0.18) * (1.0 - blink);
      over(acc, dark ? vec3(0.92, 0.97, 0.95) * 1.1 : vec3(0.98, 0.98, 0.95), white);
      over(acc, vec3(0.05, 0.08, 0.09), pupil);
      over(acc, vec3(1.0), glint * 0.9);
    }
    // grazers have a small mouth that works away while they eat
    if (diet <= 0.35) {
      vec2 mp = b - vec2(L * 0.86, 0.0);
      float open = ate > 0.5 ? 0.35 + 0.25 * sin(t * 20.0 + phase) : 0.2;
      vec2 arc = sdArc(vec2(-mp.x, mp.y), 0.16, -open * 3.0, open * 3.0);
      over(acc, dark ? c * 0.5 : c * 0.3, fill(arc.x - 0.035));
    }
  }

  // ---- selection and hover rings
  if (v_look.z > 0.5) {
    float R = v_look.w;
    float d = abs(length(q) - R) - (v_look.z > 1.5 ? 0.06 : 0.04);
    float ang = atan(q.y, q.x);
    float dash = v_look.z > 1.5 ? step(0.35, fract(ang / 6.2831 * 10.0 + t * 0.25)) : 1.0;
    vec3 rc = dark ? vec3(0.65, 1.0, 0.92) * 1.6 : vec3(0.12, 0.17, 0.19);
    float a = fill(d) * dash * (v_look.z > 1.5 ? 0.95 : 0.5);
    acc.rgb += rc * a * (1.0 - acc.a * 0.5);
    acc.a = max(acc.a, a);
  }

  // ---- dying: the body breaks up from a noisy edge that burns as it goes
  if (dissolve > 0.0) {
    float nz = fbm(q * 2.6 + seed * 31.0);
    float cut = dissolve * 1.15 - 0.08;
    if (nz < cut) discard;
    float edge = 1.0 - smoothstep(0.0, 0.09, nz - cut);
    vec3 burn = killed > 0.5 ? vec3(1.6, 0.25, 0.18) : vec3(0.9, 0.85, 0.7);
    if (!dark) burn = killed > 0.5 ? vec3(0.6, 0.05, 0.05) : vec3(0.35, 0.33, 0.3);
    acc.rgb = mix(acc.rgb, burn * acc.a, edge * step(0.01, acc.a));
    acc *= 1.0 - dissolve * 0.35;
  }

  acc *= mix(1.0, 0.16, dim);
  if (acc.a < 0.002) discard;
  o = acc;
}`;

  // ---------------------------------------------------------------- particles
  // Soft sprites for births, deaths, meals and meteors. Motion is computed
  // on the GPU from launch time and velocity, so the CPU only appends.
  const particleVS = `${header}${common}
in vec2 a_corner;
in vec4 a_pv;        // x, y, vx, vy
in vec4 a_life;      // start time, lifetime, size, kind (0 dot, 1 ring)
in vec3 a_col;
uniform vec3 u_cam;
uniform vec2 u_res;
uniform float u_time;
out vec2 v_q;
flat out float v_fade;
flat out float v_kind;
flat out vec3 v_col;
void main() {
  float age = u_time - a_life.x;
  float k = clamp(age / a_life.y, 0.0, 1.0);
  vec2 p = a_pv.xy + a_pv.zw * (1.0 - exp(-age * 2.2)) / 2.2;   // drag
  float size = a_life.z * (a_life.w > 0.5 ? (0.3 + 1.6 * k) : (1.0 - 0.4 * k));
  v_q = a_corner;
  v_fade = (1.0 - k) * step(0.0, age);
  v_kind = a_life.w;
  v_col = a_col;
  gl_Position = toClip(p + a_corner * size, u_cam, u_res);
}`;

  const particleFS = `${header}
in vec2 v_q;
flat in float v_fade;
flat in float v_kind;
flat in vec3 v_col;
uniform float u_mode;
out vec4 o;
void main() {
  float d = length(v_q);
  float a = v_kind > 0.5 ? exp(-pow((d - 0.8) * 7.0, 2.0)) : exp(-d * d * 4.0);
  a *= v_fade * step(d, 1.0);
  if (a < 0.003) discard;
  // additive glow in dark field, ordinary blending in bright field
  o = u_mode < 0.5 ? vec4(v_col * a * 1.4, 0.0) : vec4(v_col * a, a);
}`;

  // Plankton and dust drifting at different depths in front of and behind
  // the focal plane. They move with parallax and the out-of-focus ones blur.
  const planktonVS = `${header}${common}
in vec2 a_corner;
in vec4 a_mote;      // seed x, seed y, depth (0 far .. 1 near), seed
uniform vec2 u_res;
uniform vec2 u_camCentre;   // camera centre in world units
uniform float u_zoom;
uniform float u_time;
out vec2 v_q;
flat out float v_depth;
flat out float v_seed;
void main() {
  float depth = a_mote.z;
  float par = mix(0.35, 1.9, depth);           // parallax relative to the slide
  vec2 drift = vec2(sin(u_time * 0.07 + a_mote.w * 40.0), cos(u_time * 0.05 + a_mote.w * 17.0)) * 0.03 + vec2(u_time * 0.004, u_time * 0.002);
  vec2 p = fract(a_mote.xy + drift - u_camCentre / vec2(1600.0, 1000.0) * par * u_zoom * 0.5);
  float size = mix(1.2, 9.0, depth * depth) * (0.6 + 0.4 * a_mote.w) * (u_res.y / 900.0);
  v_q = a_corner;
  v_depth = depth;
  v_seed = a_mote.w;
  vec2 px = p * u_res + a_corner * size;
  gl_Position = vec4(px.x / u_res.x * 2.0 - 1.0, 1.0 - px.y / u_res.y * 2.0, 0.0, 1.0);
}`;

  const planktonFS = `${header}
in vec2 v_q;
flat in float v_depth;
flat in float v_seed;
uniform float u_mode;
out vec4 o;
void main() {
  float d = length(v_q);
  float focus = abs(v_depth - 0.45);                   // distance from the focal plane
  float soft = mix(5.0, 1.4, clamp(focus * 2.2, 0.0, 1.0));
  float a = exp(-d * d * soft) * step(d, 1.0) * mix(0.55, 0.16, clamp(focus * 2.0, 0.0, 1.0));
  if (a < 0.003) discard;
  vec3 col = mix(vec3(0.55, 0.85, 0.8), vec3(0.85, 0.8, 0.55), v_seed);
  o = u_mode < 0.5 ? vec4(col * a * 0.8, 0.0) : vec4(vec3(0.25, 0.3, 0.22) * a * 0.5, a * 0.5);
}`;

  // ---------------------------------------------------------------- post
  const brightFS = `${header}
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_threshold;
out vec4 o;
void main() {
  vec3 c = texture(u_src, v_uv).rgb;
  float l = max(c.r, max(c.g, c.b));
  o = vec4(c * smoothstep(u_threshold, u_threshold + 0.35, l), 1.0);
}`;

  const blurFS = `${header}
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_dir;        // one texel step along the blur direction
out vec4 o;
void main() {
  // 9-tap Gaussian folded into 5 bilinear samples
  vec3 c = texture(u_src, v_uv).rgb * 0.2270270;
  c += texture(u_src, v_uv + u_dir * 1.3846154).rgb * 0.3162162;
  c += texture(u_src, v_uv - u_dir * 1.3846154).rgb * 0.3162162;
  c += texture(u_src, v_uv + u_dir * 3.2307692).rgb * 0.0702703;
  c += texture(u_src, v_uv - u_dir * 3.2307692).rgb * 0.0702703;
  o = vec4(c, 1.0);
}`;

  const compositeFS = `${header}
in vec2 v_uv;
uniform sampler2D u_scene;
uniform sampler2D u_bloomA;
uniform sampler2D u_bloomB;
uniform vec2 u_res;
uniform float u_time;
uniform float u_mode;
uniform float u_bloom;
uniform float u_aberration;
uniform float u_vignette;
uniform vec4 u_shocks[4];   // centre (uv), radius (in screen heights), strength
out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 tone(vec3 c) {
  // leave ordinary colours alone and roll off highlights smoothly
  vec3 over = max(c - 0.78, 0.0);
  return min(c, 0.78) + 0.22 * (1.0 - exp(-over / 0.22));
}
void main() {
  vec2 uv = v_uv;
  float aspect = u_res.x / u_res.y;
  // meteor shockwaves bend the image as they pass
  for (int i = 0; i < 4; i++) {
    vec4 s = u_shocks[i];
    if (s.w <= 0.0) continue;
    vec2 d = uv - s.xy;
    d.x *= aspect;
    float dist = length(d);
    float ring = exp(-pow((dist - s.z) * 22.0, 2.0)) * s.w;
    uv -= normalize(d + 1e-5) * ring * 0.035 / vec2(aspect, 1.0);
  }
  // the lens: colour fringes grow towards the edge of the field of view
  vec2 cc = uv - 0.5;
  float ab = dot(cc, cc) * u_aberration;
  vec3 col = vec3(texture(u_scene, uv - cc * ab).r, texture(u_scene, uv).g, texture(u_scene, uv + cc * ab).b);
  vec3 bloom = texture(u_bloomA, uv).rgb * 0.6 + texture(u_bloomB, uv).rgb * 0.9;
  col += bloom * u_bloom;
  col = tone(col);
  float v = smoothstep(1.15, 0.35, length(cc * vec2(aspect * 0.8, 1.0)));
  col *= mix(1.0 - u_vignette, 1.0, v);
  col += (hash(gl_FragCoord.xy + fract(u_time) * 100.0) - 0.5) * (u_mode < 0.5 ? 0.035 : 0.02);
  o = vec4(col, 1.0);
}`;

  return {
    background: [fullscreenVS, backgroundFS],
    plant: [plantVS, plantFS],
    creature: [creatureVS, creatureFS],
    particle: [particleVS, particleFS],
    plankton: [planktonVS, planktonFS],
    bright: [fullscreenVS, brightFS],
    blur: [fullscreenVS, blurFS],
    composite: [fullscreenVS, compositeFS],
  };
})();
