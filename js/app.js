import { Renderer } from './renderer.js';
import { Renderer2D } from './renderer2d.js';
import { Sound } from './audio.js';

const $ = (s) => document.querySelector(s);
// parameter ids — must match core/src/lib.rs
const P = { bolts: 0, blobs: 1, heat: 2, flow: 3, eta: 4, quantum: 5, betaLog: 6, workFn: 7, branch: 8, connect: 9,
  ipeak: 10, icc: 11, restrike: 12, slowmo: 13, life: 14, crackle: 15, tension: 16, mic: 17, leader: 18,
  turb: 19, eddy: 20, diffuse: 21, smoke: 22, clouds: 23 };

let wasm, renderer;
const sound = new Sound();
const ui = { smoke: 1, gain: 1, thickness: 1, bloom: 1.0, vol: 0.7, reflect: 1, mist: 0.3, autoQuality: true, sway: 1, soundOn: false, micOn: false };
const HY = 1000, HZ = 900, FOV = 50 * Math.PI / 180;
const view = { dragX: 0, dragY: 0 };

const f32 = (p, n) => new Float32Array(wasm.memory.buffer, p, n);

const controls = [
  { sec: 'Lightning', id: 'bolts', label: 'Bolts', min: 1, max: 10, step: 1, v: 4, p: P.bolts },
  { sec: 'Lightning', id: 'connect', label: 'Connect distance (m)', min: 0, max: 400, step: 5, v: 170, p: P.connect },
  { sec: 'Lightning', id: 'branch', label: 'Branching', min: 0, max: 2, step: 0.01, v: 0.35, p: P.branch },
  { sec: 'Lightning', id: 'eta', label: 'Breakdown exponent η', min: 0.5, max: 8, step: 0.1, v: 2.6, p: P.eta },
  { sec: 'Lightning', id: 'leader', label: 'Leader speed (steps/s)', min: 30, max: 800, step: 5, v: 170, p: P.leader },
  { sec: 'Lightning', id: 'ipeak', label: 'Peak current (kA)', min: 5, max: 200, step: 1, v: 31, p: P.ipeak },
  { sec: 'Lightning', id: 'icc', label: 'Continuing current (A)', min: 0, max: 8000, step: 10, v: 2500, p: P.icc },
  { sec: 'Lightning', id: 'restrike', label: 'Re-strikes / s', min: 0, max: 5, step: 0.05, v: 1, p: P.restrike },
  { sec: 'Lightning', id: 'slowmo', label: 'Stroke slow-motion ×', min: 200, max: 20000, step: 100, v: 2000, p: P.slowmo, map: (x) => 1 / x },
  { sec: 'Lightning', id: 'life', label: 'Bolt lifetime (s)', min: 2, max: 30, step: 0.5, v: 11, p: P.life },
  { sec: 'Quantum tunnelling', id: 'quantum', label: 'WKB tunnelling weight', min: 0, max: 1, step: 0.01, v: 0.25, p: P.quantum },
  { sec: 'Quantum tunnelling', id: 'betaLog', label: 'Field enhancement log₁₀β', min: 3, max: 5.5, step: 0.05, v: 4.4, p: P.betaLog },
  { sec: 'Quantum tunnelling', id: 'workFn', label: 'Work function φ (eV)', min: 2, max: 7, step: 0.05, v: 4.5, p: P.workFn },
  { sec: 'Smoke & mist motion', id: 'smokeN', label: 'Smoke puffs', min: 0, max: 200, step: 1, v: 110, p: P.smoke },
  { sec: 'Smoke & mist motion', id: 'cloudN', label: 'Cloud puffs', min: 0, max: 200, step: 1, v: 45, p: P.clouds },
  { sec: 'Smoke & mist motion', id: 'smokeK', label: 'Smoke density', min: 0, max: 2.5, step: 0.05, v: 1, ui: 'smoke' },
  { sec: 'Smoke & mist motion', id: 'turb', label: 'Turbulence (rms m/s)', min: 0, max: 250, step: 1, v: 35, p: P.turb },
  { sec: 'Smoke & mist motion', id: 'eddy', label: 'Largest eddy (m)', min: 300, max: 4000, step: 50, v: 1400, p: P.eddy },
  { sec: 'Smoke & mist motion', id: 'diffuse', label: 'Mist diffusion (m²/s)', min: 0, max: 400, step: 5, v: 40, p: P.diffuse },
  { sec: 'Smoke & mist motion', id: 'mist', label: 'Mist haze (cooling glow spread)', min: 0, max: 2, step: 0.05, v: 0.3, ui: 'mist' },
  { sec: 'Chamber flow', id: 'blobs', label: 'Charge cells (invisible)', min: 2, max: 12, step: 1, v: 7, p: P.blobs },
  { sec: 'Chamber flow', id: 'heat', label: 'Convection heat', min: 0, max: 3, step: 0.05, v: 1, p: P.heat },
  { sec: 'Chamber flow', id: 'flow', label: 'Convection rolls', min: 0, max: 3, step: 0.05, v: 0.15, p: P.flow },
  { sec: 'Chamber flow', id: 'tension', label: 'Smoothness', min: 0, max: 1, step: 0.01, v: 0.3, p: P.tension },
  { sec: 'Chamber flow', id: 'crackle', label: 'Crackle', min: 0, max: 1.5, step: 0.01, v: 0.3, p: P.crackle },
  { sec: 'Glass & view', id: 'reflect', label: 'Glass reflection (1 = real glass)', min: 0, max: 12, step: 0.1, v: 1, ui: 'reflect' },
  { sec: 'Glass & view', id: 'sway', label: 'Automatic viewpoint drift', min: 0, max: 3, step: 0.05, v: 1, ui: 'sway' },
  { sec: 'Glass & view', id: 'gain', label: 'Brightness', min: 0.1, max: 3, step: 0.01, v: 1, ui: 'gain' },
  { sec: 'Glass & view', id: 'thickness', label: 'Thickness', min: 0.3, max: 4, step: 0.05, v: 1, ui: 'thickness' },
  { sec: 'Glass & view', id: 'bloom', label: 'Bloom', min: 0, max: 3, step: 0.05, v: 1, ui: 'bloom' },
  { sec: 'Glass & view', id: 'vol', label: 'Volume', min: 0, max: 1.5, step: 0.01, v: 0.7, ui: 'vol', fn: (x) => sound.setVolume(x) },
];

