import { Renderer } from './renderer.js';
import { AudioEngine } from './audio.js';
import { v3 } from './math.js';

const $ = (s) => document.querySelector(s);
const PHASES = ['Idle — charge building', 'Stepped leader', 'Return stroke', 'Inter-stroke', 'Dart leader', 'Afterglow / continuing current'];
const THUNDER_SR = 24000;
const CLOUD_BASE = 2900, CLOUD_TOP = 3900;
const RES = { low: [40, 72, 40], medium: [48, 88, 48], high: [64, 112, 64] };

// parameter ids — must match core/src/lib.rs
const P = { eta: 0, quantum: 1, betaLog: 2, workFn: 3, noise: 4, ipeak: 5, leaderSlow: 6, strokeSlow: 7, activity: 8, v0: 9,
  tower: 10, micLevel: 11, micPitch: 12, micSteer: 13, sweeps: 14, auto: 15, afterglow: 16, strokes: 17 };

const state = {
  paused: false, time: 0, exposure: 0.9, bloom: 0.9, bloomRadius: 1.0, coreWidth: 5, boltGain: 1.0, rain: 0.7, ambient: 1.0,
  flashK: 0.8, volume: 0.8, quality: 1, res: 'medium', camMode: 'orbit', fov: 55 * Math.PI / 180,
  mic: false, micLevel: 0, micPitch: 0.5, thunderETA: [], lastStroke: -1, lastFlash: -1, strikeDist: 0,
};

const cam = {
  target: [0, 1300, 0], yaw: 0.35, pitch: 0.05, dist: 4300,
  pos: [0, 120, 5200], fyaw: Math.PI, fpitch: 0.2, // fly
  vel: [0, 0, 0], eye: [0, 0, 0], look: [0, 0, 0],
};

let wasm, mem, renderer, audio;

function f32(ptr, n) { return new Float32Array(wasm.memory.buffer, ptr, n); }

let thunderWorker = null;
async function loadWasm() {
  const res = await fetch('lightning.wasm');
  const bytes = await res.arrayBuffer();
  const module = await WebAssembly.compile(bytes);
  const instance = await WebAssembly.instantiate(module, {});
  wasm = instance.exports;
  try {
    thunderWorker = new Worker('js/thunder-worker.js');
    thunderWorker.postMessage({ type: 'init', module, seed: (Math.random() * 2 ** 31) | 0 });
    thunderWorker.onmessage = (e) => {
      const m = e.data;
      state.thunderMsgs = (state.thunderMsgs || 0) + 1;
      if (m.type === 'pcm' && audio && audio.ctx) audio.playThunder(m.data, m.ch, m.frames, m.sr, m.t0);
    };
  } catch (e) { console.warn('worker unavailable, synthesising on main thread', e); thunderWorker = null; }
}

function requestThunder() {
  if (!audio || !audio.ctx) return;
  const ch = audio.channels;
  const fwd = v3.sub(cam.look, cam.eye);
  const listener = [cam.eye[0], cam.eye[1], cam.eye[2], fwd[0], fwd[2]];
  const t0 = audio.ctx.currentTime;
  if (thunderWorker) {
    const count = wasm.thunder_snapshot();
    const snap = f32(wasm.snap_ptr(), count * 8).slice();
    thunderWorker.postMessage({ type: 'gen', count, snap, i0: wasm.thunder_i0(), listener, ch, sr: THUNDER_SR, t0 }, [snap.buffer]);
  } else {
    wasm.thunder_snapshot();
    const frames = wasm.thunder_gen(ch, THUNDER_SR);
    audio.playThunder(f32(wasm.thunder_ptr(), frames * ch), ch, frames, THUNDER_SR, t0);
  }
}

function initSim() {
  const [nx, ny, nz] = RES[state.res];
  wasm.init(nx, ny, nz, (Math.random() * 2 ** 31) >>> 0);
  renderer.setLUT(f32(wasm.lut_ptr(), wasm.lut_len() * 3).slice(), wasm.lut_len(), wasm.lut_tmin(), wasm.lut_tmax());
  drawLUTBar();
}

