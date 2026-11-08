// Canvas 2D storm renderer — used automatically when WebGL2 is not available.
// Same scene and data as the WebGL renderer: sky, flash-lit cloud deck, ground with the
// strike-point light pool, rain, the grounded tower and the lightning channel coloured by
// black-body temperature (radiance ∝ T⁴), drawn as additive glow layers.
import { perspective, lookAt, mul } from './math.js';

const enc = (v) => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)));
const BUCKETS = 40;

export class Renderer2D {
  constructor(canvas) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false }) || canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D canvas available.');
    this.ctx = ctx;
    this.floatOK = true;
    this.fallback = true;
    this.scale = 1; this.w = this.h = 0;
    this.clouds = this._cloudTexture();
    this.drops = Array.from({ length: 700 }, () => [Math.random(), Math.random(), 0.5 + Math.random()]);
  }

  setLUT(data, n, tmin, tmax) { this.lut = { data, n, tmin, tmax }; }

  /** Cloud deck texture: fractal value noise, generated once. */
  _cloudTexture() {
    const W = 512, H = 192, cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d'), img = g.createImageData(W, H);
    const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
    const noise = (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    };
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let s = 0, a = 0.5, f = 1 / 48;
        for (let o = 0; o < 5; o++) { s += a * noise(x * f, y * f * 2.2); f *= 2; a *= 0.5; }
        const d = Math.max(0, Math.min(1, (s - 0.32) * 1.9)) * (0.35 + 0.65 * (y / H));
        const i = (y * W + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(d * 255);
      }
    g.putImageData(img, 0, 0);
    return cv;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5) * this.scale;
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
    if (w !== this.w || h !== this.h) { this.w = w; this.h = h; this.canvas.width = w; this.canvas.height = h; }
  }

  _proj(vp, p) {
    const cw = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
    if (cw < 1) return null;
    return [((vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12]) / cw * 0.5 + 0.5) * this.w,
      (0.5 - (vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13]) / cw * 0.5) * this.h, cw];
  }

  _lutColor(T) {
    const t = this.lut, i = Math.round(Math.min(1, Math.max(0, (T - t.tmin) / (t.tmax - t.tmin))) * (t.n - 1));
    return [t.data[i * 3], t.data[i * 3 + 1], t.data[i * 3 + 2]];
  }

  render(s) {
    this.resize();
    const ctx = this.ctx, { w, h } = this;
    const proj = perspective(s.fov, w / h, 1.0, 80000);
    const vp = mul(proj, lookAt(s.eye, s.target, [0, 1, 0]));
    const L = s.light;
    // flash strength seen by the scene (same scaling idea as the WebGL lighting)
    const flash = Math.min(1.5, L[0] * s.flashK / 2.5e5);
    const lc = [L[4] || 0.8, L[5] || 0.85, L[6] || 1];
    const fwd = [s.target[0] - s.eye[0], s.target[1] - s.eye[1], s.target[2] - s.eye[2]];
    const fl = Math.hypot(fwd[0], fwd[2]) || 1;
    const far = (y) => this._proj(vp, [s.eye[0] + fwd[0] / fl * 40000, y, s.eye[2] + fwd[2] / fl * 40000]);
    const hz = far(0), cb = far(s.cloudBase);
    const yHor = hz ? hz[1] : h * 0.6, yCloud = yHor;   // the cloud deck reaches the horizon in perspective

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    // sky
    const amb = 0.05 * s.ambient;
    let g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, `rgb(${enc(amb * 0.35)},${enc(amb * 0.4)},${enc(amb * 0.6)})`);
    g.addColorStop(Math.max(0, Math.min(1, yHor / h)), `rgb(${enc(amb * 0.6)},${enc(amb * 0.65)},${enc(amb * 0.85)})`);
    g.addColorStop(1, `rgb(${enc(amb * 0.15)},${enc(amb * 0.17)},${enc(amb * 0.2)})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    // cloud deck (dark underside, lit from below by the flash)
    if (yCloud > 0) {
      const off = (s.time * 6) % this.clouds.width;
      ctx.globalAlpha = 0.55;
      ctx.filter = 'none';
      ctx.drawImage(this.clouds, off, 0, this.clouds.width - off, this.clouds.height, 0, 0, w * (1 - off / this.clouds.width), yCloud);
      ctx.drawImage(this.clouds, 0, 0, off, this.clouds.height, w * (1 - off / this.clouds.width), 0, w * off / this.clouds.width, yCloud);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = `rgb(${enc(amb * 0.5)},${enc(amb * 0.55)},${enc(amb * 0.75)})`;
      ctx.fillRect(0, 0, w, yCloud);
      ctx.globalCompositeOperation = 'source-over';
      if (flash > 0.01) {
        const lp = this._proj(vp, [L[1], Math.max(L[2], s.cloudBase * 0.8), L[3]]);
        const cx = lp ? lp[0] : w / 2;
        ctx.globalCompositeOperation = 'lighter';
        const rg = ctx.createRadialGradient(cx, yCloud, 0, cx, yCloud, Math.max(w, h) * 0.8);
        const a = Math.min(0.45, flash * 0.3);
        rg.addColorStop(0, `rgba(${enc(lc[0])},${enc(lc[1])},${enc(lc[2])},${a})`);
        rg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = rg; ctx.globalAlpha = 0.6;
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, yCloud); ctx.clip();
        ctx.fillRect(0, 0, w, yCloud);
        ctx.globalAlpha = Math.min(0.5, flash * 0.35);
        ctx.drawImage(this.clouds, 0, 0, this.clouds.width, this.clouds.height, 0, 0, w, yCloud);
        ctx.restore();
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      }
    }
    // ground
    if (yHor < h) {
      g = ctx.createLinearGradient(0, yHor, 0, h);
      g.addColorStop(0, `rgb(${enc(amb * 0.4)},${enc(amb * 0.42)},${enc(amb * 0.4)})`);
      g.addColorStop(1, `rgb(${enc(amb * 0.12)},${enc(amb * 0.14)},${enc(amb * 0.1)})`);
      ctx.fillStyle = g; ctx.fillRect(0, yHor, w, h - yHor);
      // strike-point light pool and general flash on the ground
      ctx.globalCompositeOperation = 'lighter';
      const gp = s.ground[3] > 0 ? this._proj(vp, s.ground) : null;
      if (gp) {
        const r = Math.max(30, 6e5 / gp[2]);
        const rg = ctx.createRadialGradient(gp[0], gp[1], 0, gp[0], gp[1], r);
        rg.addColorStop(0, `rgba(${enc(lc[0])},${enc(lc[1])},${enc(lc[2])},${Math.min(0.6, s.ground[3])})`);
        rg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = rg; ctx.fillRect(gp[0] - r, gp[1] - r, 2 * r, 2 * r);
      }
      if (flash > 0.01) {
        ctx.fillStyle = `rgba(${enc(lc[0])},${enc(lc[1])},${enc(lc[2])},${Math.min(0.12, flash * 0.06)})`;
        ctx.fillRect(0, yHor, w, h - yHor);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    // tower with blinking aviation light
    if (s.tower) {
      const b = this._proj(vp, [s.tower[0], 0, s.tower[1]]), t = this._proj(vp, [s.tower[0], s.tower[2], s.tower[1]]);
      if (b && t) {
        ctx.strokeStyle = `rgb(${enc(0.02 + flash * 0.2)},${enc(0.02 + flash * 0.2)},${enc(0.025 + flash * 0.22)})`;
        ctx.lineWidth = Math.max(1.5, 14 * h / b[2] * 0.8);
        ctx.beginPath(); ctx.moveTo(b[0], b[1]); ctx.lineTo(t[0], t[1]); ctx.stroke();
        if ((s.time * 0.75) % 1 > 0.5) {
          ctx.globalCompositeOperation = 'lighter';
          const rg = ctx.createRadialGradient(t[0], t[1], 0, t[0], t[1], 10);
          rg.addColorStop(0, 'rgba(255,40,30,0.95)'); rg.addColorStop(1, 'rgba(255,0,0,0)');
          ctx.fillStyle = rg; ctx.fillRect(t[0] - 10, t[1] - 10, 20, 20);
          ctx.globalCompositeOperation = 'source-over';
        }
      }
    }
    // lightning: bucket segments by temperature, then halo / glow / core layers
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (s.segCount > 0) {
      const paths = Array.from({ length: BUCKETS }, () => ({ p: new Path2D(), n: 0, depth: 0 }));
      const t = this.lut, seg = s.segs;
      for (let i = 0; i < s.segCount; i++) {
        const o = i * 8;
        const a = this._proj(vp, [seg[o], seg[o + 1], seg[o + 2]]), b = this._proj(vp, [seg[o + 3], seg[o + 4], seg[o + 5]]);
        if (!a || !b) continue;
        const k = Math.min(BUCKETS - 1, Math.max(0, Math.floor((seg[o + 6] - t.tmin) / (t.tmax - t.tmin) * BUCKETS)));
        const P = paths[k];
        P.p.moveTo(a[0], a[1]); P.p.lineTo(b[0], b[1]); P.n++; P.depth += b[2];
      }
      const pxm = proj[5] * 0.5 * h;   // pixels per metre at distance 1
      for (let k = 0; k < BUCKETS; k++) {
        const P = paths[k];
        if (!P.n) continue;
        const T = t.tmin + (k + 0.5) / BUCKETS * (t.tmax - t.tmin);
        const B = Math.pow(T / 10000, 4) * s.boltGain * s.exposure;   // Stefan–Boltzmann radiance
        if (B < 0.003) continue;
        // no HDR/bloom on a plain canvas: map radiance perceptually (≈ eye response, B^0.5)
        const Bv = 1 - Math.exp(-Math.sqrt(B) * 0.9);   // smooth saturation (film-like exposure)
        const [r, gg, bb] = this._lutColor(T);
        const rgb = `${enc(r)},${enc(gg)},${enc(bb)}`;
        const mpx = pxm / (P.depth / P.n);
        for (const [wm, minPx, ga] of [[s.coreWidth * 18, 8, 0.07], [s.coreWidth * 5, 3, 0.22], [s.coreWidth, 1.6, 1.0]]) {
          ctx.lineWidth = Math.max(minPx, wm * mpx);
          ctx.strokeStyle = `rgba(${rgb},${Math.min(1, ga * Bv)})`;
          ctx.stroke(P.p);
        }
      }
    }
    // rain streaks (lit by the flash)
    if (s.rain > 0) {
      const n = Math.floor(this.drops.length * s.rain);
      const a = Math.min(0.3, 0.06 + flash * 0.12);
      ctx.strokeStyle = `rgba(${enc(0.3 + lc[0] * flash * 0.4)},${enc(0.33 + lc[1] * flash * 0.4)},${enc(0.4 + lc[2] * flash * 0.4)},${a})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const d = this.drops[i];
        const x = (d[0] * w + s.time * 40 * d[2]) % w, y = (d[1] * h + s.time * 900 * d[2]) % h;
        ctx.moveTo(x, y); ctx.lineTo(x + 3 * d[2], y + 16 * d[2]);
      }
      ctx.stroke();
    }
    // whole-scene flash (eye/scatter)
    if (flash > 0.4) {
      ctx.fillStyle = `rgba(${enc(lc[0])},${enc(lc[1])},${enc(lc[2])},${Math.min(0.12, (flash - 0.4) * 0.1)})`;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}