function buildPanel() {
  const body = $('#controls');
  const secs = {};
  for (const c of controls) {
    if (!secs[c.sec]) {
      const d = document.createElement('details');
      d.open = c.sec === 'Lightning' || c.sec === 'Smoke & mist motion';
      d.innerHTML = `<summary>${c.sec}</summary>`;
      body.appendChild(d);
      secs[c.sec] = d;
    }
    const row = document.createElement('label');
    row.className = 'row';
    row.innerHTML = `<span>${c.label}</span><b></b><input type="range" min="${c.min}" max="${c.max}" step="${c.step}" value="${c.v}">`;
    secs[c.sec].appendChild(row);
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
  drawBars();
}

function drawBars() {
  const enc = (v) => Math.round(255 * Math.min(1, v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
  for (const [id, table, scale] of [['#tbar', renderer.lut, 1.2]]) {
    const cv = $(id), g = cv.getContext('2d');
    cv.width = 256; cv.height = 10;
    for (let x = 0; x < 256; x++) {
      const T = table.tmin + (table.tmax - table.tmin) * x / 255;
      const [r, gg, b, B] = Renderer.sample(table, T);
      const k = Math.min(1, B * scale);
      g.fillStyle = `rgb(${enc(r * k)},${enc(gg * k)},${enc(b * k)})`;
      g.fillRect(x, 0, 1, 10);
    }
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

function setupInput() {
  const cv = renderer.canvas;
  let down = null;
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0, id: e.pointerId };
    poke();
  });
  cv.addEventListener('pointermove', (e) => {
    poke();
    if (!down || e.pointerId !== down.id) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    down.x = e.clientX; down.y = e.clientY;
    down.moved += Math.abs(dx) + Math.abs(dy);
    // dragging moves your eye in front of the glass → look around inside the chamber
    view.dragX = Math.max(-1.6, Math.min(1.6, view.dragX - dx / cv.clientWidth * 3));
    view.dragY = Math.max(-1.2, Math.min(1.2, view.dragY + dy / cv.clientHeight * 3));
  });
  const up = (e) => {
    if (down && e.pointerId === down.id) {
      if (down.moved < 8 && performance.now() - down.t < 350) wasm.strike();
      down = null;
    }
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  window.addEventListener('mousemove', poke);
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    poke();
    if (e.code === 'Space') { e.preventDefault(); wasm.strike(); }
    if (e.code === 'KeyF') toggleFullscreen();
    if (e.code === 'KeyH' || e.code === 'Escape') togglePanel(e.code === 'Escape' ? false : undefined);
    if (e.code === 'KeyS') toggleSound();
    if (e.code === 'KeyM') toggleMic();
  });
  $('#btn-menu').onclick = () => togglePanel();
  $('#btn-close').onclick = () => togglePanel(false);
  $('#btn-fs').onclick = toggleFullscreen;
  $('#btn-sound').onclick = toggleSound;
  $('#btn-mic').onclick = toggleMic;
  $('#btn-strike').onclick = () => wasm.strike();
}

// ---------------------------------------------------------------- frame loop
const blobPos = new Float32Array(48), blobCol = new Float32Array(48);
let last = performance.now();
// adaptive quality: keep ~60 fps by scaling the render resolution (and dropping wall
// reflections as a last resort on very slow devices)
const perf = { avg: 16.7, t: 0, reflections: true };
function adapt(ms) {
  ms = Math.min(ms, 250);
  perf.avg = perf.avg * 0.85 + ms * 0.15;
  perf.t += ms;
  if (!ui.autoQuality || perf.t < 500) return;   // re-evaluate every half second
  perf.t = 0;
  const minScale = renderer.fallback ? 0.4 : 0.35;
  if (perf.avg > 20 && renderer.scale > minScale) renderer.scale = Math.max(minScale, renderer.scale * (perf.avg > 40 ? 0.7 : 0.85));
  else if (perf.avg < 14 && renderer.scale < 1) renderer.scale = Math.min(1, renderer.scale * 1.08);
  perf.reflections = !(renderer.scale <= minScale + 0.01 && perf.avg > 24);
}
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  adapt(now - last);
  last = now;
  const t = now / 1000;
  const [w, h] = renderer.resize();
  const half = [HY * w / h, HY, HZ];
  wasm.set_box(half[0], half[1], half[2]);
  if (ui.micOn) {
    const m = sound.analyse(t);
    wasm.set_param(P.mic, m.level);
    if (m.onset) wasm.strike();
    $('#mic-bar').style.transform = `scaleX(${m.level.toFixed(3)})`;
  }
  const n = wasm.step(dt);
  const info = f32(wasm.info_ptr(), 16);

  // eye in front of the glass: slow automatic drift (Lissajous) + drag offset relaxing back
  view.dragX *= Math.exp(-dt * 0.4); view.dragY *= Math.exp(-dt * 0.4);
  const D = HY / Math.tan(FOV / 2);
  const sx = (0.45 * Math.sin(t * 0.11) + 0.15 * Math.sin(t * 0.27 + 1.3)) * ui.sway + view.dragX;
  const sy = (0.30 * Math.sin(t * 0.083 + 0.7) + 0.10 * Math.sin(t * 0.21)) * ui.sway + view.dragY;
  const eye = [sx * half[0], sy * half[1], HZ + D];
  const cam = renderer.windowCamera(eye, half);

  const nb = info[11] | 0;
  const blobs = f32(wasm.blob_ptr(), 12 * 8);
  for (let i = 0; i < nb; i++) {
    blobPos.set([blobs[i * 8], blobs[i * 8 + 1], blobs[i * 8 + 2], blobs[i * 8 + 3]], i * 4);
    const [r, g, b, B] = Renderer.sample(renderer.bb, blobs[i * 8 + 4]);
    blobCol.set([r, g, b, B * 0.3], i * 4);
  }
  const act = Math.min(2, Math.log1p(info[2]) * 0.7);
  const lc = Renderer.sample(renderer.lut, Math.max(9000, info[6]));
  if (ui.soundOn) {
    // 3-D: from the strike point, gliding toward the glowing channel's centre (km, eye-relative)
    const rel = (p) => [(p[0] - eye[0]) / 1000, (p[1] - eye[1]) / 1000, (p[2] - eye[2]) / 1000];
    const from = rel([info[8], info[9], info[10]]), to = rel([info[3], info[4], info[5]]);
    for (let i = 0; i < Math.min(2, info[0]); i++) sound.thunder(0.8 + Math.random() * 0.4, from, to);
    if (info[1] > 0) sound.thunder(0.4, to, from);
  }
  renderer.render({
    cam, eye, half, time: t,
    segs: f32(wasm.seg_ptr(), Math.max(1, n) * 8), segCount: n,
    light: [info[3], info[4], info[5], act], lightColor: [lc[0], lc[1], lc[2]],
    blobPos, blobCol, nBlobs: 0, lava: 0,
    puffs: f32(wasm.puff_ptr(), Math.max(1, wasm.puff_count()) * 8), puffCount: wasm.puff_count(), smoke: ui.smoke,
    reflect: ui.reflect, reflections: perf.reflections, mist: ui.mist, gain: ui.gain, thickness: ui.thickness, bloom: ui.bloom,
  });
  requestAnimationFrame(frame);
}