// ------------------------------------------------------------------ UI
const sliders = [
  { sec: 'Storm', id: 'activity', label: 'Storm activity', unit: 'flashes/min', min: 1, max: 40, step: 0.5, v: 8, p: P.activity },
  { sec: 'Storm', id: 'strokes', label: 'Mean strokes / flash', min: 1, max: 8, step: 0.1, v: 3.5, p: P.strokes },
  { sec: 'Storm', id: 'v0', label: 'Cloud potential', unit: 'MV', min: 10, max: 150, step: 1, v: 50, p: P.v0 },
  { sec: 'Storm', id: 'ipeak', label: 'Median peak current', unit: 'kA', min: 5, max: 120, step: 1, v: 31, p: P.ipeak },
  { sec: 'Physics (DBM / Gaussian)', id: 'eta', label: 'Breakdown exponent η', min: 0.5, max: 7, step: 0.05, v: 3.0, p: P.eta },
  { sec: 'Physics (DBM / Gaussian)', id: 'noise', label: 'Gaussian space-charge σ', min: 0, max: 2, step: 0.01, v: 0.55, p: P.noise },
  { sec: 'Physics (DBM / Gaussian)', id: 'sweeps', label: 'SOR sweeps / step', min: 1, max: 24, step: 1, v: 6, p: P.sweeps },
  { sec: 'Quantum tunnelling', id: 'quantum', label: 'WKB tunnelling weight', min: 0, max: 0.5, step: 0.005, v: 0.08, p: P.quantum },
  { sec: 'Quantum tunnelling', id: 'betaLog', label: 'Field enhancement log₁₀β', min: 2.5, max: 5.5, step: 0.05, v: 4.3, p: P.betaLog },
  { sec: 'Quantum tunnelling', id: 'workFn', label: 'Work function φ', unit: 'eV', min: 2, max: 7, step: 0.05, v: 4.5, p: P.workFn },
  { sec: 'Time', id: 'leaderSlow', label: 'Leader slow-motion', min: Math.log10(0.0005), max: Math.log10(0.05), step: 0.01, v: Math.log10(0.004), p: P.leaderSlow, log: true, fmt: (x) => '×' + Math.round(1 / x) },
  { sec: 'Time', id: 'strokeSlow', label: 'Stroke slow-motion', min: Math.log10(0.02), max: 0, step: 0.01, v: Math.log10(0.25), p: P.strokeSlow, log: true, fmt: (x) => '×' + (1 / x).toFixed(1) },
  { sec: 'Time', id: 'afterglow', label: 'Channel cooling τ', unit: 'ms', min: 2, max: 120, step: 1, v: 25, p: P.afterglow },
  { sec: 'Visual', id: 'exposure', label: 'Exposure', min: 0.1, max: 4, step: 0.01, v: 0.9, s: 'exposure' },
  { sec: 'Visual', id: 'bloom', label: 'Bloom (Gaussian scatter)', min: 0, max: 3, step: 0.01, v: 0.9, s: 'bloom' },
  { sec: 'Visual', id: 'coreWidth', label: 'Channel width', unit: 'm', min: 1, max: 30, step: 0.5, v: 5, s: 'coreWidth' },
  { sec: 'Visual', id: 'rain', label: 'Rain', min: 0, max: 1, step: 0.01, v: 0.7, s: 'rain' },
  { sec: 'Visual', id: 'quality', label: 'Render scale', min: 0.35, max: 1, step: 0.05, v: 1, s: 'quality' },
  { sec: 'Audio', id: 'volume', label: 'Master volume', min: 0, max: 1.5, step: 0.01, v: 0.8, s: 'volume' },
  { sec: 'Microphone', id: 'micSteer', label: 'Mic steering strength', min: 0, max: 3, step: 0.05, v: 1, p: P.micSteer },
];

