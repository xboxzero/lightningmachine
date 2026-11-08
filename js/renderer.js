// WebGL2 HDR renderer for the glass lightning chamber (smooth or ASCII output).
//
//  * Off-axis ("window") projection (Kooima's generalised perspective): the front glass of
//    the chamber is mapped exactly onto the screen for any eye position → the screen is
//    the glass, the scene sits behind it with correct parallax.
//  * Chamber: ray-traced inner walls (glass tint, edges, light from discharges and lava).
//  * Lava blobs: sphere impostors glowing with black-body colour.
//  * Lightning: instanced channel segments with a Gaussian cross-section, plus their mirror
//    images in the five walls (method of images), weighted by the Fresnel reflectance of
//    glass (Schlick, n = 1.5) and clipped to the wall where the reflected ray really lands.
//  * Dual-filter bloom, ACES tone mapping.

const FS_TRI = `#version 300 es
out vec2 v_uv;
void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); v_uv=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;

const ARC_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_p0; layout(location=1) in vec3 a_p1; layout(location=2) in vec2 a_tw; layout(location=3) in float a_gas;
uniform mat4 u_vp; uniform mat4 u_model; uniform vec2 u_res; uniform float u_pxPerM; uniform float u_width; uniform float u_minPx;
uniform vec3 u_eye;
uniform sampler2D u_lut; uniform vec2 u_lutRange; uniform float u_mist; uniform float u_rows;
out float v_gas;
out float v_across; out float v_T; out float v_gain; out float v_along; flat out float v_L; flat out float v_hw; flat out float v_cap; out vec3 v_world;
void main(){
  int id = gl_VertexID; float side = (id&1)==0 ? -1.0 : 1.0; bool e0 = id<2;
  vec3 w0 = (u_model*vec4(a_p0,1.0)).xyz, w1 = (u_model*vec4(a_p1,1.0)).xyz;
  vec4 c0 = u_vp*vec4(w0,1.0), c1 = u_vp*vec4(w1,1.0);
  const float near = 5.0;
  if(c0.w<near && c1.w<near){ gl_Position=vec4(2.0,2.0,2.0,1.0); return; }
  if(c0.w<near) c0 = mix(c0,c1,(near-c0.w)/(c1.w-c0.w));
  if(c1.w<near) c1 = mix(c1,c0,(near-c1.w)/(c0.w-c1.w));
  vec2 s0 = c0.xy/c0.w*0.5*u_res, s1 = c1.xy/c1.w*0.5*u_res;
  vec2 d = s1-s0; float L = length(d); vec2 dir = L>1e-4 ? d/L : vec2(1,0); vec2 n = vec2(-dir.y,dir.x);
  vec4 c = e0 ? c0 : c1;
  float cap = a_tw.y < 0.0 ? 1.0 : 0.0;
  // cooling channels expand and diffuse into mist (same total light, wider and softer)
  v_gas = (a_gas + 0.5)/u_rows;
  float B = textureLod(u_lut, vec2(clamp((a_tw.x-u_lutRange.x)/(u_lutRange.y-u_lutRange.x),0.0,1.0),v_gas), 0.0).a;
  float spread = 1.0 + u_mist*3.0*clamp(1.0 - B, 0.0, 1.0);
  float wTrue = u_width*abs(a_tw.y)*u_pxPerM/c.w*spread;     // metres → pixels at this depth
  float wpx = max(wTrue, u_minPx);
  v_gain = wTrue/wpx/spread;
  float ext = (!e0 && cap > 0.5) ? wpx*1.2 : 0.0;
  vec2 off = n*side*wpx*0.5 + dir*(e0 ? 0.0 : ext);
  c.xy += off/(0.5*u_res)*c.w;
  gl_Position = c;
  v_across = side; v_T = a_tw.x; v_along = e0 ? 0.0 : L+ext; v_L = L; v_hw = wpx*0.5; v_cap = cap;
  v_world = e0 ? w0 : w1;
}`;
const ARC_FS = `#version 300 es
precision highp float;
in float v_across; in float v_T; in float v_gain; in float v_along; flat in float v_L; flat in float v_hw; flat in float v_cap; in vec3 v_world; in float v_gas;
out vec4 o;
uniform sampler2D u_lut; uniform vec2 u_lutRange; uniform float u_gain, u_sharp;
uniform vec3 u_eye; uniform vec3 u_half;
uniform vec4 u_plane;    // mirror plane n·x = d (n = 0 → direct view)
uniform vec2 u_depth;    // near, far distance for the depth channel
uniform float u_reflect; // reflectance multiplier (1 = clean glass)
void main(){
  float R = 1.0;
  if(dot(u_plane.xyz,u_plane.xyz) > 0.0){
    // where does the eye→virtual-image ray cross the wall? keep only hits on the wall itself
    vec3 dir = v_world - u_eye;
    float den = dot(u_plane.xyz, dir);
    float t = (u_plane.w - dot(u_plane.xyz, u_eye)) / den;
    vec3 hit = u_eye + dir*t;
    vec3 a = abs(hit) - u_half*1.001;
    vec3 m = vec3(1.0) - abs(u_plane.xyz);
    if(t <= 0.0 || t >= 1.0 || max(max(a.x*m.x, a.y*m.y), a.z*m.z) > 0.0) discard;
    // Fresnel reflectance of glass (Schlick): R0 = ((n−1)/(n+1))² = 0.04
    float c = abs(dot(normalize(dir), u_plane.xyz));
    R = (0.04 + 0.96*pow(1.0 - c, 5.0)) * u_reflect;
  }
  vec4 lut = texture(u_lut, vec2(clamp((v_T-u_lutRange.x)/(u_lutRange.y-u_lutRange.x),0.0,1.0),v_gas));
  float dEnd = v_cap > 0.5 ? max(v_along - v_L, 0.0)/max(v_hw,1e-3) : 0.0;
  float g = exp(-v_across*v_across*u_sharp) * exp(-dEnd*dEnd*u_sharp);
  vec3 rgb = lut.rgb*lut.a*g*v_gain*u_gain*R;
  // alpha accumulates luminance × depth (additively) → per-pixel weighted depth for 3-D ASCII
  float d = clamp((length(v_world - u_eye) - u_depth.x) / (u_depth.y - u_depth.x), 0.0, 1.0);
  o = vec4(rgb, dot(rgb, vec3(0.2126,0.7152,0.0722)) * d);
}`;

