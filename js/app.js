import { Renderer } from './renderer.js';
import { Sound } from './audio.js';
import { project } from './math.js';

const $ = (s) => document.querySelector(s);
// parameter ids — must match core/src/lib.rs
const P = { bolts: 0, flow: 1, swirl: 2, crackle: 3, branch: 4, eta: 5, life: 6, mic: 7, tension: 8, restrike: 9,
  ipeak: 10, icc: 11, slowmo: 12, leader: 13, pockets: 14 };
// sea-level Rayleigh scattering coefficients for R, G, B (m⁻¹), ∝ λ⁻⁴
const RAYLEIGH = [5.8e-6, 13.5e-6, 33.1e-6];

let wasm, renderer;
const sound = new Sound();
const ui = { gain: 1, thickness: 1, bloom: 1.0, vol: 0.7, style: 0, haze: 6, autorot: 0.06, soundOn: false, micOn: false };
const cam = { yaw: 0.6, pitch: 0.2, dist: 2000, fov: 55 * Math.PI / 180, eye: [0, 0, 0] };

const f32 = (p, n) => new Float32Array(wasm.memory.buffer, p, n);

const controls = [
  { id: 'bolts', label: 'Bolts', min: 1, max: 12, step: 1, v: 5, p: P.bolts },
  { id: 'flow', label: 'Flow speed', min: 0, max: 3, step: 0.05, v: 1, p: P.flow },
  { id: 'swirl', label: 'Swirl size', min: 0.4, max: 3, step: 0.05, v: 1, p: P.swirl },
  { id: 'tension', label: 'Smoothness', min: 0, max: 1, step: 0.01, v: 0.3, p: P.tension },
  { id: 'crackle', label: 'Crackle', min: 0, max: 1.5, step: 0.01, v: 0.5, p: P.crackle },
  { id: 'eta', label: 'Breakdown exponent η', min: 0.5, max: 8, step: 0.1, v: 3, p: P.eta },
  { id: 'branch', label: 'Branching', min: 0, max: 2, step: 0.01, v: 0.6, p: P.branch },
  { id: 'pockets', label: 'Charge regions (tripoles)', min: 1, max: 6, step: 1, v: 2, p: P.pockets },
  { id: 'leader', label: 'Leader speed (steps/s)', min: 20, max: 600, step: 5, v: 160, p: P.leader },
  { id: 'ipeak', label: 'Peak current (kA)', min: 5, max: 200, step: 1, v: 31, p: P.ipeak },
  { id: 'icc', label: 'Continuing current (A)', min: 0, max: 8000, step: 10, v: 2500, p: P.icc },
  { id: 'restrike', label: 'Re-strikes / s', min: 0, max: 5, step: 0.05, v: 1.0, p: P.restrike },
  { id: 'slowmo', label: 'Stroke slow-motion ×', min: 200, max: 20000, step: 100, v: 2000, p: P.slowmo, map: (x) => 1 / x },
  { id: 'life', label: 'Bolt lifetime (s)', min: 2, max: 30, step: 0.5, v: 10, p: P.life },
  { id: 'haze', label: 'Air / haze density', min: 0, max: 30, step: 0.5, v: 6, ui: 'haze' },
  { id: 'autorot', label: 'Auto-rotate', min: 0, max: 0.5, step: 0.01, v: 0.06, ui: 'autorot' },
  { id: 'gain', label: 'Brightness', min: 0.1, max: 3, step: 0.01, v: 1, ui: 'gain' },
  { id: 'thickness', label: 'Thickness', min: 0.3, max: 4, step: 0.05, v: 1, ui: 'thickness' },
  { id: 'vol', label: 'Volume', min: 0, max: 1.5, step: 0.01, v: 0.7, ui: 'vol', fn: (x) => sound.setVolume(x) },
];

function buildPanel() {
  const body = $('#controls');
  for (const c of controls) {
    const row = document.createElement('label');
    row.className = 'row';
    row.innerHTML = `<span>${c.label}</span><b id="v-${c.id}"></b><input type="range" min="${c.min}" max="${c.max}" step="${c.step}" value="${c.v}">`;
    body.appendChild(row);
    const inp = row.querySelector('input'), out = row.querySelector('b');
    const apply = () => {
      const x = parseFloat(inp.value);
      out.textContent = c.step >= 1 ? x.toFixed(0) : x.toFixed(2);
      if (c.p !== undefined) wasm.set_param(c.p, c.map ? c.map(x) : x);
      if (c.ui) ui[c.ui] = x;
      if (c.fn) c.fn(x);
    };
    inp.addEventListener('input', apply);
    apply();
  }
  drawSpectrumBar();
}