function buildPanel() {
  const panel = $('#panel-body');
  const secs = {};
  for (const sd of sliders) {
    if (!secs[sd.sec]) {
      const d = document.createElement('details');
      d.open = ['Storm', 'Physics (DBM / Gaussian)', 'Quantum tunnelling'].includes(sd.sec);
      d.innerHTML = `<summary>${sd.sec}</summary><div class="sec"></div>`;
      panel.appendChild(d);
      secs[sd.sec] = d.querySelector('.sec');
    }
    const row = document.createElement('label');
    row.className = 'row';
    row.innerHTML = `<span class="lbl">${sd.label}</span><span class="val" id="v-${sd.id}"></span>
      <input type="range" id="s-${sd.id}" min="${sd.min}" max="${sd.max}" step="${sd.step}" value="${sd.v}">`;
    secs[sd.sec].appendChild(row);
    const input = row.querySelector('input'), val = row.querySelector('.val');
    const apply = () => {
      let x = parseFloat(input.value);
      if (sd.log) x = Math.pow(10, x);
      val.textContent = sd.fmt ? sd.fmt(x) : (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(sd.step < 0.05 ? 2 : 1)) + (sd.unit ? ' ' + sd.unit : '');
      if (sd.p !== undefined) wasm.set_param(sd.p, x);
      if (sd.s) {
        state[sd.s] = x;
        if (sd.s === 'volume' && audio) audio.setVolume(x);
        if (sd.s === 'rain' && audio) audio.setRain(x);
        if (sd.s === 'quality') renderer.scale = x;
      }
    };
    sd.apply = apply;
    input.addEventListener('input', apply);
    apply();
  }
  // selects / toggles appended to sections
  const extra = (sec, html) => { const d = document.createElement('div'); d.className = 'row'; d.innerHTML = html; secs[sec].appendChild(d); return d; };
  extra('Storm', `<span class="lbl">Grid resolution</span><select id="sel-res"><option value="low">Low 40×72×40</option><option value="medium" selected>Medium 48×88×48</option><option value="high">High 64×112×64</option></select>`);
  extra('Storm', `<label class="chk"><input type="checkbox" id="chk-auto" checked> Automatic strikes</label><label class="chk"><input type="checkbox" id="chk-tower" checked> Grounded tower</label>`);
  extra('Audio', `<span class="lbl">Speaker layout</span><select id="sel-layout"><option value="auto">Auto-detect</option><option value="stereo">Stereo / headphones (ITD)</option><option value="5.1">5.1 surround (VBAP)</option></select>`);
  extra('Audio', `<span class="lbl" id="audio-info">Audio not started</span>`);
  extra('Microphone', `<span class="lbl">Loudness → leader speed & strike trigger · pitch (spectral centroid) → branching & steering direction</span>`);
  $('#sel-res').onchange = (e) => { state.res = e.target.value; initSim(); };
  $('#chk-auto').onchange = (e) => wasm.set_param(P.auto, e.target.checked ? 1 : 0);
  $('#chk-tower').onchange = (e) => wasm.set_param(P.tower, e.target.checked ? 1 : 0);
  $('#sel-layout').onchange = (e) => { audio.applyLayout(e.target.value); updateAudioInfo(); };
}

function updateAudioInfo() {
  const el = $('#audio-info');
  if (!el) return;
  if (!audio.ctx) { el.textContent = 'Audio not started'; return; }
  const d = audio.ctx.destination;
  el.textContent = `Output: ${audio.channels === 6 ? '5.1 discrete' : 'stereo'} · device max ${d.maxChannelCount} ch · ${audio.ctx.sampleRate} Hz · latency ${((audio.ctx.baseLatency || 0) * 1000).toFixed(1)} ms`;
}

function drawLUTBar() {
  const cv = $('#lut-bar'), g = cv.getContext('2d');
  const n = wasm.lut_len(), lut = f32(wasm.lut_ptr(), n * 3);
  const W = cv.width = 256, H = cv.height = 10;
  for (let x = 0; x < W; x++) {
    const i = Math.floor(x / (W - 1) * (n - 1));
    const enc = (c) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
    g.fillStyle = `rgb(${enc(lut[i * 3])},${enc(lut[i * 3 + 1])},${enc(lut[i * 3 + 2])})`;
    g.fillRect(x, 0, 1, H);
  }
}

