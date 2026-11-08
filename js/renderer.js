// WebGL2 HDR renderer: volumetric cloud slab, ground, rain, tower, instanced lightning
// channel (Gaussian cross-section), dual-filter Gaussian-like bloom, ACES tone mapping.
import { perspective, lookAt, mul, invert } from './math.js';

const FS_TRI = `#version 300 es
out vec2 v_uv;
void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); v_uv=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;

const NOISE = `
float hash13(vec3 p){ p=fract(p*0.1031); p+=dot(p,p.zyx+31.32); return fract((p.x+p.y)*p.z); }
float vnoise(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  float a=hash13(i), b=hash13(i+vec3(1,0,0)), c=hash13(i+vec3(0,1,0)), d=hash13(i+vec3(1,1,0));
  float e=hash13(i+vec3(0,0,1)), g=hash13(i+vec3(1,0,1)), h=hash13(i+vec3(0,1,1)), k=hash13(i+vec3(1,1,1));
  return mix(mix(mix(a,b,f.x),mix(c,d,f.x),f.y), mix(mix(e,g,f.x),mix(h,k,f.x),f.y), f.z); }
float fbm(vec3 p){ float s=0.0, a=0.5; for(int i=0;i<4;i++){ s+=a*vnoise(p); p=p*2.03+vec3(1.7,9.2,3.1); a*=0.5; } return s; }
`;

const ENV_FS = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform mat4 u_invvp; uniform vec3 u_cam; uniform float u_time;
uniform vec4 u_light;   // x = radiant sum, yzw = centroid
uniform vec3 u_lcol;
uniform vec4 u_gnd;     // xyz attach point, w = intensity
uniform float u_cb, u_ct, u_amb, u_flashK;
${NOISE}
float cloudDen(vec3 p){
  float h = (p.y-u_cb)/(u_ct-u_cb);
  float prof = smoothstep(0.0,0.18,h)*smoothstep(1.0,0.55,h);
  float n = fbm(p*0.00085 + vec3(u_time*0.004,0.0,u_time*0.0025));
  float d = fbm(p*0.0031 - vec3(0.0,u_time*0.01,0.0));
  return clamp((n*1.15 + d*0.35 - 0.45)*2.4,0.0,1.0)*prof;
}
vec3 lightAt(vec3 p){
  vec3 d = p - u_light.yzw; float r2 = dot(d,d);
  return u_lcol * u_light.x * u_flashK / (r2 + 2.5e5);
}
void main(){
  vec4 w = u_invvp * vec4(v_uv*2.0-1.0, 1.0, 1.0);
  vec3 dir = normalize(w.xyz/w.w - u_cam);
  vec3 ambC = vec3(0.018,0.022,0.035)*u_amb;
  vec3 col = ambC*0.6 + vec3(0.004,0.005,0.009)*max(dir.y+0.2,0.0);
  float tHit = 1e9;
  // ground plane
  if(dir.y < 0.0 && u_cam.y > 0.0){
    float t = -u_cam.y/dir.y; vec3 p = u_cam + dir*t; tHit = t;
    float n = fbm(vec3(p.xz*0.004,0.0)); float n2 = vnoise(vec3(p.xz*0.06,1.0));
    vec3 alb = mix(vec3(0.020,0.026,0.018), vec3(0.045,0.040,0.030), n) * (0.75+0.5*n2);
    vec3 L = u_light.yzw - p; float ld = length(L);
    vec3 E = lightAt(p) * max(L.y/ld, 0.0) * 1.6;
    vec3 G = u_gnd.xyz - p; float gd2 = dot(G,G);
    E += u_lcol * u_gnd.w * 9.0e3 / (gd2 + 400.0);
    // wet ground: specular-ish sheen toward the flash
    vec3 h = normalize(normalize(L) - dir);
    float spec = pow(max(h.y,0.0), 60.0) * 0.6;
    col = alb*(ambC*2.0 + E) + lightAt(p)*spec*0.15;
    float fog = 1.0 - exp(-t/7000.0);
    col = mix(col, ambC*0.8 + lightAt(p)*0.02, fog);
  }
  // cloud slab (ray-marched)
  float t0, t1;
  if(abs(dir.y) > 1e-4){
    float a = (u_cb-u_cam.y)/dir.y, b = (u_ct-u_cam.y)/dir.y;
    t0 = max(min(a,b),0.0); t1 = max(a,b);
  } else { t0 = (u_cam.y>u_cb && u_cam.y<u_ct)?0.0:1e9; t1 = t0>0.0?0.0:12000.0; }
  t1 = min(t1, min(tHit, t0 + 9000.0));
  if(t1 > t0 && t0 < 40000.0){
    const int N = 14;
    float dt = (t1-t0)/float(N);
    float T = 1.0; vec3 acc = vec3(0);
    float jit = hash13(vec3(gl_FragCoord.xy, u_time));
    for(int i=0;i<N;i++){
      vec3 p = u_cam + dir*(t0 + (float(i)+jit)*dt);
      float den = cloudDen(p);
      if(den>0.001){
        float ext = den*0.0022*dt;
        vec3 Li = lightAt(p)*7.0 + ambC*2.5*(0.6+0.4*(p.y-u_cb)/(u_ct-u_cb));
        acc += T * Li * (1.0-exp(-ext));
        T *= exp(-ext);
        if(T<0.02) break;
      }
    }
    float fog = 1.0 - exp(-t0/16000.0);
    vec3 cc = mix(acc, ambC*0.5, fog*0.8);
    col = col*T + cc;
  }
  o = vec4(col, 1.0);
}`;