const CHAMBER_FS = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform vec3 u_eye; uniform vec3 u_half; uniform float u_time; uniform vec2 u_depth;
uniform vec4 u_light; uniform vec3 u_lcol;     // discharge: xyz centroid, w strength
float hash(vec3 p){ p=fract(p*0.1031); p+=dot(p,p.zyx+31.32); return fract((p.x+p.y)*p.z); }
float vnoise(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z); }
vec3 lightAt(vec3 p, vec3 n){
  vec3 L = u_light.xyz - p; float r2 = dot(L,L);
  vec3 e = u_lcol*u_light.w*max(dot(normalize(L),n),0.0)*6.0e5/(r2+4.0e4);
  return e;
}
void main(){
  // point on the front glass (the screen) and the view ray through it
  vec3 P = vec3(mix(-u_half.x,u_half.x,v_uv.x), mix(-u_half.y,u_half.y,v_uv.y), u_half.z);
  vec3 d = normalize(P - u_eye);
  // exit point through the inner walls of the box
  vec3 tq = (sign(d)*u_half - P)/d;
  float t = min(min(d.x!=0.0?tq.x:1e9, d.y!=0.0?tq.y:1e9), d.z!=0.0?tq.z:1e9);
  vec3 H = P + d*t;
  vec3 n; vec2 uv;
  vec3 ah = abs(H)/u_half;
  if(t == tq.x){ n = vec3(-sign(d.x),0,0); uv = H.zy; }
  else if(t == tq.y){ n = vec3(0,-sign(d.y),0); uv = H.xz; }
  else { n = vec3(0,0,1); uv = H.xy; }
  // glass wall: very dark tint with one slow noise layer, lit by the lightning
  float haze = vnoise(vec3(uv*0.0012, u_time*0.03));
  vec3 base = mix(vec3(0.002,0.002,0.005), vec3(0.007,0.004,0.011), haze);
  vec3 E = lightAt(H, n);
  vec3 col = base + E*(0.008 + 0.015*haze);
  // edges of the chamber (where two walls meet): thin glass edges catching light
  vec3 qq = (vec3(1.0) - ah) * u_half;   // distance to each wall (m)
  float de = min(min(max(qq.x,qq.y), max(qq.y,qq.z)), max(qq.x,qq.z));
  float edge = exp(-de/6.0);
  col += (vec3(0.025,0.03,0.04) + E*0.08) * edge;
  // volumetric glow of the air between the glass and the wall (single scattering, crude)
  vec3 mid = P + d*t*0.5;
  col += lightAt(mid, normalize(u_light.xyz - mid))*0.0015*t/1000.0;
  // front glass: faint Fresnel sheen + reflection streak
  float cosv = abs(d.z);
  float Rf = 0.04 + 0.96*pow(1.0 - cosv, 5.0);
  float streak = smoothstep(0.35, 0.0, abs((v_uv.x - v_uv.y*0.6) - 0.25 - 0.05*sin(u_time*0.1)))*0.012;
  col += vec3(0.6,0.65,0.8)*(Rf*0.04 + streak);
  float dw = clamp((length(H - u_eye) - u_depth.x) / (u_depth.y - u_depth.x), 0.0, 1.0);
  o = vec4(col, dot(col, vec3(0.2126,0.7152,0.0722)) * dw);
}`;

const BLOB_VS = `#version 300 es
precision highp float;
uniform mat4 u_vp; uniform vec4 u_blob; uniform vec3 u_right; uniform vec3 u_up; uniform float u_scale;
out vec2 v_q;
void main(){
  vec2 q = vec2(float(gl_VertexID&1), float((gl_VertexID>>1)&1))*2.0-1.0;
  v_q = q*u_scale;
  vec3 p = u_blob.xyz + (u_right*q.x + u_up*q.y)*u_blob.w*u_scale;
  gl_Position = u_vp*vec4(p,1.0);
}`;
const BLOB_FS = `#version 300 es
precision highp float;
in vec2 v_q; out vec4 o; uniform vec4 u_col; uniform float u_time; uniform float u_seed;
float hash(vec3 p){ p=fract(p*0.1031); p+=dot(p,p.zyx+31.32); return fract((p.x+p.y)*p.z); }
float vnoise(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z); }
void main(){
  float r = length(v_q);
  vec3 c = u_col.rgb*u_col.a;
  vec3 col = vec3(0);
  if(r < 1.0){
    float nz = sqrt(1.0 - r*r);
    vec3 nrm = vec3(v_q, nz);
    // molten surface: convecting noise on the sphere, hotter (brighter) cells and darker crust
    vec3 sp = nrm*2.3 + vec3(u_seed, u_seed*0.7, u_time*0.12);
    float cell = vnoise(sp) * 0.65 + vnoise(sp*2.7 + 3.1) * 0.35;
    float heat = mix(0.55, 1.25, smoothstep(0.25, 0.8, cell));
    // limb darkening of an emitting sphere, plus a soft Fresnel rim from the fluid
    col = c * heat * (0.35 + 0.65*pow(nz, 0.7));
    col += c * pow(1.0 - nz, 3.0) * 0.4;
    col *= smoothstep(1.0, 0.95, r);
  }
  col += c*exp(-max(r-0.85,0.0)*3.0)*0.12*step(0.95, r);   // glow scattered by the fluid
  o = vec4(col, 1.0);
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
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }
vec3 srgb(vec3 c){ return mix(c*12.92, 1.055*pow(c,vec3(1.0/2.4))-0.055, step(0.0031308,c)); }
void main(){
  vec4 hd = texture(u_hdr,v_uv);
  vec3 c = srgb(aces(hd.rgb + texture(u_bloom,v_uv).rgb*(u_bloomK/6.0)));
  vec2 q = v_uv - 0.5; c *= 1.0 - dot(q,q)*0.35;
  float n = fract(sin(dot(gl_FragCoord.xy+u_time, vec2(12.9898,78.233)))*43758.5453);
  // depth (luminance-weighted) premultiplied by display luminance, so mip averages stay exact
  float depth = clamp(hd.a / max(dot(hd.rgb, vec3(0.2126,0.7152,0.0722)), 1e-5), 0.0, 1.0);
  c += (n-0.5)/255.0;
  o = vec4(c, dot(c, vec3(0.2126,0.7152,0.0722)) * depth);
}`;

const ASCII_FS = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_scene, u_glyphs, u_glow;
uniform float u_focus, u_dof;
uniform vec2 u_res, u_cell, u_vanish; uniform float u_lod, u_glyphLod, u_nglyph, u_ramp, u_edge, u_glowK, u_time;
float lum(vec2 uv){ return dot(textureLod(u_scene, uv, u_lod).rgb, vec3(0.2126,0.7152,0.0722)); }
float g_lodBias = 0.0;
float glyphA(float gi, vec2 l){
  if (l.x < 0.0 || l.y < 0.0 || l.x > 1.0 || l.y > 1.0) return 0.0;
  return textureLod(u_glyphs, vec2((gi + l.x) / u_nglyph, 1.0 - l.y), u_glyphLod + g_lodBias).r;
}
void main(){
  vec2 frag = gl_FragCoord.xy;
  vec2 id = floor(frag / u_cell);
  vec2 cs = u_cell / u_res;
  vec2 cc = (id + 0.5) * cs;                       // cell centre (uv)
  // Gaussian-weighted cell sample (3×3 taps over the mip level, σ ≈ 0.6 cell)
  vec4 acc = vec4(0.0); float wsum = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    float wgt = exp(-float(i*i + j*j) / (2.0 * 0.6 * 0.6));
    acc += textureLod(u_scene, cc + cs * vec2(float(i), float(j)) * 0.5, u_lod) * wgt;
    wsum += wgt;
  }
  acc /= wsum;
  vec3 col = acc.rgb;
  float L = dot(col, vec3(0.2126,0.7152,0.0722));
  // Sobel gradient of the cell-averaged luminance → edge strength and orientation
  float tl = lum(cc + cs*vec2(-1, 1)), tc = lum(cc + cs*vec2(0, 1)), tr = lum(cc + cs*vec2(1, 1));
  float ml = lum(cc + cs*vec2(-1, 0)),                                  mr = lum(cc + cs*vec2(1, 0));
  float bl = lum(cc + cs*vec2(-1,-1)), bc = lum(cc + cs*vec2(0,-1)), br = lum(cc + cs*vec2(1,-1));
  vec2 g = vec2((tr + 2.0*mr + br) - (tl + 2.0*ml + bl), (tl + 2.0*tc + tr) - (bl + 2.0*bc + br));
  float mag = length(g);
  float glyph;
  // thin channels cover only part of a cell: perceptual boost (Stevens-like exponent)
  float Lb = pow(L, 0.55);
  if (mag > u_edge && L > 0.06) {
    // edge orientation ⟂ gradient, quantised to 4 directions (dash, slash, bar, backslash)
    float e = atan(g.y, g.x) + 1.5707963;
    float k = floor(mod(e + 0.3926991, 3.1415927) / 0.7853982);
    glyph = u_ramp + k;
  } else {
    glyph = L < 0.045 ? 0.0 : floor(clamp(Lb * 1.1, 0.0, 0.999) * u_ramp);
  }
  // ---- 3-D: depth of the light in this cell (0 near … 1 far)
  float d = clamp(acc.a / max(L, 1e-4), 0.0, 1.0);
  // Gaussian depth of field around a drifting focal depth
  float blur = u_dof > 0.0 ? 1.0 - exp(-(d - u_focus) * (d - u_focus) / (2.0 * u_dof * u_dof)) : 0.0;
  float scale = mix(1.18, 0.5, d);                  // perspective: near glyphs big, far glyphs small
  vec2 local = fract(frag / u_cell);
  vec2 lf = (local - 0.5) / scale + 0.5;           // glyph front face
  // extrusion toward the vanishing point of the current viewpoint (solid block letters)
  vec2 dirPx = u_vanish - frag;
  vec2 dir = dirPx / max(length(dirPx), 1.0);
  float depthLen = mix(0.34, 0.08, d);              // nearer letters show a longer side
  vec2 stepL = dir * vec2(u_cell.y / u_cell.x, 1.0) * depthLen / 4.0;
  g_lodBias = blur * 2.6;                            // defocused glyphs sample a blurrier mip
  float front = glyphA(glyph, lf) * (1.0 - 0.35 * blur);
  float side = 0.0, shade = 0.0;
  for (int k = 1; k <= 4; k++) {
    float sa = glyphA(glyph, lf - stepL * float(k) / scale);
    if (sa > side) { side = sa; shade = float(k) / 4.0; }
  }
  // glyph colour: spectral hue, whitening as it saturates; depth haze dims and cools far glyphs
  float m = max(max(col.r, col.g), max(col.b, 1e-4));
  vec3 hue = col / m;
  vec3 gc = mix(hue, vec3(1.0), smoothstep(0.45, 0.9, Lb) * 0.7) * (0.35 + 1.4 * Lb);
  gc *= mix(1.2, 0.55, d);
  gc = mix(gc, gc * vec3(0.75, 0.85, 1.1), d * 0.5);
  vec3 sideCol = gc * (0.42 - 0.3 * shade);          // darker extruded flanks
  vec3 glyphRGB = mix(sideCol * side, gc, front);
  vec3 glow = (1.0 - exp(-texture(u_glow, v_uv).rgb * 0.6)) * u_glowK;
  o = vec4(glyphRGB + glow, 1.0);
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
    u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** Reflection across the plane axis = ±half (column-major). */
function mirror(axis, d) {
  const m = new Float32Array(IDENT);
  m[axis * 5] = -1;
  m[12 + axis] = 2 * d;
  return m;
}

/**
 * Off-axis projection with the front glass (z = half.z, |x| ≤ hx, |y| ≤ hy) as the screen
 * (Kooima's generalised perspective). view = translate(−eye), proj = frustum(l, r, b, t).
 * Returns the view-projection matrix and pixels-per-metre at depth w = 1.
 */
export function windowCamera(eye, half, heightPx) {
  const n = 5, f = 60000;
  const dist = eye[2] - half[2];
  const k = n / dist;
  const l = (-half[0] - eye[0]) * k, r = (half[0] - eye[0]) * k;
  const b = (-half[1] - eye[1]) * k, t = (half[1] - eye[1]) * k;
  const P = new Float32Array(16);
  P[0] = 2 * n / (r - l); P[5] = 2 * n / (t - b);
  P[8] = (r + l) / (r - l); P[9] = (t + b) / (t - b); P[10] = -(f + n) / (f - n); P[11] = -1;
  P[14] = -2 * f * n / (f - n);
  const vp = new Float32Array(P);
  for (let r2 = 0; r2 < 4; r2++) vp[12 + r2] = P[r2] * -eye[0] + P[4 + r2] * -eye[1] + P[8 + r2] * -eye[2] + P[12 + r2];
  return { vp, pxPerM: heightPx / (half[1] * 2) * dist };
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    // Some browsers/drivers reject particular context options (desynchronized, power
    // preference) — try progressively plainer requests before giving up.
    const attempts = [
      { antialias: false, alpha: false, desynchronized: true, powerPreference: 'high-performance' },
      { antialias: false, alpha: false, powerPreference: 'high-performance' },
      { antialias: false, alpha: false },
      {},
    ];
    let gl = null;
    for (const opt of attempts) {
      try { gl = canvas.getContext('webgl2', opt); } catch (e) { gl = null; }
      if (gl) break;
    }
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    const floatOK = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    this.fmt = floatOK ? { i: gl.RGBA16F, t: gl.HALF_FLOAT } : { i: gl.RGBA8, t: gl.UNSIGNED_BYTE };
    this.arc = compile(gl, ARC_VS, ARC_FS);
    this.chamber = compile(gl, FS_TRI, CHAMBER_FS);
    this.blob = compile(gl, BLOB_VS, BLOB_FS);
    this.down = compile(gl, FS_TRI, DOWN_FS);
    this.up = compile(gl, FS_TRI, UP_FS);
    this.comp = compile(gl, FS_TRI, COMP_FS);
    this.ascii = compile(gl, FS_TRI, ASCII_FS);
    this._buildGlyphs();
    this.emptyVao = gl.createVertexArray();
    this.arcVao = gl.createVertexArray();
    this.arcBuf = gl.createBuffer();
    gl.bindVertexArray(this.arcVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.arcBuf);
    gl.bufferData(gl.ARRAY_BUFFER, 4 * 9 * 60000, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 36, 0); gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 36, 12); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 36, 24); gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 36, 32); gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
    this.lutTex = gl.createTexture();
    this.scale = 1; this.w = this.h = 0;
  }

  /** data: rows × n × [r,g,b,brightness] (one row per gas) */
  setLUT(data, n, rows, tmin, tmax) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, n, rows, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.lutRange = [tmin, tmax];
    this.lut = { data, n, rows, tmin, tmax };
  }
  setBlackbody(data, n, tmin, tmax) { this.bb = { data, n, tmin, tmax }; }
  /** Colour-table lookup; `row` may be fractional (blends adjacent gases). */
  static sample(t, T, row = 0) {
    const i = Math.round(Math.min(1, Math.max(0, (T - t.tmin) / (t.tmax - t.tmin))) * (t.n - 1));
    const r0 = Math.floor(row), f = row - r0, rows = t.rows || 1;
    const a = (Math.min(rows - 1, r0) * t.n + i) * 4, b = (Math.min(rows - 1, r0 + 1) * t.n + i) * 4;
    return [0, 1, 2, 3].map((k) => t.data[a + k] * (1 - f) + t.data[b + k] * f);
  }

  /** Glyph atlas: brightness ramp + 4 edge glyphs, rendered from a monospace font. */
  _buildGlyphs() {
    const gl = this.gl;
    this.glyphRamp = ' .`:,-~=+*ox%O#@';
    const chars = this.glyphRamp + '-/|\\';
    const cw = 32, ch = 48;
    const cv = document.createElement('canvas');
    cv.width = cw * chars.length; cv.height = ch;
    const g = cv.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `bold ${Math.round(ch * 0.82)}px ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace`;
    for (let i = 0; i < chars.length; i++) g.fillText(chars[i], i * cw + cw / 2, ch * 0.54);
    this.glyphTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.glyphTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.glyphCount = chars.length;
    this.glyphCell = [cw, ch];
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

  resize() {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5) * this.scale;
    this.dprUsed = dpr;
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
    if (w !== this.w || h !== this.h) {
      this.w = w; this.h = h;
      this.canvas.width = w; this.canvas.height = h;
      for (const o of this.targets || []) { gl.deleteTexture(o.tex); gl.deleteFramebuffer(o.fbo); }
      this.targets = [];
      let mw = w, mh = h;
      for (let i = 0; i < 6; i++) {
        const tex = this._tex(mw, mh), fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        this.targets.push({ tex, fbo, w: mw, h: mh });
        mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1);
      }
      // tone-mapped scene for the ASCII pass (mipmapped → per-cell averages)
      if (this.ldr) { gl.deleteTexture(this.ldr.tex); gl.deleteFramebuffer(this.ldr.fbo); }
      const lt = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, lt);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const lf = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, lf);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, lt, 0);
      this.ldr = { tex: lt, fbo: lf };
    }
    return [w, h];
  }

  /**
   * Off-axis projection with the front glass (z = half.z, |x| ≤ hx, |y| ≤ hy) as the screen.
   * view = translate(−eye) (the screen is axis-aligned), proj = frustum(l, r, b, t).
   */
  windowCamera(eye, half) { return windowCamera(eye, half, this.h); }

  render(s) {
    const gl = this.gl, { w, h } = this, hdr = this.targets[0];
    const { vp, pxPerM } = s.cam;
    gl.bindFramebuffer(gl.FRAMEBUFFER, hdr.fbo);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.emptyVao);

    // 1) glass chamber
    let p = this.chamber;
    gl.useProgram(p.p);
    gl.uniform3fv(p.u.u_eye, s.eye);
    gl.uniform3fv(p.u.u_half, s.half);
    gl.uniform1f(p.u.u_time, s.time);
    const dNear = s.eye[2] - s.half[2], dFar = s.eye[2] + s.half[2] * 2.2;
    gl.uniform2f(p.u.u_depth, dNear, dFar);
    gl.uniform4fv(p.u.u_light, s.light);
    gl.uniform3fv(p.u.u_lcol, s.lightColor);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    // 2) lava blobs
    p = this.blob;
    gl.useProgram(p.p);
    gl.uniformMatrix4fv(p.u.u_vp, false, vp);
    gl.uniform3f(p.u.u_right, 1, 0, 0);
    gl.uniform3f(p.u.u_up, 0, 1, 0);
    gl.uniform1f(p.u.u_scale, 1.6);
    gl.uniform1f(p.u.u_time, s.time);
    for (let i = 0; i < s.nBlobs; i++) {
      gl.uniform4f(p.u.u_blob, s.blobPos[i * 4], s.blobPos[i * 4 + 1], s.blobPos[i * 4 + 2], s.blobPos[i * 4 + 3]);
      gl.uniform4f(p.u.u_col, s.blobCol[i * 4], s.blobCol[i * 4 + 1], s.blobCol[i * 4 + 2], s.blobCol[i * 4 + 3] * s.lava);
      gl.uniform1f(p.u.u_seed, i * 1.7);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // 3) lightning + its reflections in the five glass walls
    if (s.segCount > 0) {
      gl.bindVertexArray(this.arcVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.arcBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, s.segs, 0, s.segCount * 9);
      p = this.arc;
      gl.useProgram(p.p);
      gl.uniformMatrix4fv(p.u.u_vp, false, vp);
      gl.uniform2f(p.u.u_res, w, h);
      gl.uniform1f(p.u.u_pxPerM, pxPerM);
      gl.uniform3fv(p.u.u_eye, s.eye);
      gl.uniform3fv(p.u.u_half, s.half);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.uniform1i(p.u.u_lut, 0);
      gl.uniform2fv(p.u.u_lutRange, this.lutRange);
      const H = s.half;
      const views = [[IDENT, [0, 0, 0, 0]]];
      if (s.reflect > 0 && s.reflections !== false) {
        views.push([mirror(0, H[0]), [1, 0, 0, H[0]]], [mirror(0, -H[0]), [-1, 0, 0, H[0]]],
          [mirror(1, H[1]), [0, 1, 0, H[1]]], [mirror(1, -H[1]), [0, -1, 0, H[1]]], [mirror(2, -H[2]), [0, 0, -1, H[2]]]);
      }
      const k = s.thickness;
      gl.uniform1f(p.u.u_mist, s.mist);
      gl.uniform1f(p.u.u_rows, this.lut.rows);
      gl.uniform2f(p.u.u_depth, s.eye[2] - s.half[2], s.eye[2] + s.half[2] * 2.2);
      for (const [model, plane] of views) {
        gl.uniformMatrix4fv(p.u.u_model, false, model);
        gl.uniform4fv(p.u.u_plane, plane);
        gl.uniform1f(p.u.u_reflect, s.reflect);
        const direct = plane[0] === 0 && plane[1] === 0 && plane[2] === 0;
        const passes = direct ? [[5 * k, 1.5, 1.3, 2.2], [32 * k, 4.0, 0.08, 2.5]] : [[12 * k, 2.5, 0.5, 2.3]];
        for (const [wd, mp, g, sh] of passes) {
          gl.uniform1f(p.u.u_width, wd); gl.uniform1f(p.u.u_minPx, mp);
          gl.uniform1f(p.u.u_gain, g * s.gain); gl.uniform1f(p.u.u_sharp, sh);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, s.segCount);
        }
      }
    }

    // 4) bloom
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.emptyVao);
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
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.ascii ? this.ldr.fbo : null);
    gl.viewport(0, 0, w, h);
    const c = this.comp;
    gl.useProgram(c.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, hdr.tex); gl.uniform1i(c.u.u_hdr, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.targets[1].tex); gl.uniform1i(c.u.u_bloom, 1);
    gl.uniform1f(c.u.u_bloomK, s.bloom);
    gl.uniform1f(c.u.u_time, s.time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (s.ascii) {
      // ASCII engine: per-cell average colour + Sobel edges → glyphs
      gl.bindTexture(gl.TEXTURE_2D, this.ldr.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      const a = this.ascii;
      gl.useProgram(a.p);
      const cellW = Math.max(4, Math.round(s.glyphSize * (this.dprUsed || 1)));
      const cellH = Math.round(cellW * 1.5);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.ldr.tex); gl.uniform1i(a.u.u_scene, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.glyphTex); gl.uniform1i(a.u.u_glyphs, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.targets[2].tex); gl.uniform1i(a.u.u_glow, 2);
      gl.uniform2f(a.u.u_res, w, h);
      gl.uniform2f(a.u.u_cell, cellW, cellH);
      gl.uniform1f(a.u.u_lod, Math.log2(Math.max(cellW, cellH)) - 0.5);
      gl.uniform1f(a.u.u_glyphLod, Math.max(0, Math.log2(this.glyphCell[0] / cellW)));
      gl.uniform1f(a.u.u_nglyph, this.glyphCount);
      gl.uniform1f(a.u.u_ramp, this.glyphRamp.length);
      gl.uniform1f(a.u.u_edge, 0.14);
      gl.uniform1f(a.u.u_glowK, s.asciiGlow);
      gl.uniform1f(a.u.u_time, s.time);
      // vanishing point of the chamber's depth axis on screen (where the eye's −z ray meets the glass)
      gl.uniform1f(a.u.u_focus, s.focus);
      gl.uniform1f(a.u.u_dof, s.dof);
      gl.uniform2f(a.u.u_vanish, (s.eye[0] / s.half[0] * 0.5 + 0.5) * w, (s.eye[1] / s.half[1] * 0.5 + 0.5) * h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.activeTexture(gl.TEXTURE0);
  }
}