// ------------------------------------------------------------------ input: mouse / touch / keyboard / gamepad / virtual pads
const keys = new Set();
const input = { orbitX: 0, orbitY: 0, moveX: 0, moveY: 0, zoom: 0, up: 0 };
function setupInput() {
  const cv = renderer.canvas;
  let drag = null;
  const pointers = new Map();
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    drag = { b: e.button, shift: e.shiftKey };
  });
  cv.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (drag.pinch) zoomBy((drag.pinch - d) * 0.006);
      drag.pinch = d;
      return;
    }
    if (drag && (drag.b === 2 || drag.shift)) pan(dx, dy);
    else rotate(dx, dy);
  });
  const up = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2 && drag) drag.pinch = 0; };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', (e) => { e.preventDefault(); zoomBy(e.deltaY * 0.0012); }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    keys.add(e.code);
    if (e.code === 'Space') { e.preventDefault(); strike(); }
    if (e.code === 'KeyF') toggleFullscreen();
    if (e.code === 'KeyC') cycleCamera();
    if (e.code === 'KeyM') toggleMic();
    if (e.code === 'KeyP') togglePause();
    if (e.code === 'KeyH') togglePanel();
    if (e.code === 'KeyR') resetCamera();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  setupVirtualPads();
}

function rotate(dx, dy) {
  if (state.camMode === 'fly' || state.camMode === 'ground') {
    cam.fyaw -= dx * 0.004; cam.fpitch = Math.max(-1.45, Math.min(1.45, cam.fpitch - dy * 0.004));
  } else {
    cam.yaw -= dx * 0.005; cam.pitch = Math.max(-0.2, Math.min(1.45, cam.pitch + dy * 0.004));
  }
}
function pan(dx, dy) {
  if (state.camMode !== 'orbit' && state.camMode !== 'cinematic') return;
  const k = cam.dist * 0.0012;
  const r = [Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)];
  cam.target = v3.add(cam.target, v3.scale(r, -dx * k));
  cam.target[1] = Math.max(0, Math.min(4000, cam.target[1] + dy * k));
}
function zoomBy(d) {
  if (state.camMode === 'fly') { cam.pos = v3.add(cam.pos, v3.scale(flyForward(), -d * 400)); return; }
  if (state.camMode === 'ground') { state.fov = Math.max(0.25, Math.min(1.6, state.fov * Math.exp(d))); return; }
  cam.dist = Math.max(60, Math.min(30000, cam.dist * Math.exp(d)));
}
function flyForward() { return [Math.sin(cam.fyaw) * Math.cos(cam.fpitch), Math.sin(cam.fpitch), Math.cos(cam.fyaw) * Math.cos(cam.fpitch)]; }

