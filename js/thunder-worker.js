// Off-main-thread thunder synthesis: a second instance of the same Rust/WASM core turns a
// snapshot of the channel geometry into a planar multichannel pressure signal.
let w = null;
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    const inst = await WebAssembly.instantiate(m.module, {});
    w = inst.exports;
    w.init(16, 24, 16, m.seed >>> 0);
    self.postMessage({ type: 'ready' });
    return;
  }
  if (m.type === 'gen' && w) {
    const ptr = w.thunder_load(m.count, m.i0);
    new Float32Array(w.memory.buffer, ptr, m.count * 8).set(m.snap);
    w.set_listener(...m.listener);
    const frames = w.thunder_gen(m.ch, m.sr);
    const data = new Float32Array(w.memory.buffer, w.thunder_ptr(), frames * m.ch).slice();
    self.postMessage({ type: 'pcm', frames, ch: m.ch, sr: m.sr, t0: m.t0, offset: w.thunder_offset(), data }, [data.buffer]);
  }
};