async function boot() {
  try { renderer = new Renderer($('#view')); }
  catch (e) {
    // WebGL2 missing or its shaders failed: switch to the Canvas 2D renderer on a fresh canvas
    console.warn('WebGL2 renderer unavailable, using Canvas 2D:', e.message);
    const old = $('#view'), cv = document.createElement('canvas');
    cv.id = 'view'; old.replaceWith(cv);
    try { renderer = new Renderer2D(cv); }
    catch (e2) { document.body.insertAdjacentHTML('beforeend', `<p class="err">${e2.message}</p>`); return; }
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = 'Compatibility mode (WebGL2 unavailable) — enable hardware acceleration in your browser for full quality.';
    document.body.appendChild(note);
    setTimeout(() => note.classList.add('hide'), 7000);
  }
  const bytes = await (await fetch('lightning.wasm')).arrayBuffer();
  wasm = (await WebAssembly.instantiate(bytes, {})).instance.exports;
  wasm.init((Math.random() * 2 ** 31) >>> 0);
  renderer.setLUT(f32(wasm.lut_ptr(), wasm.lut_len() * 4).slice(), wasm.lut_len(), wasm.lut_tmin(), wasm.lut_tmax());
  renderer.setBlackbody(f32(wasm.bb_ptr(), wasm.bb_len() * 4).slice(), wasm.bb_len(), wasm.bb_tmin(), wasm.bb_tmax());
  const [w, h] = renderer.resize();
  wasm.set_box(HY * w / h, HY, HZ);
  buildPanel();
  setupInput();
  poke();
  window.__lm = { wasm, togglePanel, ui, perf, get renderer() { return renderer; } };
  requestAnimationFrame((tt) => { last = tt; frame(tt); });
}
boot();