/** Colour bar of the channel emission vs temperature (from the WASM spectral model). */
function drawSpectrumBar() {
  const cv = $('#tbar'), g = cv.getContext('2d');
  cv.width = 256; cv.height = 12;
  const enc = (v) => Math.round(255 * Math.min(1, v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
  for (let x = 0; x < 256; x++) {
    const T = renderer.lut.tmin + (renderer.lut.tmax - renderer.lut.tmin) * x / 255;
    const [r, gg, b, B] = renderer.colorAt(T);
    const k = Math.min(1, B * 1.2);
    g.fillStyle = `rgb(${enc(r * k)},${enc(gg * k)},${enc(b * k)})`;
    g.fillRect(x, 0, 1, 12);
  }
}

// ---------------------------------------------------------------- UI behaviour
let idleT = 0;
function poke() {
  document.body.classList.remove('idle');
  clearTimeout(idleT);
  idleT = setTimeout(() => { if (!document.body.classList.contains('open')) document.body.classList.add('idle'); }, 2500);
}
function togglePanel(force) {
  const open = force !== undefined ? force : !document.body.classList.contains('open');
  document.body.classList.toggle('open', open);
  poke();
}
function toggleFullscreen() {
  const d = document, el = d.documentElement;
  if (!(d.fullscreenElement || d.webkitFullscreenElement)) (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
  else (d.exitFullscreen || d.webkitExitFullscreen).call(d);
}
async function toggleSound() {
  if (!ui.soundOn) { await sound.start(); sound.setVolume(ui.vol); }
  ui.soundOn = !ui.soundOn;
  $('#btn-sound').classList.toggle('on', ui.soundOn);
  $('#btn-sound').textContent = ui.soundOn ? '🔊' : '🔈';
}
async function toggleMic() {
  if (ui.micOn) { sound.disableMic(); ui.micOn = false; wasm.set_param(P.mic, 0); $('#mic-bar').style.transform = 'scaleX(0)'; }
  else {
    try { await sound.enableMic(); ui.micOn = true; if (!ui.soundOn) await toggleSound(); }
    catch (e) { alert('Microphone unavailable: ' + e.message); }
  }
  $('#btn-mic').classList.toggle('on', ui.micOn);
}
const STYLE_PRESET = { 0: { crackle: 0.5, tension: 0.3, bloom: 1.0 }, 1: { crackle: 0.1, tension: 0.7, bloom: 0.35 }, 2: { crackle: 0.1, tension: 0.7, bloom: 0.45 } };
function setSlider(id, v) {
  const inp = document.querySelector(`#v-${id}`)?.parentElement.querySelector('input');
  if (inp) { inp.value = v; inp.dispatchEvent(new Event('input')); }
}
function setStyle(m) {
  const pr = STYLE_PRESET[m];
  setSlider('crackle', pr.crackle); setSlider('tension', pr.tension); ui.bloom = pr.bloom;
  ui.style = m;
  document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('on', +b.dataset.mode === m));
}

// ---------------------------------------------------------------- camera input
function setupInput() {
  const cv = renderer.canvas;
  const pts = new Map();
  let down = null, pinch = 0;
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
    poke();
  });
  cv.addEventListener('pointermove', (e) => {
    poke();
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) cam.dist = Math.min(12000, Math.max(800, cam.dist * pinch / d));
      pinch = d;
      if (down) down.moved = 99;
      return;
    }
    if (down) down.moved += Math.abs(dx) + Math.abs(dy);
    cam.yaw -= dx * 0.005;
    cam.pitch = Math.max(-1.4, Math.min(1.4, cam.pitch + dy * 0.004));
  });
  const up = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = 0;
    if (down && pts.size === 0) {
      if (down.moved < 8 && performance.now() - down.t < 350) wasm.strike(); // tap = strike
      down = null;
    }
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', (e) => { e.preventDefault(); cam.dist = Math.min(12000, Math.max(800, cam.dist * Math.exp(e.deltaY * 0.001))); poke(); }, { passive: false });
  window.addEventListener('mousemove', poke);
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    poke();
    if (e.code === 'Space') { e.preventDefault(); wasm.strike(); }
    if (e.code === 'KeyF') toggleFullscreen();
    if (e.code === 'KeyH' || e.code === 'Escape') togglePanel(e.code === 'Escape' ? false : undefined);
    if (e.code === 'KeyS') toggleSound();
    if (e.code === 'KeyM') toggleMic();
    if (e.code === 'Digit1') setStyle(0);
    if (e.code === 'Digit2') setStyle(1);
    if (e.code === 'Digit3') setStyle(2);
  });
  $('#btn-menu').onclick = () => togglePanel();
  $('#btn-close').onclick = () => togglePanel(false);
  $('#btn-fs').onclick = toggleFullscreen;
  $('#btn-sound').onclick = toggleSound;
  $('#btn-mic').onclick = toggleMic;
  $('#btn-strike').onclick = () => wasm.strike();
  document.querySelectorAll('#modes button').forEach((b) => (b.onclick = () => setStyle(+b.dataset.mode)));
}

