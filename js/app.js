import { Renderer } from './renderer.js';
import { Sound } from './audio.js';

const $ = (s) => document.querySelector(s);
// parameter ids — must match core/src/lib.rs
const P = { mode: 0, arcs: 1, reach: 2, branch: 3, speed: 4, temp: 5, rate: 6, mic: 7, jag: 8, glow: 9 };

let wasm, renderer;
const sound = new Sound();
const ui = { gain: 1, thickness: 1, bloom: 1.0, rate: 60, temp: 26000, vol: 0.6, soundOn: false, micOn: false };
const ptr = { x: 0, y: 0, down: false };

const f32 = (p, n) => new Float32Array(wasm.memory.buffer, p, n);

const controls = [
  { id: 'arcs', label: 'Arcs', min: 1, max: 30, step: 1, v: 10, p: P.arcs },
  { id: 'reach', label: 'Reach', min: 0.1, max: 1.2, step: 0.01, v: 0.55, p: P.reach },
  { id: 'branch', label: 'Branching', min: 0, max: 1.5, step: 0.01, v: 0.5, p: P.branch },
  { id: 'jag', label: 'Jaggedness', min: 0.1, max: 1.2, step: 0.01, v: 0.55, p: P.jag },
  { id: 'speed', label: 'Movement speed', min: 0, max: 4, step: 0.05, v: 1, p: P.speed },
  { id: 'rate', label: 'Firing rate (Hz)', min: 5, max: 200, step: 1, v: 60, p: P.rate, ui: 'rate' },
  { id: 'temp', label: 'Temperature (K)', min: 3000, max: 40000, step: 100, v: 26000, p: P.temp, ui: 'temp' },
  { id: 'glow', label: 'Afterglow (ms)', min: 3, max: 200, step: 1, v: 40, p: P.glow },
  { id: 'gain', label: 'Brightness', min: 0.1, max: 3, step: 0.01, v: 1, ui: 'gain' },
  { id: 'thickness', label: 'Thickness', min: 0.3, max: 3, step: 0.05, v: 1, ui: 'thickness' },
  { id: 'vol', label: 'Volume', min: 0, max: 1.5, step: 0.01, v: 0.6, ui: 'vol', fn: (x) => sound.setVolume(x) },
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
      if (c.p !== undefined) wasm.set_param(c.p, x);
      if (c.ui) ui[c.ui] = x;
      if (c.fn) c.fn(x);
      if (c.id === 'temp') updateSwatch(x);
    };
    inp.addEventListener('input', apply);
    apply();
  }
}

function updateSwatch(T) {
  const c = renderer.colorAt(T).map((v) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)));
  $('#v-temp').style.color = `rgb(${c})`;
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
  if (!ui.soundOn) sound.update(0, ui.rate, 0);
  $('#btn-sound').classList.toggle('on', ui.soundOn);
  $('#btn-sound').textContent = ui.soundOn ? '🔊' : '🔈';
}
async function toggleMic() {
  if (ui.micOn) { sound.disableMic(); ui.micOn = false; wasm.set_param(P.mic, 0); wasm.set_param(P.rate, ui.rate); $('#mic-bar').style.transform = 'scaleX(0)'; }
  else {
    try { await sound.enableMic(); ui.micOn = true; if (!ui.soundOn) await toggleSound(); }
    catch (e) { alert('Microphone unavailable: ' + e.message); }
  }
  $('#btn-mic').classList.toggle('on', ui.micOn);
}
function setMode(m) {
  wasm.set_param(P.mode, m);
  document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('on', +b.dataset.mode === m));
}

function setupInput() {
  const cv = renderer.canvas;
  const pos = (e) => { const d = renderer.dpr || 1; ptr.x = e.clientX * d; ptr.y = e.clientY * d; };
  cv.addEventListener('pointerdown', (e) => { pos(e); ptr.down = true; cv.setPointerCapture(e.pointerId); poke(); });
  cv.addEventListener('pointermove', (e) => { pos(e); poke(); });
  const up = () => { ptr.down = false; };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  window.addEventListener('mousemove', poke);
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    poke();
    if (e.code === 'KeyF') toggleFullscreen();
    if (e.code === 'KeyH' || e.code === 'Escape') togglePanel(e.code === 'Escape' ? false : undefined);
    if (e.code === 'KeyS') toggleSound();
    if (e.code === 'KeyM') toggleMic();
    if (e.code === 'Digit1') setMode(0);
    if (e.code === 'Digit2') setMode(1);
    if (e.code === 'Digit3') setMode(2);
  });
  $('#btn-menu').onclick = () => togglePanel();
  $('#btn-close').onclick = () => togglePanel(false);
  $('#btn-fs').onclick = toggleFullscreen;
  $('#btn-sound').onclick = toggleSound;
  $('#btn-mic').onclick = toggleMic;
  document.querySelectorAll('#modes button').forEach((b) => (b.onclick = () => setMode(+b.dataset.mode)));
}

// ---------------------------------------------------------------- frame loop
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const [w, h] = renderer.resize();
  wasm.set_view(w, h);
  wasm.set_pointer(ptr.x, ptr.y, ptr.down ? 1 : 0);
  let rate = ui.rate;
  if (ui.micOn) {
    const m = sound.analyse();
    wasm.set_param(P.mic, m.level);
    if (m.pitch > 0) rate = m.pitch;           // sing → the coil fires at your pitch
    wasm.set_param(P.rate, Math.min(rate, 200));
    $('#mic-bar').style.transform = `scaleX(${m.level.toFixed(3)})`;
  }
  const n = wasm.step(dt);
  const info = f32(wasm.info_ptr(), 16);
  const act = Math.min(1.5, Math.log1p(info[6]) * 0.45);
  const orbs = [[info[0], info[1], info[4]]];
  if (info[5] > 1.5) orbs.push([info[2], info[3], info[4]]);
  const col = renderer.colorAt(ui.temp);
  renderer.render({
    segs: f32(wasm.seg_ptr(), Math.max(1, n) * 8), segCount: n, orbs, orbColor: col, time: now / 1000,
    activity: act, gain: ui.gain, thickness: ui.thickness, bloom: ui.bloom,
    room: col.map((c) => c * act * 0.025), lightPos: [info[7] / w, 1 - info[8] / h],
  });
  if (ui.soundOn) sound.update(act, rate, info[9]);
  requestAnimationFrame(frame);
}

async function boot() {
  try { renderer = new Renderer($('#view')); }
  catch (e) { document.body.insertAdjacentHTML('beforeend', `<p class="err">${e.message}</p>`); return; }
  const { instance } = await WebAssembly.instantiateStreaming
    ? await WebAssembly.instantiateStreaming(fetch('lightning.wasm'), {}).catch(async () => WebAssembly.instantiate(await (await fetch('lightning.wasm')).arrayBuffer(), {}))
    : await WebAssembly.instantiate(await (await fetch('lightning.wasm')).arrayBuffer(), {});
  wasm = instance.exports;
  wasm.init((Math.random() * 2 ** 31) >>> 0);
  renderer.setLUT(f32(wasm.lut_ptr(), wasm.lut_len() * 3).slice(), wasm.lut_len(), wasm.lut_tmin(), wasm.lut_tmax());
  buildPanel();
  setupInput();
  setMode(0);
  poke();
  window.__lm = { wasm, setMode, togglePanel };
  requestAnimationFrame((t) => { last = t; frame(t); });
}
boot();
