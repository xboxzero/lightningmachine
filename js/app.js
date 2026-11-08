import { Renderer } from './renderer.js';
import { Sound } from './audio.js';

const $ = (s) => document.querySelector(s);
// parameter ids — must match core/src/lib.rs
const P = { bolts: 0, flow: 1, vort: 2, crackle: 3, branch: 4, temp: 5, life: 6, mic: 7, tension: 8, restrike: 9 };

let wasm, renderer;
const sound = new Sound();
const ui = { temp: 30000, gain: 1, thickness: 1, bloom: 1.0, vol: 0.7, style: 0, soundOn: false, micOn: false };
const ptr = { x: 0, y: 0, down: false };

const f32 = (p, n) => new Float32Array(wasm.memory.buffer, p, n);

const controls = [
  { id: 'bolts', label: 'Bolts', min: 1, max: 16, step: 1, v: 5, p: P.bolts },
  { id: 'flow', label: 'Flow speed', min: 0, max: 3, step: 0.05, v: 1, p: P.flow },
  { id: 'vort', label: 'Swirls', min: 1, max: 20, step: 1, v: 8, p: P.vort },
  { id: 'tension', label: 'Smoothness (surface tension)', min: 0, max: 1, step: 0.01, v: 0.3, p: P.tension },
  { id: 'crackle', label: 'Crackle', min: 0, max: 1.5, step: 0.01, v: 0.6, p: P.crackle },
  { id: 'branch', label: 'Branching', min: 0, max: 1.5, step: 0.01, v: 0.6, p: P.branch },
  { id: 'restrike', label: 'Re-strikes / s', min: 0, max: 4, step: 0.05, v: 0.6, p: P.restrike },
  { id: 'life', label: 'Bolt lifetime (s)', min: 2, max: 30, step: 0.5, v: 9, p: P.life },
  { id: 'temp', label: 'Temperature (K)', min: 3000, max: 40000, step: 100, v: 30000, p: P.temp, ui: 'temp' },
  { id: 'gain', label: 'Brightness', min: 0.1, max: 3, step: 0.01, v: 1, ui: 'gain' },
  { id: 'thickness', label: 'Thickness', min: 0.3, max: 3, step: 0.05, v: 1, ui: 'thickness' },
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
// liquid looks read best smooth; lightning wants crackle
const STYLE_PRESET = { 0: { crackle: 0.6, tension: 0.3, bloom: 1.0 }, 1: { crackle: 0.12, tension: 0.7, bloom: 0.35 }, 2: { crackle: 0.12, tension: 0.7, bloom: 0.45 } };
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

function setupInput() {
  const cv = renderer.canvas;
  const pos = (e) => { const d = renderer.dpr || 1; ptr.x = e.clientX * d; ptr.y = e.clientY * d; };
  cv.addEventListener('pointerdown', (e) => {
    pos(e); ptr.down = true; cv.setPointerCapture(e.pointerId); poke();
    wasm.set_pointer(ptr.x, ptr.y, 1);
    wasm.strike_at(ptr.x, ptr.y); // tap = new bolt from your finger, drag = stir the flow
  });
  cv.addEventListener('pointermove', (e) => { pos(e); poke(); });
  const up = () => { ptr.down = false; };
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
  wasm.set_view(w, h);
  wasm.set_pointer(ptr.x, ptr.y, ptr.down ? 1 : 0);
  if (ui.micOn) {
    const m = sound.analyse(now / 1000);
    wasm.set_param(P.mic, m.level);
    if (m.onset) wasm.strike();
    $('#mic-bar').style.transform = `scaleX(${m.level.toFixed(3)})`;
  }
  const n = wasm.step(dt);
  const info = f32(wasm.info_ptr(), 16);
  const act = Math.min(1.5, Math.log1p(info[2]) * 0.45);
  if (ui.soundOn) {
    const pan = info[3] / w * 2 - 1;
    for (let i = 0; i < Math.min(2, info[0]); i++) sound.thunder(0.8 + Math.random() * 0.4, pan);
    if (info[1] > 0) sound.crackle(0.6);
  }
  const col = renderer.colorAt(ui.temp);
  renderer.render({
    segs: f32(wasm.seg_ptr(), Math.max(1, n) * 8), segCount: n, time: now / 1000, style: ui.style,
    gain: ui.gain, thickness: ui.thickness, bloom: ui.bloom,
    room: col.map((c) => c * act * (ui.style === 0 ? 0.03 : 0.012)), lightPos: [info[3] / w, 1 - info[4] / h],
  });
  requestAnimationFrame(frame);
}

async function boot() {
  try { renderer = new Renderer($('#view')); }
  catch (e) { document.body.insertAdjacentHTML('beforeend', `<p class="err">${e.message}</p>`); return; }
  const bytes = await (await fetch('lightning.wasm')).arrayBuffer();
  wasm = (await WebAssembly.instantiate(bytes, {})).instance.exports;
  wasm.init((Math.random() * 2 ** 31) >>> 0);
  renderer.setLUT(f32(wasm.lut_ptr(), wasm.lut_len() * 3).slice(), wasm.lut_len(), wasm.lut_tmin(), wasm.lut_tmax());
  buildPanel();
  setupInput();
  setStyle(0);
  poke();
  window.__lm = { wasm, setStyle, togglePanel };
  requestAnimationFrame((t) => { last = t; frame(t); });
}
boot();
