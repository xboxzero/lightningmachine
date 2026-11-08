// Real-time Tesla-coil sound: the buzz pitch is the interrupter (firing) rate and its
// loudness follows arc activity every frame, so there is no audible delay.
// The microphone is analysed only (never played back): loudness → arc power,
// sung pitch (autocorrelation) → firing rate, like a "singing" Tesla coil.
export class Sound {
  constructor() { this.ctx = null; this.mic = null; this.level = 0; this.pitch = 0; this.slow = 0; }

  async start() {
    if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    const c = (this.ctx = new AC({ latencyHint: 'interactive' }));
    this.master = c.createGain(); this.master.gain.value = 0.6;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -10; comp.ratio.value = 8; comp.attack.value = 0.001; comp.release.value = 0.1;
    this.master.connect(comp).connect(c.destination);
    // buzz: pulse-like waveform at the firing rate, hard-clipped like a spark gap
    this.osc = c.createOscillator(); this.osc.type = 'sawtooth'; this.osc.frequency.value = 60;
    const shaper = c.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(x * 6) * (x > 0 ? 1 : 0.6); }
    shaper.curve = curve;
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 50;
    this.buzzGain = c.createGain(); this.buzzGain.gain.value = 0;
    this.osc.connect(shaper).connect(hp).connect(this.buzzGain).connect(this.master);
    this.osc.start();
    // crackle: white noise, high-passed, gated per frame by spark activity
    const len = c.sampleRate, nb = c.createBuffer(1, len, c.sampleRate), d = nb.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const ns = c.createBufferSource(); ns.buffer = nb; ns.loop = true;
    const bp = c.createBiquadFilter(); bp.type = 'highpass'; bp.frequency.value = 2500;
    this.crackGain = c.createGain(); this.crackGain.gain.value = 0;
    ns.connect(bp).connect(this.crackGain).connect(this.master);
    ns.start();
  }

  setVolume(v) { if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }

  /** Called every frame: activity 0..1+, rate = firing rate (Hz). */
  update(activity, rate, fired) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, a = Math.min(1.2, activity);
    this.osc.frequency.setTargetAtTime(rate, t, 0.01);
    this.buzzGain.gain.setTargetAtTime(a * 0.22, t, 0.008);
    this.crackGain.gain.setTargetAtTime(a * 0.05 * (0.4 + Math.random() * Math.min(1, fired / 3)), t, 0.004);
  }

  async enableMic() {
    await this.start();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
    const src = this.ctx.createMediaStreamSource(stream);
    const an = this.ctx.createAnalyser(); an.fftSize = 2048;
    src.connect(an);
    this.mic = { stream, src, an, buf: new Float32Array(an.fftSize) };
  }
  disableMic() {
    if (!this.mic) return;
    this.mic.stream.getTracks().forEach((t) => t.stop());
    this.mic.src.disconnect();
    this.mic = null; this.level = 0; this.pitch = 0;
  }

  /** Returns { level 0..1, pitch Hz (0 = none) }. */
  analyse() {
    if (!this.mic) return { level: 0, pitch: 0 };
    const { an, buf } = this.mic;
    an.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    const rms = Math.sqrt(s / buf.length);
    const lv = Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-9) + 55) / 40));
    this.level = lv > this.level ? lv : this.level * 0.85 + lv * 0.15; // fast attack, short release
    // pitch by normalised autocorrelation (70 Hz .. 1000 Hz)
    let pitch = 0;
    if (rms > 0.01) {
      const sr = this.ctx.sampleRate, n = 1024;
      const minLag = Math.floor(sr / 1000), maxLag = Math.floor(sr / 70);
      let best = 0, bestLag = 0;
      for (let lag = minLag; lag <= maxLag; lag++) {
        let c = 0, e1 = 0, e2 = 0;
        for (let i = 0; i < n; i++) { const x = buf[i], y = buf[i + lag]; c += x * y; e1 += x * x; e2 += y * y; }
        const r = c / Math.sqrt(e1 * e2 + 1e-12);
        if (r > best) { best = r; bestLag = lag; }
      }
      if (best > 0.8) pitch = sr / bestLag;
    }
    this.pitch = pitch;
    return { level: this.level, pitch };
  }
}
