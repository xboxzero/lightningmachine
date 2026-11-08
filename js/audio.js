// Instant lightning sound: each strike plays a synthesised thunder crack right away
// (no distance delay, nothing scheduled ahead), re-strikes add short crackles.
// The microphone is analysed only (never played back).
export class Sound {
  constructor() { this.ctx = null; this.mic = null; this.level = 0; this.slow = 0; this.lastOnset = 0; this.lastCrack = 0; }

  async start() {
    if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    const c = (this.ctx = new AC({ latencyHint: 'interactive' }));
    this.master = c.createGain(); this.master.gain.value = 0.7;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -12; comp.ratio.value = 6; comp.attack.value = 0.002; comp.release.value = 0.2;
    this.master.connect(comp).connect(c.destination);
    // shared noise buffers (white + brown) for cracks and rumble
    const n = c.sampleRate * 3;
    this.white = c.createBuffer(1, n, c.sampleRate);
    this.brown = c.createBuffer(1, n, c.sampleRate);
    const wd = this.white.getChannelData(0), bd = this.brown.getChannelData(0);
    let b = 0;
    for (let i = 0; i < n; i++) { const x = Math.random() * 2 - 1; wd[i] = x; b = (b + 0.02 * x) / 1.02; bd[i] = b * 3.5; }
  }

  setVolume(v) { if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }

  /** Glass-chamber acoustics: early reflections off the walls + a dark diffuse tail. */
  _chamber() {
    if (this.room) return this.room;
    const c = this.ctx, len = Math.floor(c.sampleRate * 1.6), ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      // discrete early reflections (walls, floor, ceiling, back glass)
      for (const [ms, g] of [[7, 0.6], [11, 0.5], [17, 0.42], [23, 0.35], [31, 0.3], [43, 0.24], [59, 0.18]]) {
        const i = Math.floor((ms + (ch ? 1.7 : 0)) * c.sampleRate / 1000);
        if (i < len) d[i] += g * (Math.random() < 0.5 ? -1 : 1);
      }
      let y = 0;
      for (let i = 0; i < len; i++) {
        const tt = i / c.sampleRate;
        y += 0.25 * ((Math.random() * 2 - 1) - y);          // darker than white noise
        d[i] += y * 0.5 * Math.exp(-tt / 0.45) * Math.min(1, tt / 0.02);
      }
    }
    const conv = c.createConvolver(); conv.buffer = ir;
    const wet = c.createGain(); wet.gain.value = 0.45;
    conv.connect(wet).connect(this.master);
    this.room = conv;
    return conv;
  }

  /** Thunder: sharp crack + rolling rumble as a 3-D (HRTF) source that glides from `from`
   *  to `to` (eye-relative km) while it rumbles — it moves around inside the chamber. */
  thunder(power = 1, from = [0, 0, -1], to = from) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const out = c.createPanner();
    out.panningModel = 'HRTF'; out.distanceModel = 'inverse'; out.refDistance = 1.2; out.rolloffFactor = 0.6;
    const dur0 = 1.6 + Math.random() * 1.4;
    if (out.positionX) {
      out.positionX.setValueAtTime(from[0], t); out.positionY.setValueAtTime(from[1], t); out.positionZ.setValueAtTime(from[2], t);
      out.positionX.linearRampToValueAtTime(to[0], t + dur0); out.positionY.linearRampToValueAtTime(to[1], t + dur0); out.positionZ.linearRampToValueAtTime(to[2], t + dur0);
    } else out.setPosition(from[0], from[1], from[2]);
    out.connect(this.master);
    out.connect(this._chamber());
    // snap
    const s = c.createBufferSource(); s.buffer = this.white;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    const sf = c.createBiquadFilter(); sf.type = 'lowpass';
    sf.frequency.setValueAtTime(9000, t); sf.frequency.exponentialRampToValueAtTime(400, t + 0.35);
    const sg = c.createGain();
    sg.gain.setValueAtTime(0.0001, t); sg.gain.exponentialRampToValueAtTime(0.9 * power, t + 0.004);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    s.connect(sf).connect(sg).connect(out);
    s.start(t, Math.random() * 2); s.stop(t + 0.5);
    // rumble with irregular amplitude (several overlapping claps)
    const r = c.createBufferSource(); r.buffer = this.brown;
    const rf = c.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = 180 + Math.random() * 120;
    const rg = c.createGain();
    const dur = dur0;
    rg.gain.setValueAtTime(0.0001, t);
    rg.gain.exponentialRampToValueAtTime(1.0 * power, t + 0.03);
    let tt = t + 0.03;
    while (tt < t + dur - 0.2) {
      tt += 0.08 + Math.random() * 0.25;
      rg.gain.exponentialRampToValueAtTime(Math.max(0.001, power * (0.15 + Math.random() * 0.8) * (1 - (tt - t) / dur)), tt);
    }
    rg.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    r.connect(rf).connect(rg).connect(out);
    r.start(t, Math.random()); r.stop(t + dur + 0.05);
  }

  /** Short electric crackle for re-strikes. */
  crackle(power = 0.5) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    if (t - this.lastCrack < 0.03) return;
    this.lastCrack = t;
    const s = c.createBufferSource(); s.buffer = this.white;
    const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2500;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35 * power, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random() * 2); s.stop(t + 0.1);
  }

  async enableMic() {
    await this.start();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
    const src = this.ctx.createMediaStreamSource(stream);
    const an = this.ctx.createAnalyser(); an.fftSize = 1024;
    src.connect(an);
    this.mic = { stream, src, an, buf: new Float32Array(an.fftSize) };
  }
  disableMic() {
    if (!this.mic) return;
    this.mic.stream.getTracks().forEach((t) => t.stop());
    this.mic.src.disconnect();
    this.mic = null; this.level = 0;
  }

  /** { level 0..1, onset } — onset = sudden loud sound (clap, shout). */
  analyse(now) {
    if (!this.mic) return { level: 0, onset: false };
    const { an, buf } = this.mic;
    an.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    const lv = Math.min(1, Math.max(0, (20 * Math.log10(Math.sqrt(s / buf.length) + 1e-9) + 55) / 40));
    this.level = lv > this.level ? lv : this.level * 0.85 + lv * 0.15;
    this.slow = this.slow * 0.97 + lv * 0.03;
    let onset = false;
    if (lv > 0.45 && lv - this.slow > 0.25 && now - this.lastOnset > 0.35) { onset = true; this.lastOnset = now; }
    return { level: this.level, onset };
  }
}
