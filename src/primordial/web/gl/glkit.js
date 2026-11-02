// A very small WebGL2 toolkit: shader programs with readable errors,
// instanced vertex buffers, and render targets. Just enough to keep the
// renderer readable without pulling in an engine.
"use strict";

const GLKit = (() => {
  function compile(gl, type, source, name) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      // show the offending lines with numbers, which the raw log doesn't
      const lines = source.split("\n").map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join("\n");
      throw new Error(`${name} ${type === gl.VERTEX_SHADER ? "vertex" : "fragment"} shader failed:\n${log}\n${lines}`);
    }
    return sh;
  }

  // A program plus cached uniform locations: prog.set("u_time", 1.2) etc.
  function program(gl, vs, fs, name = "shader") {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs, name));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs, name));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name} failed to link: ${gl.getProgramInfoLog(p)}`);
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      uniforms[info.name.replace(/\[0\]$/, "")] = { loc: gl.getUniformLocation(p, info.name), type: info.type };
    }
    const setters = {
      [gl.FLOAT]: (l, v) => gl.uniform1f(l, v),
      [gl.FLOAT_VEC2]: (l, v) => gl.uniform2fv(l, v),
      [gl.FLOAT_VEC3]: (l, v) => gl.uniform3fv(l, v),
      [gl.FLOAT_VEC4]: (l, v) => gl.uniform4fv(l, v),
      [gl.INT]: (l, v) => gl.uniform1i(l, v),
      [gl.SAMPLER_2D]: (l, v) => gl.uniform1i(l, v),
      [gl.FLOAT_MAT3]: (l, v) => gl.uniformMatrix3fv(l, false, v),
    };
    return {
      handle: p,
      use() { gl.useProgram(p); return this; },
      set(name, value) {
        const u = uniforms[name];
        if (u) setters[u.type](u.loc, value); // silently skip uniforms the compiler optimised away
        return this;
      },
      attrib: (name) => gl.getAttribLocation(p, name),
    };
  }

  // One unit quad shared by every instanced pass: corners at (-1,-1)..(1,1).
  function quad(gl) {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    return buf;
  }

  // An instanced draw: one quad, many instances, each with a block of floats.
  // `layout` lists [attributeName, componentCount] in the order they sit in
  // each instance's block.
  function instanced(gl, prog, quadBuf, layout) {
    const vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    const corner = prog.attrib("a_corner");
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    const stride = layout.reduce((s, [, n]) => s + n, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    let offset = 0;
    for (const [name, n] of layout) {
      const loc = prog.attrib(name);
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, n, gl.FLOAT, false, stride * 4, offset * 4);
        gl.vertexAttribDivisor(loc, 1);
      }
      offset += n;
    }
    gl.bindVertexArray(null);
    let capacity = 0;
    let data = new Float32Array(0);
    return {
      stride,
      // grow-only CPU and GPU storage, so steady state allocates nothing
      reserve(count) {
        if (count * stride > data.length) data = new Float32Array(Math.ceil(count * 1.5) * stride);
        return data;
      },
      draw(count) {
        if (!count) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        if (count > capacity) {
          capacity = Math.ceil(count * 1.5);
          gl.bufferData(gl.ARRAY_BUFFER, capacity * stride * 4, gl.DYNAMIC_DRAW);
        }
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * stride);
        gl.bindVertexArray(vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
        gl.bindVertexArray(null);
      },
    };
  }

  // A colour render target. HDR (half float) when the GPU supports it, so
  // bloom can pick out values brighter than white.
  function target(gl, w, h, hdr) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) throw new Error("render target is incomplete");
    return {
      tex, fbo, w, h,
      bind() { gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, w, h); },
      free() { gl.deleteTexture(tex); gl.deleteFramebuffer(fbo); },
    };
  }

  return { program, quad, instanced, target };
})();
