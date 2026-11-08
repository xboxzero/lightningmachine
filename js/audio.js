// Web Audio: surround thunder playback (buffers synthesised in WebAssembly), rain ambience,
// output layout handling (stereo / 5.1 discrete) and microphone analysis.
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.layout = 'auto';
    this.mic = null;
    this.level = 0; this.slow = 0; this.pitch = 0.5; this.centroid = 0;
    this.lastOnset = 0;
    this.voices = [];
  }

  async start() {
    if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    const c = this.ctx;
    this.master = c.createGain();
    this.master.gain.value = 0.8;
    this.limiter = c.createDynamicsCompressor();
    this.limiter.threshold.value = -6; this.limiter.knee.value = 4; this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.002; this.limiter.release.value = 0.25;
    this.limiter.connect(c.destination);
    this.applyLayout(this.layout);
    // rain: decorrelated stereo pink-ish noise, band-limited
    const len = c.sampleRate * 4, nb = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = nb.getChannelData(ch);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.12 * (Math.random() < 0.0009 ? 4 : 1);
      }
    }
    // thunder bus: 12 world-fixed directional stems → HRTF panners (3-D, follows the camera)
    this.stemBus = c.createGain(); this.stemBus.gain.value = 1.0;
    this.stemBus.connect(this.master);
    // outdoor reverberation: exponentially decaying noise that darkens over time (air absorption)
    const irLen = Math.floor(c.sampleRate * 3.5), ir = c.createBuffer(2, irLen, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let y = 0;
      for (let i = 0; i < irLen; i++) {
        const t = i / c.sampleRate;
        const a = Math.exp(-0.25 - 9 * t / 3.5);              // one-pole low-pass with falling cutoff
        y += (1 - a) * ((Math.random() * 2 - 1) - y);
        d[i] = y * Math.exp(-t / 0.9) * (t < 0.03 ? t / 0.03 : 1);
      }
    }
    this.reverb = c.createConvolver(); this.reverb.buffer = ir;
    this.reverbGain = c.createGain(); this.reverbGain.gain.value = 0.55;
    this.stemBus.connect(this.reverb).connect(this.reverbGain).connect(this.master);
    this.stemDirs = [];
    for (let k = 0; k < 8; k++) { const az = k * Math.PI / 4, el = 10 * Math.PI / 180; this.stemDirs.push([Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)]); }
    for (let j = 0; j < 4; j++) { const az = Math.PI / 4 + j * Math.PI / 2, el = 55 * Math.PI / 180; this.stemDirs.push([Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)]); }
    const src = c.createBufferSource(); src.buffer = nb; src.loop = true;
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 400;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7000;
    this.rainGain = c.createGain(); this.rainGain.gain.value = 0.18;
    src.connect(hp).connect(lp).connect(this.rainGain).connect(this.master);
    src.start();
  }

  get channels() {
    if (!this.ctx) return 2;
    return this.ctx.destination.channelCount >= 6 ? 6 : 2;
  }

  applyLayout(mode) {
    this.layout = mode;
    if (!this.ctx) return;
    const d = this.ctx.destination;
    const max = d.maxChannelCount || 2;
    const want = mode === '5.1' || (mode === 'auto' && max >= 6) ? 6 : 2;
    try {
      d.channelCount = Math.min(want, max);
      d.channelInterpretation = 'speakers';
      this.master.channelCount = d.channelCount; this.master.channelCountMode = 'explicit';
      this.master.disconnect();
      // DynamicsCompressorNode is limited to 2 channels: keep 5.1 discrete by bypassing it.
      if (d.channelCount > 2) this.master.connect(d); else this.master.connect(this.limiter);
    } catch (e) { console.warn('layout', e); }
  }

  setVolume(v) { if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }
  setRain(v) { if (this.rainGain) this.rainGain.gain.setTargetAtTime(v * 0.3, this.ctx.currentTime, 0.2); }

  /** Play planar float data (channels × frames) produced by the WASM thunder synthesiser.
   *  `t0` is the audio-clock time of the stroke: playback skips whatever synthesis latency
   *  elapsed, so sound stays locked to distance / speed-of-sound. */
  playThunder(data, channels, frames, sampleRate, t0) {
    if (!this.ctx || frames < 16) return;
    const buf = this.ctx.createBuffer(channels, frames, sampleRate);
    for (let ch = 0; ch < channels; ch++) buf.copyToChannel(data.subarray(ch * frames, (ch + 1) * frames), ch);
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.channelCount = channels; s.channelCountMode = 'explicit'; s.channelInterpretation = 'speakers';
    s.connect(this.master);
    const late = t0 !== undefined ? Math.max(0, this.ctx.currentTime - t0) : 0;
    s.start(0, Math.min(late, buf.duration));
    this.voices.push(s);
    s.onended = () => { this.voices = this.voices.filter((v) => v !== s); };
  }

  /** Turn the listener with the camera (thunder stems are fixed in the world). */
  setListener(fwd, up) {
    if (!this.ctx) return;
    const L = this.ctx.listener, t = this.ctx.currentTime;
    const n = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1;
    const f = [fwd[0] / n, fwd[1] / n, fwd[2] / n];
    if (L.forwardX) {
      L.forwardX.setTargetAtTime(f[0], t, 0.02); L.forwardY.setTargetAtTime(f[1], t, 0.02); L.forwardZ.setTargetAtTime(f[2], t, 0.02);
      L.upX.setTargetAtTime(up[0], t, 0.02); L.upY.setTargetAtTime(up[1], t, 0.02); L.upZ.setTargetAtTime(up[2], t, 0.02);
    } else if (L.setOrientation) L.setOrientation(f[0], f[1], f[2], up[0], up[1], up[2]);
  }

  /** Play 12 directional thunder stems through HRTF panners, starting `offset` seconds
   *  after the stroke time t0 (sound travel time to the nearest part of the channel). */
  playThunderStems(data, frames, sampleRate, t0, offset) {
    if (!this.ctx || frames < 16) return;
    const c = this.ctx, NS = 12;
    const buf = c.createBuffer(NS, frames, sampleRate);
    for (let ch = 0; ch < NS; ch++) buf.copyToChannel(data.subarray(ch * frames, (ch + 1) * frames), ch);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.channelCount = NS; src.channelCountMode = 'explicit'; src.channelInterpretation = 'discrete';
    const split = c.createChannelSplitter(NS);
    src.connect(split);
    for (let k = 0; k < NS; k++) {
      const p = c.createPanner();
      p.panningModel = 'HRTF'; p.distanceModel = 'linear'; p.rolloffFactor = 0; p.refDistance = 1;
      const d = this.stemDirs[k];
      if (p.positionX) { p.positionX.value = d[0] * 10; p.positionY.value = d[1] * 10; p.positionZ.value = d[2] * 10; }
      else p.setPosition(d[0] * 10, d[1] * 10, d[2] * 10);
      split.connect(p, k).connect(this.stemBus);
    }
    const when = t0 + offset;
    if (when >= c.currentTime) src.start(when);
    else src.start(0, Math.min(buf.duration, c.currentTime - when));
    this.voices.push(src);
    src.onended = () => { this.voices = this.voices.filter((v) => v !== src); split.disconnect(); };
  }

  async enableMic() {
    await this.start();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    });
    const c = this.ctx;
    const src = c.createMediaStreamSource(stream);
    const an = c.createAnalyser();
    an.fftSize = 2048; an.smoothingTimeConstant = 0.3;
    src.connect(an); // analysis only — never routed to the speakers (no feedback)
    this.mic = { stream, src, an, td: new Float32Array(an.fftSize), fd: new Float32Array(an.frequencyBinCount) };
  }
  disableMic() {
    if (!this.mic) return;
    this.mic.stream.getTracks().forEach((t) => t.stop());
    this.mic.src.disconnect();
    this.mic = null;
    this.level = 0; this.slow = 0;
  }

  /** RMS level (dBFS → 0..1), spectral centroid (→ 0..1 on a log axis 100 Hz..4 kHz), onset. */
  analyseMic(now) {
    if (!this.mic) return { level: 0, pitch: 0.5, onset: false, db: -120, centroid: 0 };
    const { an, td, fd } = this.mic;
    an.getFloatTimeDomainData(td);
    let s = 0;
    for (let i = 0; i < td.length; i++) s += td[i] * td[i];
    const rms = Math.sqrt(s / td.length);
    const db = 20 * Math.log10(rms + 1e-9);
    const lv = Math.min(1, Math.max(0, (db + 58) / 46));
    this.level = lv > this.level ? lv : this.level * 0.9 + lv * 0.1;
    this.slow = this.slow * 0.97 + lv * 0.03;
    an.getFloatFrequencyData(fd);
    const binHz = this.ctx.sampleRate / an.fftSize;
    let num = 0, den = 0;
    for (let i = 2; i < fd.length; i++) { const m = Math.pow(10, fd[i] / 20); num += m * i * binHz; den += m; }
    const cen = den > 0 ? num / den : 0;
    this.centroid = cen;
    const pn = Math.min(1, Math.max(0, Math.log2(Math.max(cen, 100) / 100) / Math.log2(40)));
    this.pitch = this.pitch * 0.85 + pn * 0.15;
    let onset = false;
    if (lv > 0.45 && lv - this.slow > 0.28 && now - this.lastOnset > 1.5) { onset = true; this.lastOnset = now; }
    return { level: this.level, pitch: this.pitch, onset, db, centroid: cen };
  }
}