function setupVirtualPads() {
  const pads = document.querySelectorAll('.vpad');
  pads.forEach((pad) => {
    const knob = pad.querySelector('.knob');
    let id = null, cx = 0, cy = 0;
    const R = 46;
    const set = (x, y) => {
      const l = Math.hypot(x, y), k = l > R ? R / l : 1;
      x *= k; y *= k;
      knob.style.transform = `translate(${x}px,${y}px)`;
      const nx = x / R, ny = y / R;
      if (pad.dataset.role === 'move') { input.moveX = nx; input.moveY = ny; } else { input.orbitX = nx; input.orbitY = ny; }
    };
    pad.addEventListener('pointerdown', (e) => {
      id = e.pointerId; pad.setPointerCapture(id);
      const r = pad.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      set(e.clientX - cx, e.clientY - cy); e.preventDefault();
    });
    pad.addEventListener('pointermove', (e) => { if (e.pointerId === id) set(e.clientX - cx, e.clientY - cy); });
    const end = (e) => { if (e.pointerId === id) { id = null; set(0, 0); } };
    pad.addEventListener('pointerup', end);
    pad.addEventListener('pointercancel', end);
  });
  const hold = (sel, field, v) => {
    const b = $(sel);
    b.addEventListener('pointerdown', (e) => { input[field] = v; e.preventDefault(); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => { input[field] = 0; });
  };
  hold('#vp-zin', 'zoom', -1); hold('#vp-zout', 'zoom', 1);
  hold('#vp-up', 'up', 1); hold('#vp-down', 'up', -1);
  $('#vp-strike').addEventListener('click', strike);
}

const padPrev = {};
function pollGamepad(dt) {
  const gps = navigator.getGamepads ? navigator.getGamepads() : [];
  let gp = null;
  for (const g of gps) if (g && g.connected) { gp = g; break; }
  $('#gp-status').textContent = gp ? '🎮 ' + gp.id.slice(0, 28) : '';
  if (!gp) return { mx: 0, my: 0, ox: 0, oy: 0, z: 0, u: 0 };
  const dz = (v) => (Math.abs(v) < 0.12 ? 0 : v);
  const b = (i) => gp.buttons[i] && gp.buttons[i].pressed;
  const edge = (i) => { const p = b(i), was = padPrev[i]; padPrev[i] = p; return p && !was; };
  if (edge(0)) strike();
  if (edge(1)) cycleCamera();
  if (edge(2)) toggleMic();
  if (edge(3)) togglePanel();
  if (edge(9)) togglePause();
  if (edge(8)) resetCamera();
  if (edge(12)) nudge('activity', 2);
  if (edge(13)) nudge('activity', -2);
  if (edge(14)) nudge('eta', -0.25);
  if (edge(15)) nudge('eta', 0.25);
  const lt = gp.buttons[6] ? gp.buttons[6].value : 0, rt = gp.buttons[7] ? gp.buttons[7].value : 0;
  return { mx: dz(gp.axes[0] || 0), my: dz(gp.axes[1] || 0), ox: dz(gp.axes[2] || 0), oy: dz(gp.axes[3] || 0), z: lt - rt, u: (b(5) ? 1 : 0) - (b(4) ? 1 : 0) };
}
function nudge(id, d) {
  const sd = sliders.find((s) => s.id === id), el = $('#s-' + id);
  el.value = Math.min(sd.max, Math.max(sd.min, parseFloat(el.value) + d));
  sd.apply();
  toast(`${sd.label}: ${$('#v-' + id).textContent}`);
}

// ------------------------------------------------------------------ actions
function strike() { wasm.trigger(); flashButton('#btn-strike'); }
function togglePause() { state.paused = !state.paused; $('#btn-pause').textContent = state.paused ? '▶' : '⏸'; toast(state.paused ? 'Paused' : 'Running'); }
function togglePanel() { document.body.classList.toggle('panel-hidden'); }
const CAMS = ['orbit', 'cinematic', 'ground', 'fly', 'strike'];
const CAM_NAMES = { orbit: 'Orbit', cinematic: 'Cinematic', ground: 'Ground observer', fly: 'Free fly', strike: 'Strike-point chase' };
function cycleCamera() { setCamera(CAMS[(CAMS.indexOf(state.camMode) + 1) % CAMS.length]); }
function setCamera(m) {
  state.camMode = m;
  if (m === 'ground') { cam.pos = [0, 1.7, 3800]; cam.fyaw = Math.PI; cam.fpitch = 0.32; state.fov = 70 * Math.PI / 180; }
  else state.fov = 55 * Math.PI / 180;
  if (m === 'fly') { cam.pos = [...cam.eye]; const d = v3.norm(v3.sub(cam.look, cam.eye)); cam.fyaw = Math.atan2(d[0], d[2]); cam.fpitch = Math.asin(d[1]); }
  $('#btn-cam').textContent = '🎥 ' + CAM_NAMES[m];
  $('#sel-cam').value = m;
  toast('Camera: ' + CAM_NAMES[m]);
}
function resetCamera() { cam.target = [0, 1300, 0]; cam.yaw = 0.35; cam.pitch = 0.05; cam.dist = 4300; setCamera('orbit'); }

function toggleFullscreen() {
  const d = document, el = d.documentElement;
  const fs = d.fullscreenElement || d.webkitFullscreenElement;
  if (!fs) (el.requestFullscreen || el.webkitRequestFullscreen).call(el, { navigationUI: 'hide' })?.catch?.(() => {});
  else (d.exitFullscreen || d.webkitExitFullscreen).call(d);
}
document.addEventListener('fullscreenchange', () => { $('#btn-fs').classList.toggle('on', !!document.fullscreenElement); });

async function toggleMic() {
  if (state.mic) {
    audio.disableMic(); state.mic = false;
    wasm.set_param(P.micLevel, 0);
    $('#btn-mic').classList.remove('on'); $('#mic-meter').hidden = true;
    toast('Microphone off');
    return;
  }
  try {
    await audio.enableMic();
    state.mic = true;
    $('#btn-mic').classList.add('on'); $('#mic-meter').hidden = false;
    toast('Microphone on — shout, clap or whistle to drive the storm');
    updateAudioInfo();
  } catch (e) {
    toast('Microphone unavailable: ' + e.message);
  }
}

let toastT = 0;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200); }
function flashButton(s) { const b = $(s); b.classList.add('hit'); setTimeout(() => b.classList.remove('hit'), 200); }