const BOLT_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_p0; layout(location=1) in vec3 a_p1; layout(location=2) in vec2 a_tw;
uniform mat4 u_vp; uniform vec2 u_res; uniform float u_proj11; uniform float u_width; uniform float u_minPx;
out float v_across; out float v_T; out float v_gain; out float v_y; out float v_along; flat out float v_L; out float v_hw; flat out float v_cap;
void main(){
  int id = gl_VertexID; float side = (id&1)==0 ? -1.0 : 1.0; bool e0 = id<2;
  vec4 c0 = u_vp*vec4(a_p0,1.0), c1 = u_vp*vec4(a_p1,1.0);
  const float near = 2.0;
  if(c0.w<near && c1.w<near){ gl_Position=vec4(2.0,2.0,2.0,1.0); return; }
  if(c0.w<near) c0 = mix(c0,c1,(near-c0.w)/(c1.w-c0.w));
  if(c1.w<near) c1 = mix(c1,c0,(near-c1.w)/(c0.w-c1.w));
  vec2 s0 = c0.xy/c0.w*0.5*u_res, s1 = c1.xy/c1.w*0.5*u_res;
  vec2 d = s1-s0; float L = length(d); vec2 dir = L>1e-4 ? d/L : vec2(1,0); vec2 n = vec2(-dir.y,dir.x);
  vec4 c = e0 ? c0 : c1;
  float cap = a_tw.y < 0.0 ? 1.0 : 0.0;
  float wTrue = u_width*abs(a_tw.y)*u_proj11*0.5*u_res.y/c.w;
  float wpx = max(wTrue, u_minPx);
  v_gain = wTrue/wpx;
  float ext = e0 ? wpx*0.35 : (cap > 0.5 ? wpx*1.2 : wpx*0.35);
  vec2 off = n*side*wpx*0.5 + dir*(e0?-1.0:1.0)*ext;
  v_along = e0 ? -ext : L + ext; v_L = L; v_hw = wpx*0.5; v_cap = cap;
  c.xy += off/(0.5*u_res)*c.w;
  gl_Position = c; v_across = side; v_T = a_tw.x; v_y = e0 ? a_p0.y : a_p1.y;
}`;

const BOLT_FS = `#version 300 es
precision highp float;
in float v_across; in float v_T; in float v_gain; in float v_y; in float v_along; flat in float v_L; in float v_hw; flat in float v_cap; out vec4 o;
uniform sampler2D u_lut; uniform vec2 u_lutRange; uniform float u_gain, u_sharp, u_cb;
void main(){
  float g = exp(-v_across*v_across*u_sharp);
  if(v_cap > 0.5){ float d = max(v_along - v_L, 0.0)/max(v_hw,1e-3); g *= exp(-d*d*u_sharp); }
  float T = v_T;
  vec3 c = texture(u_lut, vec2(clamp((T-u_lutRange.x)/(u_lutRange.y-u_lutRange.x),0.0,1.0),0.5)).rgb;
  float B = pow(T/10000.0, 4.0);                 // Stefan–Boltzmann radiance ∝ T⁴
  float inCloud = v_y>u_cb ? exp(-(v_y-u_cb)/90.0)*0.6+0.04 : 1.0;
  o = vec4(c*B*g*v_gain*u_gain*inCloud, 1.0);
}`;

const RAIN_VS = `#version 300 es
precision highp float;
uniform mat4 u_vp; uniform vec3 u_cam; uniform float u_time; uniform vec2 u_wind;
out float v_a;
float h(float n){ return fract(sin(n)*43758.5453); }
void main(){
  float i = float(gl_InstanceID);
  const float B = 90.0;
  vec3 base = vec3(h(i*1.13)*B, h(i*2.71)*B, h(i*3.97)*B);
  float speed = 9.0 + 2.0*h(i*5.3);
  base.y -= u_time*speed; base.xz += u_wind*u_time*0.35;
  vec3 p = u_cam + mod(base - u_cam + B*0.5, B) - B*0.5;
  vec3 vel = vec3(u_wind.x*0.35, -speed, u_wind.y*0.35);
  if(gl_VertexID==1) p += vel*0.045;
  gl_Position = u_vp*vec4(p,1.0);
  v_a = 0.4+0.6*h(i*7.7);
}`;
const RAIN_FS = `#version 300 es
precision highp float;
in float v_a; out vec4 o; uniform vec3 u_rc;
void main(){ o = vec4(u_rc*v_a,1.0); }`;

const BOX_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_p; layout(location=1) in vec3 a_n;
uniform mat4 u_vp; uniform vec3 u_pos; uniform vec3 u_size;
out vec3 v_n; out vec3 v_w;
void main(){ vec3 w = u_pos + a_p*u_size; v_n=a_n; v_w=w; gl_Position=u_vp*vec4(w,1.0); }`;
const BOX_FS = `#version 300 es
precision highp float;
in vec3 v_n; in vec3 v_w; out vec4 o;
uniform vec4 u_light; uniform vec3 u_lcol; uniform float u_flashK, u_amb, u_top, u_time;
void main(){
  vec3 L = u_light.yzw - v_w; float r2 = dot(L,L);
  vec3 E = u_lcol*u_light.x*u_flashK/(r2+2.5e5)*max(dot(normalize(v_n),normalize(L)),0.0)*2.0;
  vec3 c = vec3(0.05,0.05,0.055)*(E + vec3(0.02,0.025,0.04)*u_amb);
  float stripe = step(0.5, fract(v_w.y/30.0));
  c *= mix(0.6,1.0,stripe);
  // red aviation obstruction light (blinking)
  float beacon = step(u_top-6.0, v_w.y)*step(0.5, fract(u_time*0.75));
  c += vec3(4.0,0.05,0.02)*beacon;
  o = vec4(c,1.0);
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
in vec2 v_uv; out vec4 o; uniform sampler2D u_src; uniform vec2 u_texel; uniform float u_r;
void main(){
  vec2 t=u_texel*u_r; vec2 uv=v_uv;
  vec3 s = texture(u_src,uv).rgb*4.0;
  s += (texture(u_src,uv+vec2(-t.x,0)).rgb + texture(u_src,uv+vec2(t.x,0)).rgb + texture(u_src,uv+vec2(0,-t.y)).rgb + texture(u_src,uv+vec2(0,t.y)).rgb)*2.0;
  s += texture(u_src,uv+vec2(-t.x,-t.y)).rgb + texture(u_src,uv+vec2(t.x,-t.y)).rgb + texture(u_src,uv+vec2(-t.x,t.y)).rgb + texture(u_src,uv+vec2(t.x,t.y)).rgb;
  o = vec4(s/16.0,1.0);
}`;
const COMP_FS = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_hdr, u_bloom; uniform float u_exposure, u_bloomK, u_time;
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }
vec3 srgb(vec3 c){ return mix(c*12.92, 1.055*pow(c,vec3(1.0/2.4))-0.055, step(0.0031308,c)); }
void main(){
  vec3 h = texture(u_hdr,v_uv).rgb;
  vec3 b = texture(u_bloom,v_uv).rgb;
  vec3 c = (h + b*(u_bloomK/6.0))*u_exposure;
  c = aces(c);
  vec2 q = v_uv-0.5; c *= 1.0 - dot(q,q)*0.55;
  c = srgb(c);
  float n = fract(sin(dot(gl_FragCoord.xy+u_time, vec2(12.9898,78.233)))*43758.5453);
  o = vec4(c + (n-0.5)/255.0, 1.0);
}`;

function compile(gl, vs, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src);
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    // some browsers/drivers reject particular context options — try plainer requests too
    let gl = null;
    for (const opt of [{ antialias: false, alpha: false, powerPreference: 'high-performance' }, { antialias: false, alpha: false }, {}]) {
      try { gl = canvas.getContext('webgl2', opt); } catch (e) { gl = null; }
      if (gl) break;
    }
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.floatOK = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    this.fmt = this.floatOK ? { i: gl.RGBA16F, t: gl.HALF_FLOAT } : { i: gl.RGBA8, t: gl.UNSIGNED_BYTE };
    this.env = compile(gl, FS_TRI, ENV_FS);
    this.bolt = compile(gl, BOLT_VS, BOLT_FS);
    this.rain = compile(gl, RAIN_VS, RAIN_FS);
    this.box = compile(gl, BOX_VS, BOX_FS);
    this.down = compile(gl, FS_TRI, DOWN_FS);
    this.up = compile(gl, FS_TRI, UP_FS);
    this.comp = compile(gl, FS_TRI, COMP_FS);
    this.emptyVao = gl.createVertexArray();
    // lightning instance buffer
    this.boltVao = gl.createVertexArray();
    this.boltBuf = gl.createBuffer();
    gl.bindVertexArray(this.boltVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boltBuf);
    gl.bufferData(gl.ARRAY_BUFFER, 4 * 8 * 32768, gl.DYNAMIC_DRAW);
    const st = 32;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, st, 0); gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, st, 12); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, st, 24); gl.vertexAttribDivisor(2, 1);
    // unit box (base at y=0)
    const P = [], f = (n, a, b, c, d) => { for (const v of [a, b, c, a, c, d]) P.push(...v, ...n); };
    const X0 = -0.5, X1 = 0.5, Y0 = 0, Y1 = 1, Z0 = -0.5, Z1 = 0.5;
    f([0, 0, 1], [X0, Y0, Z1], [X1, Y0, Z1], [X1, Y1, Z1], [X0, Y1, Z1]);
    f([0, 0, -1], [X1, Y0, Z0], [X0, Y0, Z0], [X0, Y1, Z0], [X1, Y1, Z0]);
    f([1, 0, 0], [X1, Y0, Z1], [X1, Y0, Z0], [X1, Y1, Z0], [X1, Y1, Z1]);
    f([-1, 0, 0], [X0, Y0, Z0], [X0, Y0, Z1], [X0, Y1, Z1], [X0, Y1, Z0]);
    f([0, 1, 0], [X0, Y1, Z1], [X1, Y1, Z1], [X1, Y1, Z0], [X0, Y1, Z0]);
    this.boxVao = gl.createVertexArray();
    gl.bindVertexArray(this.boxVao);
    const bb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(P), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    this.lutTex = gl.createTexture();
    this.scale = 1;
    this.w = this.h = 0;
  }

  setLUT(data, n, tmin, tmax) {
    const gl = this.gl;
    const rgba = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { rgba[i * 4] = data[i * 3]; rgba[i * 4 + 1] = data[i * 3 + 1]; rgba[i * 4 + 2] = data[i * 3 + 2]; rgba[i * 4 + 3] = 1; }
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, n, 1, 0, gl.RGBA, gl.FLOAT, rgba);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.lutRange = [tmin, tmax];
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
  _fbo(tex, depth) {
    const gl = this.gl, f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (depth) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    return f;
  }

  resize() {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.scale;
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.canvas.width = w; this.canvas.height = h;
    for (const o of this.targets || []) { gl.deleteTexture(o.tex); gl.deleteFramebuffer(o.fbo); }
    if (this.depth) gl.deleteRenderbuffer(this.depth);
    this.depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    const hdr = this._tex(w, h);
    this.targets = [{ tex: hdr, fbo: this._fbo(hdr, this.depth), w, h }];
    let mw = w, mh = h;
    for (let i = 0; i < 7; i++) {
      mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1);
      const t = this._tex(mw, mh);
      this.targets.push({ tex: t, fbo: this._fbo(t), w: mw, h: mh });
    }
  }

  render(s) {
    const gl = this.gl;
    this.resize();
    const { w, h } = this;
    const aspect = w / h;
    const proj = perspective(s.fov, aspect, 1.0, 80000);
    const view = lookAt(s.eye, s.target, [0, 1, 0]);
    const vp = mul(proj, view);
    const invvp = invert(vp);
    const L = s.light;
    const hdr = this.targets[0];

    gl.bindFramebuffer(gl.FRAMEBUFFER, hdr.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.emptyVao);

    // environment
    let p = this.env;
    gl.useProgram(p.p);
    gl.uniformMatrix4fv(p.u.u_invvp, false, invvp);
    gl.uniform3fv(p.u.u_cam, s.eye);
    gl.uniform1f(p.u.u_time, s.time);
    gl.uniform4f(p.u.u_light, L[0], L[1], L[2], L[3]);
    gl.uniform3f(p.u.u_lcol, L[4], L[5], L[6]);
    gl.uniform4fv(p.u.u_gnd, s.ground);
    gl.uniform1f(p.u.u_cb, s.cloudBase);
    gl.uniform1f(p.u.u_ct, s.cloudTop);
    gl.uniform1f(p.u.u_amb, s.ambient);
    gl.uniform1f(p.u.u_flashK, s.flashK);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // tower
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    if (s.tower && s.tower[2] > 0) {
      p = this.box;
      gl.useProgram(p.p);
      gl.bindVertexArray(this.boxVao);
      gl.uniformMatrix4fv(p.u.u_vp, false, vp);
      gl.uniform3f(p.u.u_pos, s.tower[0], 0, s.tower[1]);
      gl.uniform3f(p.u.u_size, 14, s.tower[2], 14);
      gl.uniform4f(p.u.u_light, L[0], L[1], L[2], L[3]);
      gl.uniform3f(p.u.u_lcol, L[4], L[5], L[6]);
      gl.uniform1f(p.u.u_flashK, s.flashK);
      gl.uniform1f(p.u.u_amb, s.ambient);
      gl.uniform1f(p.u.u_top, s.tower[2]);
      gl.uniform1f(p.u.u_time, s.time);
      gl.drawArrays(gl.TRIANGLES, 0, 30);
    }

    // lightning (additive, depth-tested, no depth write)
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    if (s.segCount > 0) {
      gl.bindVertexArray(this.boltVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.boltBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, s.segs, 0, s.segCount * 8);
      p = this.bolt;
      gl.useProgram(p.p);
      gl.uniformMatrix4fv(p.u.u_vp, false, vp);
      gl.uniform2f(p.u.u_res, w, h);
      gl.uniform1f(p.u.u_proj11, proj[5]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.uniform1i(p.u.u_lut, 0);
      gl.uniform2fv(p.u.u_lutRange, this.lutRange);
      gl.uniform1f(p.u.u_cb, s.cloudBase);
      const passes = [
        [s.coreWidth, 1.25, 1.0 * s.boltGain, 2.2],     // hot core
        [s.coreWidth * 9, 3.0, 0.10 * s.boltGain, 2.5], // corona / near glow
        [s.coreWidth * 60, 8.0, 0.012 * s.boltGain, 3.0], // atmospheric scatter halo
      ];
      for (const [wd, mp, g, sh] of passes) {
        gl.uniform1f(p.u.u_width, wd);
        gl.uniform1f(p.u.u_minPx, mp);
        gl.uniform1f(p.u.u_gain, g);
        gl.uniform1f(p.u.u_sharp, sh);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, s.segCount);
      }
    }
    // rain
    if (s.rain > 0) {
      p = this.rain;
      gl.useProgram(p.p);
      gl.bindVertexArray(this.emptyVao);
      gl.uniformMatrix4fv(p.u.u_vp, false, vp);
      gl.uniform3fv(p.u.u_cam, s.eye);
      gl.uniform1f(p.u.u_time, s.time);
      gl.uniform2f(p.u.u_wind, 3.0, 1.2);
      const fl = Math.min(L[0] * s.flashK / 4.0e7, 40.0);
      gl.uniform3f(p.u.u_rc, 0.02 + fl * L[4] * 0.05, 0.022 + fl * L[5] * 0.05, 0.03 + fl * L[6] * 0.05);
      gl.drawArraysInstanced(gl.LINES, 0, 2, Math.floor(9000 * s.rain));
    }
    gl.depthMask(true);
    gl.disable(gl.DEPTH_TEST);

    // bloom: downsample chain then additive tent upsample
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.emptyVao);
    gl.useProgram(this.down.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.down.u.u_src, 0);
    for (let i = 1; i < this.targets.length; i++) {
      const src = this.targets[i - 1], dst = this.targets[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, dst.w, dst.h);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform2f(this.down.u.u_texel, 1 / src.w, 1 / src.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.useProgram(this.up.p);
    gl.uniform1i(this.up.u.u_src, 0);
    gl.uniform1f(this.up.u.u_r, s.bloomRadius);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = this.targets.length - 1; i > 1; i--) {
      const src = this.targets[i], dst = this.targets[i - 1];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, dst.w, dst.h);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform2f(this.up.u.u_texel, 1 / src.w, 1 / src.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);

    // composite to screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    p = this.comp;
    gl.useProgram(p.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, hdr.tex);
    gl.uniform1i(p.u.u_hdr, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.targets[1].tex);
    gl.uniform1i(p.u.u_bloom, 1);
    gl.uniform1f(p.u.u_exposure, s.exposure);
    gl.uniform1f(p.u.u_bloomK, s.bloom);
    gl.uniform1f(p.u.u_time, s.time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    return { vp, proj, view };
  }
}
