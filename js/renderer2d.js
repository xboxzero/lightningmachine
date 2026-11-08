// Canvas 2D fallback renderer — used when WebGL2 is unavailable (hardware acceleration off,
// blocked GPU/driver, old browsers). Same simulation and colour science, simpler drawing:
// projected channel segments with additive ("lighter") glow layers, chamber edges, and
// Fresnel-weighted wall reflections clipped to each wall.
import { windowCamera } from './renderer.js';

const sample = (t, T, row = 0) => {
  const i = Math.round(Math.min(1, Math.max(0, (T - t.tmin) / (t.tmax - t.tmin))) * (t.n - 1));
  const r0 = Math.floor(row), f = row - r0, rows = t.rows || 1;
  const a = (Math.min(rows - 1, r0) * t.n + i) * 4, b = (Math.min(rows - 1, r0 + 1) * t.n + i) * 4;
  return [0, 1, 2, 3].map((k) => t.data[a + k] * (1 - f) + t.data[b + k] * f);
};
const GAS_BUCKETS = 14;
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
  }
  setLUT(data, n, rows, tmin, tmax) { this.lut = { data, n, rows, tmin, tmax }; }
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
    const paths = Array.from({ length: BUCKETS * GAS_BUCKETS }, () => ({ p: new Path2D(), n: 0, depth: 0 }));
    const gscale = GAS_BUCKETS / Math.max(1, (this.lut.rows || 1) - 1);
    for (let i = 0; i < s.segCount; i++) {
      const o = i * 9;
      const a = this._proj(vp, seg[o] * mx + ox, seg[o + 1] * my + oy, seg[o + 2] * mz + oz);
      const b = this._proj(vp, seg[o + 3] * mx + ox, seg[o + 4] * my + oy, seg[o + 5] * mz + oz);
      if (!a || !b) continue;
      const k = Math.min(BUCKETS - 1, Math.max(0, Math.floor((seg[o + 6] - tmin) / (tmax - tmin) * BUCKETS)));
      const gb = Math.min(GAS_BUCKETS - 1, Math.max(0, Math.floor(seg[o + 8] * gscale)));
      const P = paths[gb * BUCKETS + k];
      P.p.moveTo(a[0], a[1]); P.p.lineTo(b[0], b[1]);
      P.n++; P.depth += b[2];
    }
    return paths;
  }

  _strokeAll(paths, s, alphaScale) {
    const ctx = this.ctx, { pxPerM } = s.cam, tmin = this.lut.tmin, tmax = this.lut.tmax;
    const gstep = Math.max(1, (this.lut.rows || 1) - 1) / GAS_BUCKETS;
    for (let idx = 0; idx < paths.length; idx++) {
      const P = paths[idx];
      if (!P.n) continue;
      const k = idx % BUCKETS, gb = Math.floor(idx / BUCKETS);
      const T = tmin + (k + 0.5) / BUCKETS * (tmax - tmin);
      const [r, g, b, B] = sample(this.lut, T, (gb + 0.5) * gstep);
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
    if (s.ascii) {
      if (!this.off) { this.off = document.createElement('canvas'); this.offCtx = this.off.getContext('2d'); this.tiny = document.createElement('canvas'); this.tinyCtx = this.tiny.getContext('2d', { willReadFrequently: true }); }
      if (this.off.width !== this.w || this.off.height !== this.h) { this.off.width = this.w; this.off.height = this.h; }
      const main = this.ctx;
      this.ctx = this.offCtx;
      this._scene(s);
      this.ctx = main;
      this._ascii(s);
      return;
    }
    this._scene(s);
  }

  /** ASCII engine (CPU): downsample to one pixel per cell, Sobel edges → glyphs. */
  _ascii(s) {
    const ctx = this.ctx, { w, h } = this;
    const cw = Math.max(5, Math.round(s.glyphSize)), chh = Math.round(cw * 1.5);
    const cols = Math.ceil(w / cw), rows = Math.ceil(h / chh);
    if (this.tiny.width !== cols || this.tiny.height !== rows) { this.tiny.width = cols; this.tiny.height = rows; }
    const tc = this.tinyCtx;
    tc.imageSmoothingEnabled = true; tc.imageSmoothingQuality = 'medium';
    tc.drawImage(this.off, 0, 0, cols, rows);
    const px = tc.getImageData(0, 0, cols, rows).data;
    const L = new Float32Array(cols * rows);
    for (let i = 0; i < cols * rows; i++) L[i] = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    ctx.font = `bold ${Math.round(chh * 0.85)}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const ramp = ' .`:,-~=+*ox%O#@', dirs = '-/|\\';
    const vpx = (s.eye[0] / s.half[0] * 0.5 + 0.5) * w, vpy = (0.5 - s.eye[1] / s.half[1] * 0.5) * h;
    const at = (x, y) => L[Math.min(rows - 1, Math.max(0, y)) * cols + Math.min(cols - 1, Math.max(0, x))];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x, l = L[i];
        if (l < 0.06) continue;
        // image rows grow downward: flip gy so angles match screen-up convention
        const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
        const gy = (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1)) - (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
        let ch;
        if (Math.hypot(gx, gy) > 0.14) {
          const e = Math.atan2(gy, gx) + Math.PI / 2;
          ch = dirs[Math.floor((((e + Math.PI / 8) % Math.PI) + Math.PI) % Math.PI / (Math.PI / 4)) % 4];
        } else ch = ramp[Math.min(ramp.length - 1, Math.floor(Math.pow(l, 0.75) * 1.15 * ramp.length))];
        const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2], m = Math.max(r, g, b, 1);
        const k = (0.25 + 1.1 * Math.sqrt(m / 255)) * 255 / m, wv = Math.max(0, (m / 255 - 0.55) / 0.45) * 0.7;
        ctx.fillStyle = `rgb(${Math.min(255, (r * k) * (1 - wv) + 255 * wv) | 0},${Math.min(255, (g * k) * (1 - wv) + 255 * wv) | 0},${Math.min(255, (b * k) * (1 - wv) + 255 * wv) | 0})`;
        const cx = x * cw + cw / 2, cy = y * chh + chh * 0.55;
        // 3-D extrusion toward the vanishing point (darker flank), then the lit front face
        const fill = ctx.fillStyle;
        let vx = vpx - cx, vy = vpy - cy; const vl = Math.hypot(vx, vy) || 1; vx /= vl; vy /= vl;
        ctx.fillStyle = `rgba(${(r * 0.35) | 0},${(g * 0.35) | 0},${(b * 0.35) | 0},0.9)`;
        ctx.fillText(ch, cx + vx * cw * 0.28, cy + vy * cw * 0.28);
        ctx.fillStyle = fill;
        ctx.fillText(ch, cx, cy);
      }
    }
  }

  _scene(s) {
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
