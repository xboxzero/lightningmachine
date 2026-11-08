// 3-D ASCII engine — pure CPU + Canvas 2D (no WebGL needed, works in every browser).
//
// The lightning channel segments from the WASM simulation are projected with the same
// off-axis "window" camera and rasterised straight into a grid of character cells:
//   * every sample deposits a Gaussian splat into a sharp "core" buffer (σ ≈ 0.42 cell)
//     and a wide Gaussian "glow" buffer (σ ≈ 1.8 cells) — mist/bloom in character space;
//   * the projected direction of the channel is accumulated as a doubled-angle vector
//     (cos 2θ, sin 2θ) so opposite directions don't cancel → exact edge glyphs / | \ -;
//   * depth is accumulated luminance-weighted → per-cell depth for 3-D glyphs:
//     perspective size, depth haze, extrusion toward the vanishing point, and a
//     Gaussian depth-of-field around a drifting focal depth.
import { windowCamera } from './renderer.js';

const RAMP = ' .`:-~=+*ox%O#@';
const DIRS = ['-', '/', '|', '\\'];
const enc = (v) => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)));

export class RendererASCII {
  constructor(canvas) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }) || canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D canvas available.');
    this.ctx = ctx;
    this.cpu = true;
    this.scale = 1; this.w = this.h = 0;
    this.cols = this.rows = 0;
  }
  setLUT(data, n, rows, tmin, tmax) { this.lut = { data, n, rows, tmin, tmax }; }
  setBlackbody(data, n, tmin, tmax) { this.bb = { data, n, tmin, tmax }; }
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.scale;
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
    if (w !== this.w || h !== this.h) { this.w = w; this.h = h; this.canvas.width = w; this.canvas.height = h; }
    this.dpr = dpr;
    return [w, h];
  }
  windowCamera(eye, half) { return windowCamera(eye, half, this.h); }

  _alloc(cols, rows) {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols; this.rows = rows;
    const n = cols * rows;
    this.core = new Float32Array(n); this.glow = new Float32Array(n);
    this.cr = new Float32Array(n); this.cg = new Float32Array(n); this.cb = new Float32Array(n);
    this.dep = new Float32Array(n); this.d2x = new Float32Array(n); this.d2y = new Float32Array(n);
    // Gaussian kernels (precomputed)
    this.kCore = []; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) this.kCore.push([i, j, Math.exp(-(i * i + j * j) / (2 * 0.55 * 0.55))]);
    this.kGlow = []; for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) { const g = Math.exp(-(i * i + j * j) / (2 * 1.8 * 1.8)); if (g > 0.02) this.kGlow.push([i, j, g]); }
  }

  /** Fast colour-table lookup with fractional gas row. */
  _color(T, row, out) {
    const t = this.lut;
    const i = Math.round(Math.min(1, Math.max(0, (T - t.tmin) / (t.tmax - t.tmin))) * (t.n - 1));
    const r0 = Math.floor(row), f = row - r0, rows = t.rows || 1;
    const a = (Math.min(rows - 1, r0) * t.n + i) * 4, b = (Math.min(rows - 1, r0 + 1) * t.n + i) * 4, d = t.data;
    out[0] = d[a] * (1 - f) + d[b] * f; out[1] = d[a + 1] * (1 - f) + d[b + 1] * f;
    out[2] = d[a + 2] * (1 - f) + d[b + 2] * f; out[3] = d[a + 3] * (1 - f) + d[b + 3] * f;
    return out;
  }

  _proj(vp, x, y, z, out) {
    const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    if (cw < 5) return false;
    out[0] = ((vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / cw * 0.5 + 0.5) * this.w;
    out[1] = (0.5 - (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / cw * 0.5) * this.h;
    out[2] = cw;
    return true;
  }

  /** Rasterise one 3-D line into the cell buffers with Gaussian splats. */
  _line(vp, ax, ay, az, bx, by, bz, r, g, b, wgt, dNear, dFar, glowK) {
    const A = this._pa, B = this._pb;
    if (!this._proj(vp, ax, ay, az, A) || !this._proj(vp, bx, by, bz, B)) return;
    const cw = this.cw, chh = this.chh, cols = this.cols, rows = this.rows;
    const x0 = A[0] / cw, y0 = A[1] / chh, x1 = B[0] / cw, y1 = B[1] / chh;
    const dx = x1 - x0, dy = y1 - y0;
    const L = Math.hypot(dx, dy);
    if ((x0 < -3 && x1 < -3) || (y0 < -3 && y1 < -3) || (x0 > cols + 3 && x1 > cols + 3) || (y0 > rows + 3 && y1 > rows + 3)) return;
    const n = Math.max(1, Math.ceil(L * 1.5));
    // doubled-angle direction in screen space (y down → flip for a y-up convention)
    const ang = Math.atan2(-(dy * chh), dx * cw);
    const c2 = Math.cos(2 * ang), s2 = Math.sin(2 * ang);
    const depth = Math.min(1, Math.max(0, ((A[2] + B[2]) * 0.5 - dNear) / (dFar - dNear)));
    const per = wgt / n * Math.max(L, 0.6);
    const core = this.core, glow = this.glow, kc = this.kCore, kg = this.kGlow;
    for (let s = 0; s <= n; s++) {
      const f = s / n, px = x0 + dx * f, py = y0 + dy * f;
      const ix = Math.floor(px), iy = Math.floor(py);
      for (let k = 0; k < kc.length; k++) {
        const cx = ix + kc[k][0], cy = iy + kc[k][1];
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
        const ex = cx + 0.5 - px, ey = cy + 0.5 - py;
        const gw = Math.exp(-(ex * ex + ey * ey) / (2 * 0.42 * 0.42)) * per;
        const i = cy * cols + cx;
        core[i] += gw;
        this.cr[i] += r * gw; this.cg[i] += g * gw; this.cb[i] += b * gw;
        this.dep[i] += depth * gw; this.d2x[i] += c2 * gw; this.d2y[i] += s2 * gw;
      }
      if (glowK > 0 && (s & 1) === 0) {
        const gq = per * 2 * glowK;
        for (let k = 0; k < kg.length; k++) {
          const cx = ix + kg[k][0], cy = iy + kg[k][1];
          if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
          const i = cy * cols + cx, gw = kg[k][2] * gq;
          glow[i] += gw;
          this.cr[i] += r * gw * 0.15; this.cg[i] += g * gw * 0.15; this.cb[i] += b * gw * 0.15;
        }
      }
    }
  }

  render(s) {
    const ctx = this.ctx, { w, h } = this, { vp } = s.cam, H = s.half;
    const cw = Math.max(5, Math.round(s.glyphSize * this.dpr));
    const chh = Math.round(cw * 1.6);
    this.cw = cw; this.chh = chh;
    this._alloc(Math.ceil(w / cw), Math.ceil(h / chh));
    this._pa = this._pa || new Float32Array(3); this._pb = this._pb || new Float32Array(3);
    const cols = this.cols, rows = this.rows, N = cols * rows;
    this.core.fill(0); this.glow.fill(0); this.cr.fill(0); this.cg.fill(0); this.cb.fill(0);
    this.dep.fill(0); this.d2x.fill(0); this.d2y.fill(0);
    const dNear = s.eye[2] - H[2], dFar = s.eye[2] + H[2] * 2.2;
    const col = this._col || (this._col = new Float32Array(4));
    // chamber: the glass edges as faint lines (gives the 3-D box in ASCII)
    const E = [[-1, -1, -1, 1, -1, -1], [-1, 1, -1, 1, 1, -1], [-1, -1, 1, 1, -1, 1], [-1, 1, 1, 1, 1, 1],
      [-1, -1, -1, -1, 1, -1], [1, -1, -1, 1, 1, -1], [-1, -1, 1, -1, 1, 1], [1, -1, 1, 1, 1, 1],
      [-1, -1, -1, -1, -1, 1], [1, -1, -1, 1, -1, 1], [-1, 1, -1, -1, 1, 1], [1, 1, -1, 1, 1, 1]];
    for (const e of E) this._line(vp, e[0] * H[0], e[1] * H[1], e[2] * H[2], e[3] * H[0], e[4] * H[1], e[5] * H[2], 0.45, 0.55, 0.95, 0.05, dNear, dFar, 0);
    // lightning (+ optional mirror images in the glass, Fresnel ≈ 4–10 %)
    const seg = s.segs, gk = s.mist * 0.5 + 0.25;
    const views = [[1, 1, 1, 0, 0, 0, 1]];
    if (s.reflect >= 1.5 && s.reflections !== false) {
      const R = 0.05 * s.reflect;
      views.push([-1, 1, 1, 2 * H[0], 0, 0, R], [-1, 1, 1, -2 * H[0], 0, 0, R], [1, -1, 1, 0, -2 * H[1], 0, R], [1, 1, -1, 0, 0, -2 * H[2], R]);
    }
    for (const [mx, my, mz, ox, oy, oz, vw] of views) {
      for (let i = 0; i < s.segCount; i++) {
        const o = i * 9;
        this._color(seg[o + 6], seg[o + 8], col);
        const B = col[3];
        if (B < 0.02) continue;
        const wgt = B * Math.abs(seg[o + 7]) * s.gain * vw;
        this._line(vp, seg[o] * mx + ox, seg[o + 1] * my + oy, seg[o + 2] * mz + oz, seg[o + 3] * mx + ox, seg[o + 4] * my + oy, seg[o + 5] * mz + oz,
          col[0], col[1], col[2], wgt, dNear, dFar, vw === 1 ? gk : 0);
      }
    }
    // ---- draw
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#020204';
    ctx.fillRect(0, 0, w, h);
    // faint room light from the discharge (Gaussian radial falloff)
    const lp = this._pa;
    if (s.light[3] > 0.01 && this._proj(vp, s.light[0], s.light[1], s.light[2], lp)) {
      const c = s.lightColor, gr = ctx.createRadialGradient(lp[0], lp[1], 0, lp[0], lp[1], Math.max(w, h) * 0.55);
      const a = Math.min(0.12, s.light[3] * 0.04);
      gr.addColorStop(0, `rgba(${enc(c[0])},${enc(c[1])},${enc(c[2])},${a})`);
      gr.addColorStop(0.5, `rgba(${enc(c[0])},${enc(c[1])},${enc(c[2])},${a * 0.3})`);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gr; ctx.fillRect(0, 0, w, h);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const vpx = (s.eye[0] / H[0] * 0.5 + 0.5) * w, vpy = (0.5 - s.eye[1] / H[1] * 0.5) * h;
    const focus = s.focus, dof = s.dof;
    // group cells by font size so the font is set only a few times per frame
    const SIZES = 6, buckets = Array.from({ length: SIZES }, () => []);
    for (let i = 0; i < N; i++) {
      const c = this.core[i], gl = this.glow[i];
      const tot = c + gl;
      if (tot < 0.05) continue;
      const d = c > 1e-6 ? this.dep[i] / c : 0.5;
      // perceived brightness (Stevens-like power law) and Gaussian depth of field
      let Lb = Math.min(1.6, Math.pow(c * 0.45, 0.55));
      const blur = dof > 0 ? 1 - Math.exp(-(d - focus) * (d - focus) / (2 * dof * dof)) : 0;
      let ch;
      const coh = c > 1e-6 ? Math.hypot(this.d2x[i], this.d2y[i]) / c : 0;
      if (c > 0.08 && coh > 0.4 && blur < 0.7 && Lb < 1.25) {
        const ang = Math.atan2(this.d2y[i], this.d2x[i]) / 2;             // undo the doubling
        const k = Math.floor(((ang + Math.PI / 8) % Math.PI + Math.PI) % Math.PI / (Math.PI / 4)) % 4;
        ch = DIRS[k];
      } else {
        const lv = c > 0.05 ? Lb * (1 - 0.4 * blur) : Math.min(0.35, Math.pow(gl, 0.6) * 0.5);   // glow-only cells = mist
        const gi = Math.min(RAMP.length - 1, Math.floor(lv * 1.05 * RAMP.length));
        if (gi <= 0) continue;
        ch = RAMP[gi];
        if (c <= 0.05) Lb = lv * 0.8;
      }
      const sz = Math.min(SIZES - 1, Math.floor(d * SIZES));
      buckets[sz].push(i, ch.charCodeAt(0), Lb, d, blur);
    }
    for (let sz = 0; sz < SIZES; sz++) {
      const list = buckets[sz];
      if (!list.length) continue;
      const dmid = (sz + 0.5) / SIZES;
      const fpx = Math.round(chh * (1.12 - 0.55 * dmid));              // perspective glyph size
      ctx.font = `bold ${fpx}px ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace`;
      const ext = cw * (0.34 - 0.24 * dmid);                            // extrusion length
      for (let q = 0; q < list.length; q += 5) {
        const i = list[q], ch = String.fromCharCode(list[q + 1]), Lb = list[q + 2], d = list[q + 3], blur = list[q + 4];
        const cx = (i % cols) * cw + cw * 0.5, cy = Math.floor(i / cols) * chh + chh * 0.55;
        const tw = this.core[i] + this.glow[i] * 0.15 + 1e-6;
        let r = this.cr[i] / tw, g = this.cg[i] / tw, b = this.cb[i] / tw;
        const m = Math.max(r, g, b, 1e-4);
        r /= m; g /= m; b /= m;                                           // spectral hue
        const white = Math.min(0.7, Math.max(0, (Lb - 0.5) / 0.6) * 0.7); // saturating core turns white
        const haze = 1.2 - 0.65 * d, k = (0.3 + 1.25 * Math.min(1.2, Lb)) * haze * (1 - 0.35 * blur);
        r = (r * (1 - white) + white) * k; g = (g * (1 - white) + white) * k; b = (b * (1 - white) + white) * k;
        b = b * (1 + 0.25 * d); r = r * (1 - 0.15 * d);                   // distant glyphs cool slightly
        // extruded flank toward the vanishing point
        let vx = vpx - cx, vy = vpy - cy; const vl = Math.hypot(vx, vy) || 1; vx /= vl; vy /= vl;
        ctx.fillStyle = `rgb(${enc(r * 0.33)},${enc(g * 0.33)},${enc(b * 0.33)})`;
        ctx.fillText(ch, cx + vx * ext, cy + vy * ext);
        ctx.fillStyle = `rgb(${enc(r)},${enc(g)},${enc(b)})`;
        ctx.fillText(ch, cx, cy);
      }
    }
  }
}
