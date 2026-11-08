// WebGL2 2-D HDR renderer: instanced lightning segments drawn as a Gaussian plasma
// channel or as a shaded liquid tube (metal / water), dual-filter bloom, ACES tone mapping.
const FS_TRI = `#version 300 es
out vec2 v_uv;
void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); v_uv=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;

const ARC_VS = `#version 300 es
precision highp float;
layout(location=0) in vec4 a_ab; layout(location=1) in vec4 a_twi;
uniform vec2 u_res; uniform float u_width; uniform float u_minPx; uniform float u_overlap;
out float v_across; out float v_T; out float v_gain; out float v_along; flat out float v_L; flat out float v_hw; flat out float v_cap; flat out vec2 v_nrm;
void main(){
  int id = gl_VertexID; float side = (id&1)==0 ? -1.0 : 1.0; bool e0 = id<2;
  vec2 a = a_ab.xy, b = a_ab.zw; vec2 d = b-a; float L = length(d);
  vec2 dir = L>1e-4 ? d/L : vec2(1,0); vec2 n = vec2(-dir.y, dir.x);
  float cap = a_twi.y < 0.0 ? 1.0 : 0.0;
  float wTrue = u_width*abs(a_twi.y);
  float wpx = max(wTrue, u_minPx);
  v_gain = (wTrue/wpx) * a_twi.z;
  // additive passes must not overlap at joints (they would double up into beads);
  // MAX-blended tubes overlap a little so joints stay seamless
  float j = u_overlap * wpx;
  float ext = (!e0 && cap > 0.5) ? wpx*1.2 : j;
  vec2 p = (e0 ? a : b) + n*side*wpx*0.5 + dir*(e0 ? -j : ext);
  gl_Position = vec4(p/u_res*2.0-1.0, 0.0, 1.0); gl_Position.y = -gl_Position.y;
  v_across = side; v_T = a_twi.x; v_along = e0 ? -j : L+ext; v_L = L; v_hw = wpx*0.5; v_cap = cap; v_nrm = n;
}`;
const ARC_FS = `#version 300 es
precision highp float;
in float v_across; in float v_T; in float v_gain; in float v_along; flat in float v_L; flat in float v_hw; flat in float v_cap; flat in vec2 v_nrm;
out vec4 o;
uniform sampler2D u_lut; uniform vec2 u_lutRange; uniform float u_gain, u_sharp; uniform int u_style; uniform float u_time;
void main(){
  vec3 c = texture(u_lut, vec2(clamp((v_T-u_lutRange.x)/(u_lutRange.y-u_lutRange.x),0.0,1.0),0.5)).rgb;
  float B = pow(v_T/10000.0, 4.0);   // Stefan–Boltzmann: radiance ∝ T⁴
  float dEnd = v_cap > 0.5 ? max(v_along - v_L, 0.0)/max(v_hw,1e-3) : 0.0;
  if(u_style == 0){
    float g = exp(-v_across*v_across*u_sharp) * exp(-dEnd*dEnd*u_sharp);
    o = vec4(c*B*g*v_gain*u_gain, 1.0);
    return;
  }
  // tube shading: treat the strand as a cylinder (round end caps on termini)
  float r = sqrt(v_across*v_across + dEnd*dEnd);
  if(r >= 1.0) discard;
  float nz = sqrt(1.0 - r*r);                       // surface normal toward the viewer
  float vis = smoothstep(1300.0, 4500.0, v_T);      // vanishes as the channel cools
  float shift = 0.25*sin(u_time*1.7 + dot(gl_FragCoord.xy, vec2(0.006, 0.009)));
  // screen-space surface normal of the tube; "up" = toward the top of the screen
  vec2 N2 = v_nrm * v_across;
  float up = -N2.y;
  vec3 col;
  if(u_style == 1){
    // liquid metal (chrome): bright sky above the horizon, dark ground below,
    // a sharp horizon line and a moving specular glint, tinted by the glow colour
    float env = mix(0.04, 0.95, smoothstep(-0.10, 0.30, up + shift*0.3));
    float horizon = 0.9*exp(-pow((up - 0.06 - shift*0.2)/0.05, 2.0));
    float spec = 1.6*pow(max(0.0, 1.0 - length(vec2(N2.x + 0.25, up - 0.45))*2.2), 3.0);
    float refl = (env*(0.45 + 0.55*nz) + horizon) * (0.35 + 0.65*pow(1.0 - nz, 0.35)) + spec + 0.05;
    col = mix(vec3(0.80,0.83,0.90), c, 0.3) * refl + c*min(B,6.0)*0.05*nz;
  } else {
    // water: dark transparent body, bright Fresnel rim and a glint
    float fres = pow(1.0 - nz, 3.0);
    float spec = 1.4*pow(max(0.0, 1.0 - length(vec2(N2.x + 0.3, up - 0.4))*2.5), 3.0);
    col = vec3(0.06,0.25,0.45)*(0.3 + 0.7*smoothstep(-0.5, 0.6, up)) + vec3(0.55,0.85,1.0)*fres*1.4 + vec3(spec) + c*min(B,6.0)*0.03;
  }
  float aa = smoothstep(1.0, 0.82, r);
  o = vec4(col*aa*vis*u_gain, 1.0);
}`;
const DOWN_FS = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o; uniform sampler2D u_src; uniform vec2 u_texel;
void main(){
  vec2 t=u_texel; vec2 uv=v_uv;
  vec3 a=texture(u_src,uv+t*vec2(-2,2)).rgb, b=texture(u_src,uv+t*vec2(0,2)).rgb, c=texture(u_src,uv+t*vec2(2,2)).rgb;
  vec3 d=texture(u_src,uv+t*vec2(-2,0)).rgb, e=texture(u_src,uv).rgb, f=texture(u_src,uv+t*vec2(2,0)).rgb;
  vec3 g=texture(u_src,uv+t*vec2(-2,-2)).rgb, h=texture(u_src,uv+t*vec2(0,-2)).rgb, i=texture(u_src,uv+t*vec2(2,-2)).rgb;
  vec3 j=texture(u_src,uv+t*vec2(-1,1)).rgb, k=texture(u_src,uv+t*vec2(1,1)).rgb, l=texture(u_src,uv+t*vec2(-1,-1)).rgb, m=texture(u_src,uv+t*vec2(1,-1)).rgb;
  vec3 s = e*0.125 + (a+c+g+i)*0.03125 + (b+d+f+h)*0.0625 + (j+k+l+m)*0.125;
  o = vec4(min(s, vec3(6.0e4)),1.0);
}`;
const UP_FS = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o; uniform sampler2D u_src; uniform vec2 u_texel;
void main(){
  vec2 t=u_texel; vec2 uv=v_uv;
  vec3 s = texture(u_src,uv).rgb*4.0;
  s += (texture(u_src,uv+vec2(-t.x,0)).rgb + texture(u_src,uv+vec2(t.x,0)).rgb + texture(u_src,uv+vec2(0,-t.y)).rgb + texture(u_src,uv+vec2(0,t.y)).rgb)*2.0;
  s += texture(u_src,uv+vec2(-t.x,-t.y)).rgb + texture(u_src,uv+vec2(t.x,-t.y)).rgb + texture(u_src,uv+vec2(-t.x,t.y)).rgb + texture(u_src,uv+vec2(t.x,t.y)).rgb;
  o = vec4(s/16.0,1.0);
}`;
const COMP_FS = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_hdr, u_bloom; uniform float u_bloomK, u_time;
uniform vec3 u_room; uniform vec2 u_lightPos; uniform float u_aspect;
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }
vec3 srgb(vec3 c){ return mix(c*12.92, 1.055*pow(c,vec3(1.0/2.4))-0.055, step(0.0031308,c)); }
void main(){
  vec3 h = texture(u_hdr,v_uv).rgb;
  vec3 b = texture(u_bloom,v_uv).rgb;
  // faint room illumination from the discharge
  vec2 dv = (v_uv - u_lightPos)*vec2(u_aspect,1.0);
  vec3 bg = vec3(0.003,0.004,0.008) + u_room/(1.0 + dot(dv,dv)*5.0);
  vec3 c = srgb(aces(h + b*(u_bloomK/6.0) + bg));
  float n = fract(sin(dot(gl_FragCoord.xy+u_time, vec2(12.9898,78.233)))*43758.5453);
  o = vec4(c + (n-0.5)/255.0, 1.0);
}`;