// ------------------------------------------------------------------ camera update
function updateCamera(dt, gp, stats) {
  const mx = input.moveX + gp.mx + (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const my = input.moveY + gp.my + (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0);
  const ox = input.orbitX + gp.ox + (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0);
  const oy = input.orbitY + gp.oy + (keys.has('ArrowDown') ? 1 : 0) - (keys.has('ArrowUp') ? 1 : 0);
  const zz = input.zoom + gp.z + (keys.has('Minus') ? 1 : 0) - (keys.has('Equal') ? 1 : 0);
  const uu = input.up + gp.u + (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0);
  const m = state.camMode;
  if (m === 'fly' || m === 'ground') {
    cam.fyaw -= ox * dt * 1.6; cam.fpitch = Math.max(-1.45, Math.min(1.45, cam.fpitch - oy * dt * 1.2));
    const f = flyForward(), r = [-Math.cos(cam.fyaw), 0, Math.sin(cam.fyaw)];
    if (m === 'fly') {
      const sp = 150 + Math.abs(cam.pos[1]) * 0.8;
      cam.pos = v3.add(cam.pos, v3.scale(f, -my * sp * dt));
      cam.pos = v3.add(cam.pos, v3.scale(r, -mx * sp * dt));
      cam.pos[1] = Math.max(2, cam.pos[1] + uu * sp * dt);
      if (zz) zoomBy(zz * dt * 2);
    } else {
      const fl = v3.norm([f[0], 0, f[2]]);
      cam.pos = v3.add(cam.pos, v3.scale(fl, -my * 6 * dt));
      cam.pos = v3.add(cam.pos, v3.scale(r, -mx * 6 * dt));
      if (zz) zoomBy(zz * dt);
    }
    cam.eye = [...cam.pos];
    cam.look = v3.add(cam.pos, f);
    return;
  }
  cam.yaw -= (ox + mx) * dt * 1.2;
  cam.pitch = Math.max(-0.2, Math.min(1.45, cam.pitch + (oy + my * 0.5) * dt * 0.9));
  if (zz) zoomBy(zz * dt * 1.5);
  cam.target[1] = Math.max(0, Math.min(4000, cam.target[1] + uu * dt * 800));
  let target = cam.target, dist = cam.dist;
  if (m === 'cinematic') {
    cam.yaw += dt * 0.05;
    const wob = Math.sin(state.time * 0.07) * 0.2;
    dist = cam.dist * (1 + wob);
  }
  if (m === 'strike' || m === 'cinematic') {
    const gpnt = stats[23] >= 0 ? [stats[9], m === 'strike' ? 600 : 1250, stats[11]] : cam.target;
    cam.smoothT = cam.smoothT ? v3.lerp(cam.smoothT, gpnt, 1 - Math.exp(-dt * 1.5)) : gpnt;
    target = cam.smoothT;
    if (m === 'strike') dist = Math.min(cam.dist, 2200);
  }
  const cp = Math.cos(cam.pitch);
  cam.eye = [target[0] + Math.sin(cam.yaw) * cp * dist, Math.max(3, target[1] + Math.sin(cam.pitch) * dist), target[2] + Math.cos(cam.yaw) * cp * dist];
  cam.look = target;
}

// ------------------------------------------------------------------ main loop
let last = performance.now(), fpsAcc = 0, fpsN = 0, fps = 0, physMs = 0, hudT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
  state.time += dt;

  const gp = pollGamepad(dt);
  // microphone
  if (state.mic) {
    const m = audio.analyseMic(state.time);
    wasm.set_param(P.micLevel, m.level);
    wasm.set_param(P.micPitch, m.pitch);
    if (m.onset) strike();
    $('#mic-bar').style.width = (m.level * 100).toFixed(1) + '%';
    $('#mic-pitch').style.left = (m.pitch * 100).toFixed(1) + '%';
    $('#mic-txt').textContent = `${m.db.toFixed(0)} dBFS · centroid ${m.centroid.toFixed(0)} Hz`;
  }

  let stats0 = f32(wasm.stats_ptr(), 24);
  updateCamera(dt, gp, stats0);
  const fwd = v3.sub(cam.look, cam.eye);
  wasm.set_listener(cam.eye[0], cam.eye[1], cam.eye[2], fwd[0], fwd[2]);

  const t0 = performance.now();
  const n = state.paused ? wasm.step(0) : wasm.step(dt);
  // thunder synthesis on each return stroke
  if (wasm.thunder_pending()) requestThunder();
  physMs = physMs * 0.9 + (performance.now() - t0) * 0.1;

  const stats = f32(wasm.stats_ptr(), 24);
  const light = f32(wasm.light_ptr(), 8);
  const segs = f32(wasm.seg_ptr(), Math.max(1, n) * 8);
  const gIdx = stats[23];
  let gInt = 0;
  if (gIdx >= 0 && light[7] > 0) gInt = Math.pow(light[7] / 10000, 4) * 0.02 * (stats[0] === 2 || stats[0] === 5 || stats[0] === 3 ? 1 : 0);

  // thunder ETA bookkeeping
  if (stats[0] === 2 && (stats[1] !== state.lastStroke || stats[18] !== state.lastFlash)) {
    state.lastStroke = stats[1]; state.lastFlash = stats[18];
    const d = v3.len(v3.sub([stats[9], stats[10], stats[11]], cam.eye));
    state.strikeDist = d;
    state.thunderETA.push(state.time + d / 343);
  }
  state.thunderETA = state.thunderETA.filter((t) => t > state.time - 0.5);

  renderer.render({
    eye: cam.eye, target: cam.look, fov: state.fov, time: state.time,
    light, ground: [stats[9], stats[10] + 2, stats[11], gInt],
    tower: stats[17] > 0 ? [stats[15], stats[16], stats[17]] : null,
    segs, segCount: n, cloudBase: CLOUD_BASE, cloudTop: CLOUD_TOP, ambient: state.ambient, flashK: state.flashK,
    exposure: state.exposure, bloom: state.bloom, bloomRadius: state.bloomRadius, coreWidth: state.coreWidth, boltGain: state.boltGain, rain: state.rain,
  });

  hudT -= dt;
  if (hudT <= 0) { hudT = 0.1; updateHUD(stats, n); }
}

