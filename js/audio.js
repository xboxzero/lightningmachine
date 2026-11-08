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

  /** Thunder crack: sharp broadband snap + low rumble, panned to where the bolt is. */
  thunder(power = 1, pan = 0) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const out = c.createStereoPanner ? c.createStereoPanner() : c.createGain();
    if (out.pan) out.pan.value = Math.max(-1, Math.min(1, pan));
    out.connect(this.master);
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
    const dur = 1.6 + Math.random() * 1.4;
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