function compile(gl, vs, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    // desynchronized = low-latency canvas (skips the compositor queue where supported)
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, desynchronized: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    const floatOK = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    this.fmt = floatOK ? { i: gl.RGBA16F, t: gl.HALF_FLOAT } : { i: gl.RGBA8, t: gl.UNSIGNED_BYTE };
    this.arc = compile(gl, ARC_VS, ARC_FS);
    this.down = compile(gl, FS_TRI, DOWN_FS);
    this.up = compile(gl, FS_TRI, UP_FS);
    this.comp = compile(gl, FS_TRI, COMP_FS);
    this.emptyVao = gl.createVertexArray();
    this.arcVao = gl.createVertexArray();
    this.arcBuf = gl.createBuffer();
    gl.bindVertexArray(this.arcVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.arcBuf);
    gl.bufferData(gl.ARRAY_BUFFER, 4 * 8 * 60000, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0); gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16); gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    this.lutTex = gl.createTexture();
    this.scale = 1; this.w = this.h = 0;
  }

  setLUT(data, n, tmin, tmax) {
    const gl = this.gl, rgba = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { rgba.set(data.subarray(i * 3, i * 3 + 3), i * 4); rgba[i * 4 + 3] = 1; }
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, n, 1, 0, gl.RGBA, gl.FLOAT, rgba);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.lutRange = [tmin, tmax];
    this.lut = { data, n, tmin, tmax };
  }
  colorAt(T) {
    const { data, n, tmin, tmax } = this.lut;
    const i = Math.round(Math.min(1, Math.max(0, (T - tmin) / (tmax - tmin))) * (n - 1));
    return [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];
  }

  _tex(w, h) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.fmt.i, w, h, 0, gl.RGBA, this.fmt.t, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Resize to the canvas' CSS size × devicePixelRatio; returns [w, h] in device pixels. */
  resize() {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.scale;
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
    if (w !== this.w || h !== this.h) {
      this.w = w; this.h = h;
      this.canvas.width = w; this.canvas.height = h;
      for (const o of this.targets || []) { gl.deleteTexture(o.tex); gl.deleteFramebuffer(o.fbo); }
      this.targets = [];
      let mw = w, mh = h;
      for (let i = 0; i < 8; i++) {
        const tex = this._tex(mw, mh), fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        this.targets.push({ tex, fbo, w: mw, h: mh });
        mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1);
      }
    }
    this.dpr = dpr;
    return [w, h];
  }

  render(s) {
    const gl = this.gl, { w, h } = this, hdr = this.targets[0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, hdr.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const px = this.dpr;
    if (s.segCount > 0) {
      gl.bindVertexArray(this.arcVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.arcBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, s.segs, 0, s.segCount * 8);
      const p = this.arc;
      gl.useProgram(p.p);
      gl.uniform2f(p.u.u_res, w, h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.uniform1i(p.u.u_lut, 0);
      gl.uniform2fv(p.u.u_lutRange, this.lutRange);
      gl.uniform1f(p.u.u_time, s.time);
      const passes = s.style === 0
        ? [[0, 2.4 * px * s.thickness, 1.3, 0.55, 2.2], // white-hot core
           [0, 15 * px * s.thickness, 4.0, 0.05, 2.5]]  // corona
        : [[0, 22 * px * s.thickness, 4.0, 0.008, 2.0],  // faint electric glow behind it
           [s.style, 13 * px * s.thickness, 3.0, 1.0, 0]]; // liquid tube (MAX blend: seamless joints)
      for (const [style, wd, mp, g, sh] of passes) {
        gl.blendEquation(style === 0 ? gl.FUNC_ADD : gl.MAX);
        gl.uniform1i(p.u.u_style, style);
        gl.uniform1f(p.u.u_overlap, style === 0 ? 0.0 : 0.3);
        gl.uniform1f(p.u.u_width, wd); gl.uniform1f(p.u.u_minPx, mp);
        gl.uniform1f(p.u.u_gain, g * s.gain); gl.uniform1f(p.u.u_sharp, sh);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, s.segCount);
      }
      gl.blendEquation(gl.FUNC_ADD);
    }
    // bloom: downsample chain, then additive tent upsample
    gl.disable(gl.BLEND);
    gl.useProgram(this.down.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.down.u.u_src, 0);
    for (let i = 1; i < this.targets.length; i++) {
      const src = this.targets[i - 1], dst = this.targets[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo); gl.viewport(0, 0, dst.w, dst.h);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform2f(this.down.u.u_texel, 1 / src.w, 1 / src.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.useProgram(this.up.p);
    gl.uniform1i(this.up.u.u_src, 0);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = this.targets.length - 1; i > 1; i--) {
      const src = this.targets[i], dst = this.targets[i - 1];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo); gl.viewport(0, 0, dst.w, dst.h);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform2f(this.up.u.u_texel, 1 / src.w, 1 / src.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    const c = this.comp;
    gl.useProgram(c.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, hdr.tex); gl.uniform1i(c.u.u_hdr, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.targets[1].tex); gl.uniform1i(c.u.u_bloom, 1);
    gl.uniform1f(c.u.u_bloomK, s.bloom);
    gl.uniform1f(c.u.u_time, s.time);
    gl.uniform3f(c.u.u_room, s.room[0], s.room[1], s.room[2]);
    gl.uniform2f(c.u.u_lightPos, s.lightPos[0], s.lightPos[1]);
    gl.uniform1f(c.u.u_aspect, w / h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }
}