// ---------------------------------------------------------------- frame loop
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const [w, h] = renderer.resize();
  if (ui.micOn) {
    const m = sound.analyse(now / 1000);
    wasm.set_param(P.mic, m.level);
    if (m.onset) wasm.strike();
    $('#mic-bar').style.transform = `scaleX(${m.level.toFixed(3)})`;
  }
  const n = wasm.step(dt);
  const info = f32(wasm.info_ptr(), 16);

  cam.yaw += ui.autorot * dt;
  const cp = Math.cos(cam.pitch);
  cam.eye = [Math.sin(cam.yaw) * cp * cam.dist, Math.sin(cam.pitch) * cam.dist, Math.cos(cam.yaw) * cp * cam.dist];
  const camera = renderer.camera(cam.eye, [0, 0, 0], cam.fov);

  const act = Math.min(1.5, Math.log1p(info[2]) * 0.6);
  const lp = project(camera.vp, [info[3], info[4], info[5]]) || [0.5, 0.5];
  if (ui.soundOn) {
    const sp = project(camera.vp, [info[8], info[9], info[10]]);
    const pan = sp ? sp[0] * 2 - 1 : 0;
    for (let i = 0; i < Math.min(2, info[0]); i++) sound.thunder(0.8 + Math.random() * 0.4, pan);
    if (info[1] > 0) sound.thunder(0.45, pan);
  }
  const hot = renderer.colorAt(Math.max(8000, info[6]));
  const ext = RAYLEIGH.map((b) => b * ui.haze + 2e-6 * ui.haze); // Rayleigh + weak Mie haze
  renderer.render({
    cam: camera, eye: cam.eye, extinction: ext,
    segs: f32(wasm.seg_ptr(), Math.max(1, n) * 8), segCount: n, time: now / 1000, style: ui.style,
    gain: ui.gain, thickness: ui.thickness, bloom: ui.bloom,
    room: hot.slice(0, 3).map((c) => c * act * (ui.style === 0 ? 0.035 : 0.012)), lightPos: lp,
  });
  requestAnimationFrame(frame);
}

async function boot() {
  try { renderer = new Renderer($('#view')); }
  catch (e) { document.body.insertAdjacentHTML('beforeend', `<p class="err">${e.message}</p>`); return; }
  const bytes = await (await fetch('lightning.wasm')).arrayBuffer();
  wasm = (await WebAssembly.instantiate(bytes, {})).instance.exports;
  wasm.init((Math.random() * 2 ** 31) >>> 0);
  renderer.setLUT(f32(wasm.lut_ptr(), wasm.lut_len() * 4).slice(), wasm.lut_len(), wasm.lut_tmin(), wasm.lut_tmax());
  renderer.resize();
  buildPanel();
  setupInput();
  setStyle(0);
  poke();
  window.__lm = { wasm, setStyle, togglePanel, cam };
  requestAnimationFrame((t) => { last = t; frame(t); });
}
boot();
