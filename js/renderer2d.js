// Canvas 2D fallback renderer — used when WebGL2 is unavailable (hardware acceleration off,
// blocked GPU/driver, old browsers). Same simulation and colour science, simpler drawing:
// projected channel segments with additive ("lighter") glow layers, chamber edges, and
// Fresnel-weighted wall reflections clipped to each wall.
import { windowCamera } from './renderer.js';

const sample = (t, T) => {
  const i = Math.round(Math.min(1, Math.max(0, (T - t.tmin) / (t.tmax - t.tmin))) * (t.n - 1));
  return [t.data[i * 4], t.data[i * 4 + 1], t.data[i * 4 + 2], t.data[i * 4 + 3]];
};
const enc = (v) => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)));
const BUCKETS = 48;

export class Renderer2D {
  constructor(canvas) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }) || canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D canvas available.');
    this.ctx = ctx;
    this.fallback = true;
    this.scale = 1; this.w = this.h = 0;
    this.paths = [];
    this.sprites = this._smokeSprites();
    this.tints = new Map();
  }

  /** Wispy smoke sprites: Gaussian blob × fractal noise (a few variants). */
  _smokeSprites() {
    const out = [], S = 128;
    const hash = (x, y, k) => { const v = Math.sin(x * 127.1 + y * 311.7 + k * 74.7) * 43758.5453; return v - Math.floor(v); };
    const noise = (x, y, k) => {
      const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      const a = hash(xi, yi, k), b = hash(xi + 1, yi, k), c = hash(xi, yi + 1, k), d = hash(xi + 1, yi + 1, k);
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    };
    for (let k = 0; k < 6; k++) {
      const cv = document.createElement('canvas'); cv.width = cv.height = S;
      const g = cv.getContext('2d'), img = g.createImageData(S, S);
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          const dx = (x - S / 2) / (S / 2), dy = (y - S / 2) / (S / 2), r2 = dx * dx + dy * dy;
          let n = 0, a = 0.5, f = 3;
          for (let o = 0; o < 4; o++) { n += a * noise(x / S * f, y / S * f, k * 13 + o); f *= 2.1; a *= 0.5; }
          const d = Math.exp(-r2 * 3.2) * Math.max(0, Math.min(1, (n - 0.25) * 2.2));
          const i = (y * S + x) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
          img.data[i + 3] = Math.round(255 * d);
        }
      g.putImageData(img, 0, 0);
      out.push(cv);
    }
    return out;
  }

  _tinted(k, r, g, b) {
    const key = `${k}|${r}|${g}|${b}`;
    let cv = this.tints.get(key);
    if (cv) return cv;
    if (this.tints.size > 300) this.tints.clear();
    const src = this.sprites[k];
    cv = document.createElement('canvas'); cv.width = src.width; cv.height = src.height;
    const c = cv.getContext('2d');
    c.drawImage(src, 0, 0);
    c.globalCompositeOperation = 'source-in';
    c.fillStyle = `rgb(${r},${g},${b})`;
    c.fillRect(0, 0, cv.width, cv.height);
    this.tints.set(key, cv);
    return cv;
  }

  /** Smoke and cloud puffs, back to front: dark absorbing body + light from the discharge. */
  _puffs(s) {
    if (!s.puffCount) return;
    const ctx = this.ctx, { vp, pxPerM } = s.cam, P = s.puffs;
    const list = [];
    for (let i = 0; i < s.puffCount; i++) {
      const o = i * 8;
      if (P[o + 4] < 0.004) continue;
      const pr = this._proj(vp, P[o], P[o + 1], P[o + 2]);
      if (!pr) continue;
      list.push([pr[2], pr[0], pr[1], o]);
    }
    list.sort((a, b) => b[0] - a[0]);
    const L = s.light, lc = s.lightColor;
    const lr = enc(lc[0]) >> 4 << 4, lg = enc(lc[1]) >> 4 << 4, lb = enc(lc[2]) >> 4 << 4;
    for (const [depth, x, y, o] of list) {
      const r = P[o + 3], dens = P[o + 4] * s.smoke, rot = P[o + 5], cloud = P[o + 6] > 0.5, k = Math.floor(P[o + 7] * 6) % 6;
      const size = r * 2.4 * pxPerM / depth;
      if (size < 2) continue;
      // illumination by the discharge: inverse-square-like falloff from the light centroid
      const dx = P[o] - L[0], dy = P[o + 1] - L[1], dz = P[o + 2] - L[2];
      const ill = L[3] * 2.2e5 / (dx * dx + dy * dy + dz * dz + 2.5e5);
      const c = Math.cos(rot), sn = Math.sin(rot);
      ctx.setTransform(c, sn, -sn, c, x, y);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = Math.min(0.9, dens * (cloud ? 0.9 : 0.75));
      ctx.drawImage(this._tinted(k, cloud ? 34 : 26, cloud ? 36 : 28, cloud ? 44 : 34), -size / 2, -size / 2, size, size);
      const lit = Math.min(1, dens * (0.06 + ill) * 1.6);
      if (lit > 0.01) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = lit;
        ctx.drawImage(this._tinted(k, lr, lg, lb), -size / 2, -size / 2, size, size);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  setLUT(data, n, tmin, tmax) { this.lut = { data, n, tmin, tmax }; }
  setBlackbody(data, n, tmin, tmax) { this.bb = { data, n, tmin, tmax }; }
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1) * this.scale;
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
    if (w !== this.w || h !== this.h) { this.w = w; this.h = h; this.canvas.width = w; this.canvas.height = h; }
    return [w, h];
  }
  windowCamera(eye, half) { return windowCamera(eye, half, this.h); }

  _proj(vp, x, y, z) {
    const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    if (cw < 5) return null;
    const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
    const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
    return [(cx / cw * 0.5 + 0.5) * this.w, (0.5 - cy / cw * 0.5) * this.h, cw];
  }

  /** Builds per-colour-bucket paths of the (optionally mirrored) channel segments. */
  _build(s, mx, my, mz, ox, oy, oz) {
    const { vp } = s.cam;
    const seg = s.segs, tmin = this.lut.tmin, tmax = this.lut.tmax;
    const paths = Array.from({ length: BUCKETS }, () => ({ p: new Path2D(), n: 0, depth: 0 }));
    for (let i = 0; i < s.segCount; i++) {
      const o = i * 8;
      const a = this._proj(vp, seg[o] * mx + ox, seg[o + 1] * my + oy, seg[o + 2] * mz + oz);
      const b = this._proj(vp, seg[o + 3] * mx + ox, seg[o + 4] * my + oy, seg[o + 5] * mz + oz);
      if (!a || !b) continue;
      const k = Math.min(BUCKETS - 1, Math.max(0, Math.floor((seg[o + 6] - tmin) / (tmax - tmin) * BUCKETS)));
      const P = paths[k];
      P.p.moveTo(a[0], a[1]); P.p.lineTo(b[0], b[1]);
      P.n++; P.depth += b[2];
    }
    return paths;
  }

  _strokeAll(paths, s, alphaScale) {
    const ctx = this.ctx, { pxPerM } = s.cam, tmin = this.lut.tmin, tmax = this.lut.tmax;
    for (let k = 0; k < BUCKETS; k++) {
      const P = paths[k];
      if (!P.n) continue;
      const T = tmin + (k + 0.5) / BUCKETS * (tmax - tmin);
      const [r, g, b, B] = sample(this.lut, T);
      if (B < 0.01) continue;
      const mpx = pxPerM / (P.depth / P.n);          // pixels per metre at this bucket's depth
      const rgb = `${enc(r)},${enc(g)},${enc(b)}`;
      // soft scatter, corona, white-hot core
      for (const [wm, minPx, a] of [[30, 4, 0.14], [5, 1.3, 0.85]]) {
        ctx.lineWidth = Math.max(minPx, wm * s.thickness * mpx);
        ctx.strokeStyle = `rgba(${rgb},${Math.min(1, a * B * s.gain * alphaScale)})`;
        ctx.stroke(P.p);
      }
    }
  }

  render(s) {
    const ctx = this.ctx, { w, h } = this, { vp } = s.cam, H = s.half;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#030306';
    ctx.fillRect(0, 0, w, h);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // light scattered in the chamber, centred on the discharge
    const lp = this._proj(vp, s.light[0], s.light[1], s.light[2]);
    if (lp && s.light[3] > 0.01) {
      const c = s.lightColor, rad = Math.max(w, h) * 0.6;
      const g = ctx.createRadialGradient(lp[0], lp[1], 0, lp[0], lp[1], rad);
      const a = Math.min(0.25, s.light[3] * 0.08);
      g.addColorStop(0, `rgba(${enc(c[0])},${enc(c[1])},${enc(c[2])},${a})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    }
    // chamber edges
    const corners = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) corners.push(this._proj(vp, x * H[0], y * H[1], z * H[2]));
    ctx.strokeStyle = 'rgba(140,155,200,0.22)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [i, j] of [[0, 4], [1, 5], [2, 6], [3, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 1], [2, 3], [4, 5], [6, 7]]) {
      const a = corners[i], b = corners[j];
      if (a && b) { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
    }
    ctx.stroke();
    this._puffs(s);
    if (!s.segCount) return;
    ctx.globalCompositeOperation = 'lighter';
    // reflections in the glass walls (method of images), clipped to the projected wall quad;
    // average Fresnel reflectance of glass at oblique viewing ≈ 0.06
    if (s.reflect >= 2 && s.reflections !== false) {
      const walls = [
        [[-1, 1, 1, 2 * H[0], 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]],
        [[-1, 1, 1, -2 * H[0], 0, 0], [[-1, -1, -1], [-1, 1, -1], [-1, 1, 1], [-1, -1, 1]]],
        [[1, -1, 1, 0, 2 * H[1], 0], [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]]],
        [[1, -1, 1, 0, -2 * H[1], 0], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]],
        [[1, 1, -1, 0, 0, -2 * H[2]], [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1]]],
      ];
      for (const [m, quad] of walls) {
        const q = quad.map(([x, y, z]) => this._proj(vp, x * H[0], y * H[1], z * H[2]));
        if (q.some((v) => !v)) continue;
        ctx.save();
        ctx.beginPath(); ctx.moveTo(q[0][0], q[0][1]); for (let i = 1; i < 4; i++) ctx.lineTo(q[i][0], q[i][1]); ctx.closePath();
        ctx.clip();
        this._strokeAll(this._build(s, m[0], m[1], m[2], m[3], m[4], m[5]), s, 0.06 * s.reflect);
        ctx.restore();
      }
    }
    this._strokeAll(this._build(s, 1, 1, 1, 0, 0, 0), s, 1);
    ctx.globalCompositeOperation = 'source-over';
  }
}