function sci(x) { if (!isFinite(x) || x <= 0) return '—'; const e = Math.floor(Math.log10(x)); return (x / 10 ** e).toFixed(2) + '×10' + sup(e); }
function sup(e) { const m = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' }; return String(e).split('').map((c) => m[c]).join(''); }

function updateHUD(st, n) {
  const ph = st[0] | 0;
  $('#h-phase').textContent = PHASES[ph];
  $('#h-phase').dataset.phase = ph;
  $('#h-stroke').textContent = ph >= 2 ? `${Math.min(st[1] + 1, st[2]) | 0} / ${st[2] | 0}` : `— / ${st[2] | 0}`;
  $('#h-ipk').textContent = st[3] > 0 ? st[3].toFixed(1) + ' kA' : '—';
  $('#h-temp').textContent = st[4] > 0 ? Math.round(st[4]).toLocaleString() + ' K' : '—';
  const tm = Math.max(0, Math.min(1, (st[4] - wasm.lut_tmin()) / (wasm.lut_tmax() - wasm.lut_tmin())));
  $('#lut-mark').style.left = (tm * 100).toFixed(1) + '%';
  $('#lut-mark').style.opacity = st[4] > 900 ? 1 : 0.2;
  $('#h-field').textContent = st[5] > 0 ? (st[5] / 1000).toFixed(0) + ' kV/m' : '—';
  $('#h-fn').textContent = sci(st[7]) + ' A/m²';
  $('#h-alt').textContent = ph === 1 ? Math.round(st[6]) + ' m' : '—';
  $('#h-len').textContent = st[13] > 0 ? (st[13] / 1000).toFixed(2) + ' km' : '—';
  $('#h-nodes').textContent = (st[8] | 0) + ' cells · ' + n + ' segs';
  const eta = state.thunderETA.length ? state.thunderETA[state.thunderETA.length - 1] - state.time : -1;
  $('#h-dist').textContent = state.strikeDist > 0 ? (state.strikeDist / 1000).toFixed(2) + ' km' : '—';
  $('#h-thunder').textContent = eta > 0 ? `arrives in ${eta.toFixed(1)} s` : (state.strikeDist > 0 ? 'heard' : '—');
  $('#h-next').textContent = ph === 0 ? `next flash ≈ ${Math.max(0, st[22]).toFixed(1)} s` : '';
  $('#h-perf').textContent = `${fps.toFixed(0)} fps · physics ${physMs.toFixed(2)} ms · WASM+SIMD`;
}

// ------------------------------------------------------------------ boot
async function boot() {
  try {
    renderer = new Renderer($('#view'));
  } catch (e) {
    $('#start-msg').textContent = 'Error: ' + e.message;
    return;
  }
  audio = new AudioEngine();
  try { await loadWasm(); } catch (e) { $('#start-msg').textContent = 'Could not load lightning.wasm: ' + e.message; return; }
  initSim();
  buildPanel();
  setupInput();
  $('#btn-strike').onclick = strike;
  $('#btn-cam').onclick = cycleCamera;
  $('#btn-mic').onclick = toggleMic;
  $('#btn-fs').onclick = toggleFullscreen;
  $('#btn-panel').onclick = togglePanel;
  $('#btn-pause').onclick = togglePause;
  $('#btn-pad').onclick = () => document.body.classList.toggle('show-pads');
  $('#btn-reset').onclick = resetCamera;
  $('#sel-cam').onchange = (e) => setCamera(e.target.value);
  if (matchMedia('(pointer: coarse)').matches) document.body.classList.add('show-pads', 'panel-hidden');
  const go = async (withAudio) => {
    $('#start').classList.add('gone');
    if (withAudio) { try { await audio.start(); audio.setVolume(state.volume); audio.setRain(state.rain); } catch (e) { console.warn(e); } }
    updateAudioInfo();
  };
  $('#start-go').onclick = () => go(true);
  $('#start-fs').onclick = () => { toggleFullscreen(); go(true); };
  $('#start-mute').onclick = () => go(false);
  $('#start-msg').textContent = renderer.floatOK ? 'Ready.' : 'Ready (no float render targets — reduced HDR).';
  setCamera('orbit');
  requestAnimationFrame((t) => { last = t; frame(t); });
  window.__lm = { wasm, state, cam, setCamera, strike, audio };
}
boot();
