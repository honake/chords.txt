// ---- Web Audio electric piano (FM) with tone presets & metronome ----
import type { Song } from './generate';
import { gridToBeats } from './generate';

function midiToFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function makeImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

// ---------- tone presets ----------

export type ToneId = 'grand' | 'suitcase' | 'neosoul' | 'wurli' | 'chip';

interface ToneDef {
  id: ToneId;
  name: string;
  desc: string;
  engine: 'ep' | 'analog' | 'piano' | 'chip' | 'sample';
  decayScale: number;  // amplitude decay multiplier
  release: number;     // note release seconds (pedal blend)
  filterBase: number;
  filterVel: number;
  tremDepth: number;
  tremRate: number;
  chorusWet: number;
  reverbWet: number;
  // ep engine
  indexBase?: number;  // FM index floor (× f)
  indexVel?: number;   // FM index velocity scaling (× f)
  indexDecay?: number; // seconds for the bark to fade
  tineRatio?: number;  // bell partial ratio
  tineGain?: number;
  warmGain?: number;   // detuned second layer
  wowRate?: number;    // tape wow (pitch wobble)
  wowDepth?: number;   // cents
  // analog engine
  oscType?: OscillatorType;
  partials?: number[];  // custom waveform harmonics (overrides oscType)
  detuneCents?: number;
  attack?: number;
  subGain?: number;     // -1 octave sine
  shimmerGain?: number; // +1 octave sine
}

export const TONES: ToneDef[] = [
  {
    // Salamander Grand Piano (Alexander Holm, CC-BY-3.0) via the Tone.js CDN.
    // Falls back to the FM engine until the samples finish loading.
    id: 'grand', name: 'Grand', desc: 'Sampled acoustic grand (Salamander)', engine: 'sample',
    indexBase: 0.2, indexVel: 1.2, indexDecay: 0.12,
    tineRatio: 4, tineGain: 0.04, decayScale: 1.1, release: 0.14,
    filterBase: 1200, filterVel: 5200, tremDepth: 0, tremRate: 4,
    chorusWet: 0, reverbWet: 0.16, warmGain: 0.4,
  },
  {
    id: 'suitcase', name: 'Suitcase', desc: 'Warm classic Rhodes', engine: 'ep',
    indexBase: 0.3, indexVel: 2.1, indexDecay: 0.1,
    tineRatio: 4, tineGain: 0.12, decayScale: 1.0, release: 0.16,
    filterBase: 850, filterVel: 4800, tremDepth: 0.24, tremRate: 4.2,
    chorusWet: 0.3, reverbWet: 0.18, warmGain: 0.38,
  },
  {
    // Serum recipe: sine osc, Warp = Bend +/- → "a saw with very rounded edges".
    // Reproduced as a harmonic series with a steep rolloff.
    id: 'neosoul', name: 'Neo Soul', desc: 'Rounded-saw neo-soul keys', engine: 'analog',
    partials: [1, 0.4, 0.2, 0.11, 0.065, 0.04, 0.026, 0.017],
    detuneCents: 5, attack: 0.008, subGain: 0.16, shimmerGain: 0,
    decayScale: 1.15, release: 0.26,
    filterBase: 1500, filterVel: 3600, tremDepth: 0.18, tremRate: 4.4,
    chorusWet: 0.26, reverbWet: 0.22,
  },
  {
    id: 'wurli', name: 'Wurli', desc: 'Barky vintage Wurlitzer', engine: 'ep',
    indexBase: 0.45, indexVel: 3.2, indexDecay: 0.055,
    tineRatio: 2, tineGain: 0.07, decayScale: 0.8, release: 0.1,
    filterBase: 1000, filterVel: 5600, tremDepth: 0.42, tremRate: 5.4,
    chorusWet: 0.12, reverbWet: 0.14, warmGain: 0.25,
  },
  {
    // NES: 25%-duty pulse for the right hand, triangle channel for the bass
    id: 'chip', name: '8-Bit', desc: 'NES-style pulse & triangle', engine: 'chip',
    decayScale: 1.0, release: 0.025,
    filterBase: 12000, filterVel: 0, tremDepth: 0, tremRate: 4,
    chorusWet: 0, reverbWet: 0.05,
  },
];

// ---------- sampled grand (lazy-loaded, shared across synth instances) ----------

const GRAND_BASE = 'https://tonejs.github.io/audio/salamander/';
const GRAND_NOTES: [string, number][] = [
  ['C2', 36], ['Ds2', 39], ['Fs2', 42], ['A2', 45],
  ['C3', 48], ['Ds3', 51], ['Fs3', 54], ['A3', 57],
  ['C4', 60], ['Ds4', 63], ['Fs4', 66], ['A4', 69],
  ['C5', 72], ['Ds5', 75], ['Fs5', 78], ['A5', 81],
  ['C6', 84], ['Ds6', 87],
];
const grandBuffers = new Map<number, AudioBuffer>();
let grandLoadStarted = false;

function loadGrand(ctx: AudioContext) {
  if (grandLoadStarted) return;
  grandLoadStarted = true;
  for (const [name, midi] of GRAND_NOTES) {
    fetch(GRAND_BASE + name + '.mp3')
      .then(r => r.arrayBuffer())
      .then(buf => ctx.decodeAudioData(buf))
      .then(decoded => { grandBuffers.set(midi, decoded); })
      .catch(() => { /* stay on the FM fallback for this note */ });
  }
}

class EPSynth {
  ctx: AudioContext;
  master: GainNode;
  input: GainNode;
  tone: ToneDef;
  private wave: PeriodicWave | null = null;
  private pulseWave: PeriodicWave | null = null;
  private noiseBuf: AudioBuffer | null = null;

  constructor(ctx: AudioContext, tone: ToneDef) {
    this.ctx = ctx;
    this.tone = tone;
    if (tone.engine === 'sample') loadGrand(ctx);
    if (tone.partials) {
      const n = tone.partials.length;
      const real = new Float32Array(n + 1);
      const imag = new Float32Array(n + 1);
      tone.partials.forEach((a, i) => { imag[i + 1] = a; });
      this.wave = ctx.createPeriodicWave(real, imag);
    }
    if (tone.engine === 'chip') {
      // 25%-duty pulse: b_n = (2 / nπ) · sin(nπ · 0.25)
      const N = 24;
      const real = new Float32Array(N + 1);
      const imag = new Float32Array(N + 1);
      for (let n = 1; n <= N; n++) {
        imag[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * 0.25);
      }
      this.pulseWave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    }
    if (tone.engine === 'piano') {
      const len = Math.floor(ctx.sampleRate * 0.05);
      this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }

    this.master = ctx.createGain();
    this.master.gain.value = 0.95;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 14;
    comp.ratio.value = 2.2;
    comp.attack.value = 0.008;
    comp.release.value = 0.3;
    // gentle air on top
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 6000;
    shelf.gain.value = 1.5;
    this.master.connect(shelf);
    shelf.connect(comp);
    comp.connect(ctx.destination);

    // --- stereo tremolo (auto-pan) ---
    this.input = ctx.createGain();
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const gL = ctx.createGain();
    const gR = ctx.createGain();
    gL.gain.value = 0.72;
    gR.gain.value = 0.72;
    this.input.connect(split);
    split.connect(gL, 0);
    split.connect(gR, 1);
    gL.connect(merge, 0, 0);
    gR.connect(merge, 0, 1);

    const lfo = ctx.createOscillator();
    lfo.frequency.value = tone.tremRate;
    const depth = ctx.createGain();
    depth.gain.value = tone.tremDepth;
    const inv = ctx.createGain();
    inv.gain.value = -1;
    lfo.connect(depth);
    depth.connect(gL.gain);
    depth.connect(inv);
    inv.connect(gR.gain);
    lfo.start();

    const post = ctx.createGain();
    merge.connect(post);

    const dry = ctx.createGain();
    dry.gain.value = 0.8;
    post.connect(dry);
    dry.connect(this.master);

    // two-voice chorus for width
    const mkChorus = (delayS: number, rate: number, pan: number) => {
      const d = ctx.createDelay(0.06);
      d.delayTime.value = delayS;
      const l = ctx.createOscillator();
      l.frequency.value = rate;
      const dep = ctx.createGain();
      dep.gain.value = 0.0038;
      l.connect(dep);
      dep.connect(d.delayTime);
      l.start();
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      const w = ctx.createGain();
      w.gain.value = tone.chorusWet * 0.5;
      post.connect(d);
      d.connect(p);
      p.connect(w);
      w.connect(this.master);
    };
    mkChorus(0.014, 0.5, -0.5);
    mkChorus(0.021, 0.35, 0.5);

    const convolver = ctx.createConvolver();
    convolver.buffer = makeImpulse(ctx, 2.2, 3.0);
    const wet = ctx.createGain();
    wet.gain.value = tone.reverbWet;
    post.connect(wet);
    wet.connect(convolver);
    convolver.connect(this.master);
  }

  note(midi: number, vel: number, when: number, dur: number, pan: number) {
    const ctx = this.ctx;
    const t = this.tone;
    const f = midiToFreq(midi);
    const v = Math.pow(vel / 127, 1.4);

    const out = ctx.createGain();
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan + (Math.random() - 0.5) * 0.1));
    out.connect(panner);
    panner.connect(this.input);

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.Q.value = 0.3;
    filt.connect(out);

    const end = when + dur;
    const stopAt = end + t.release * 6 + 0.4;
    const oscs: OscillatorNode[] = [];

    if (t.engine === 'sample' && grandBuffers.size > 0) {
      // nearest sample, repitched
      let base = 60;
      let bestDist = Infinity;
      for (const m of grandBuffers.keys()) {
        const dist = Math.abs(m - midi);
        if (dist < bestDist) { bestDist = dist; base = m; }
      }
      const src = ctx.createBufferSource();
      src.buffer = grandBuffers.get(base)!;
      src.playbackRate.value = Math.pow(2, (midi - base) / 12);
      filt.frequency.value = Math.min(12000, 2600 + v * 9000);
      src.connect(filt);
      const level = 0.85 * Math.pow(v, 1.4) + 0.03;
      const g = out.gain;
      g.setValueAtTime(level, when);
      g.cancelScheduledValues(end);
      g.setValueAtTime(level, end);
      g.setTargetAtTime(0.0001, end, 0.12);
      src.start(when);
      src.stop(stopAt + 1.5);
    } else if (t.engine === 'ep' || t.engine === 'sample') {
      filt.frequency.value = Math.min(12000, t.filterBase + v * t.filterVel + f * 2.0);

      // FM pair
      const carrier = ctx.createOscillator();
      carrier.type = 'sine';
      carrier.frequency.value = f;
      const mod = ctx.createOscillator();
      mod.type = 'sine';
      mod.frequency.value = f;
      const modGain = ctx.createGain();
      const index = f * (t.indexBase! + t.indexVel! * v);
      modGain.gain.setValueAtTime(index, when);
      modGain.gain.setTargetAtTime(f * 0.05, when + 0.005, t.indexDecay! + 0.04 * (1 - v));
      mod.connect(modGain);
      modGain.connect(carrier.frequency);
      const carrierGain = ctx.createGain();
      carrier.connect(carrierGain);
      carrierGain.connect(filt);

      // warm detuned layer
      const warm = ctx.createOscillator();
      warm.type = 'sine';
      warm.frequency.value = f;
      warm.detune.value = 3.2;
      const warmGain = ctx.createGain();
      warmGain.gain.value = t.warmGain ?? 0.35;
      warm.connect(warmGain);
      warmGain.connect(filt);

      // tine / bell partial
      const tine = ctx.createOscillator();
      tine.type = 'sine';
      tine.frequency.value = Math.min(9500, f * (midi < 57 ? t.tineRatio! + 2 : t.tineRatio!));
      const tineGain = ctx.createGain();
      tineGain.gain.setValueAtTime(t.tineGain! * v, when);
      tineGain.gain.setTargetAtTime(0.0001, when + 0.002, 0.05);
      tine.connect(tineGain);
      tineGain.connect(filt);

      // tape wow: slow pitch wobble
      if (t.wowDepth) {
        const wow = ctx.createOscillator();
        wow.frequency.value = t.wowRate ?? 1.0;
        wow.detune.value = Math.random() * 30; // desync per note
        const wowGain = ctx.createGain();
        wowGain.gain.value = t.wowDepth;
        wow.connect(wowGain);
        wowGain.connect(carrier.detune);
        wowGain.connect(warm.detune);
        oscs.push(wow);
      }

      const decayTau = Math.max(0.6, (4.6 - midi * 0.034) * t.decayScale);
      const peak = 0.19 * v + 0.02;
      const attack = 0.002 + (1 - v) * 0.006;
      const g = out.gain;
      g.setValueAtTime(0, when);
      g.linearRampToValueAtTime(peak, when + attack);
      g.setTargetAtTime(peak * 0.3, when + attack, decayTau);
      g.cancelScheduledValues(end);
      g.setTargetAtTime(0.0001, end, t.release);

      oscs.push(carrier, mod, warm, tine);
    } else if (t.engine === 'piano') {
      // bright attack sweeping darker; brightness follows velocity
      const cutoffPeak = Math.min(11500, t.filterBase + v * t.filterVel + f * 1.5);
      filt.frequency.setValueAtTime(cutoffPeak, when);
      filt.frequency.setTargetAtTime(
        Math.max(500, 600 + f * 1.8),
        when + 0.004,
        0.3 + 0.45 * (1 - v),
      );

      // two detuned string layers (slow beating)
      const det = t.detuneCents ?? 1.6;
      for (const [cents, gain] of [[-det, 0.5], [det, 0.45]] as const) {
        const o = ctx.createOscillator();
        if (this.wave) o.setPeriodicWave(this.wave);
        o.frequency.value = f;
        o.detune.value = cents;
        const og = ctx.createGain();
        og.gain.value = gain;
        o.connect(og);
        og.connect(filt);
        oscs.push(o);
      }

      // hammer noise transient
      if (this.noiseBuf) {
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuf;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = Math.min(8000, f * 2.5 + 400);
        bp.Q.value = 0.8;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.11 * v, when);
        ng.gain.setTargetAtTime(0.0001, when + 0.002, 0.012);
        src.connect(bp);
        bp.connect(ng);
        ng.connect(out);
        src.start(when);
        src.stop(when + 0.05);
      }

      // no sustain level — a piano just decays; dampers on note-off
      const decayTau = Math.max(0.45, (5.4 - midi * 0.05) * t.decayScale);
      const peak = 0.23 * v + 0.02;
      const g = out.gain;
      g.setValueAtTime(0, when);
      g.linearRampToValueAtTime(peak, when + 0.0015);
      g.setTargetAtTime(0.0001, when + 0.0015, decayTau);
      g.cancelScheduledValues(end);
      g.setTargetAtTime(0.0001, end, t.release);
    } else if (t.engine === 'chip') {
      filt.frequency.value = 12000;
      // NES: LH = triangle channel (fixed volume), RH = 25% pulse
      const isBass = pan < 0;
      const o = ctx.createOscillator();
      if (isBass) o.type = 'triangle';
      else if (this.pulseWave) o.setPeriodicWave(this.pulseWave);
      o.frequency.value = f;
      o.connect(filt);
      oscs.push(o);

      // 4-step quantized volume, blocky envelope, hard gate
      const vq = Math.ceil(Math.max(0.25, v) * 4) / 4;
      const peak = isBass ? 0.17 : 0.13 * vq;
      const g = out.gain;
      g.setValueAtTime(0, when);
      g.linearRampToValueAtTime(peak, when + 0.001);
      g.setValueAtTime(peak, when + 0.06);
      g.linearRampToValueAtTime(peak * 0.6, when + 0.09);
      g.cancelScheduledValues(end);
      g.setValueAtTime(peak * 0.6, end);
      g.linearRampToValueAtTime(0, end + 0.02);
    } else {
      // ---- analog engine: detuned oscillator stack through a breathing lowpass ----
      const cutoff = Math.min(9500, t.filterBase + v * t.filterVel + f * 1.2);
      filt.frequency.setValueAtTime(cutoff * 1.6, when);
      filt.frequency.setTargetAtTime(cutoff, when + (t.attack ?? 0.03), 0.28);

      const det = t.detuneCents ?? 8;
      const mkOsc = (type: OscillatorType | 'wave', freq: number, cents: number, gain: number) => {
        const o = ctx.createOscillator();
        if (type === 'wave' && this.wave) o.setPeriodicWave(this.wave);
        else o.type = type === 'wave' ? 'triangle' : type;
        o.frequency.value = freq;
        o.detune.value = cents;
        const g = ctx.createGain();
        g.gain.value = gain;
        o.connect(g);
        g.connect(filt);
        oscs.push(o);
        return o;
      };
      const type: OscillatorType | 'wave' = t.partials ? 'wave' : (t.oscType ?? 'sawtooth');
      mkOsc(type, f, 0, 0.38);
      mkOsc(type, f, det, 0.27);
      mkOsc(type, f, -det * 0.7, 0.27);
      if (t.subGain) mkOsc('sine', f / 2, 0, t.subGain);
      if (t.shimmerGain) mkOsc('sine', f * 2, det * 0.5, t.shimmerGain);

      const isSaw = type === 'sawtooth';
      const peak = (isSaw ? 0.12 : 0.17) * v + 0.015;
      const attack = (t.attack ?? 0.03) + (1 - v) * 0.015; // ホワンとした立ち上がり
      const decayTau = 5.5 * t.decayScale; // pad-like sustain
      const g = out.gain;
      g.setValueAtTime(0, when);
      g.linearRampToValueAtTime(peak, when + attack);
      g.setTargetAtTime(peak * 0.55, when + attack, decayTau);
      g.cancelScheduledValues(end);
      g.setTargetAtTime(0.0001, end, t.release);
    }

    for (const o of oscs) {
      o.start(when);
      o.stop(stopAt);
    }
  }
}

// ---------- metronome click ----------

function scheduleClick(ctx: AudioContext, when: number, accent: boolean, dest: AudioNode) {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = accent ? 1700 : 1150;
  const g = ctx.createGain();
  g.gain.setValueAtTime(accent ? 0.16 : 0.1, when);
  g.gain.setTargetAtTime(0.0001, when + 0.001, 0.018);
  osc.connect(g);
  g.connect(dest);
  osc.start(when);
  osc.stop(when + 0.12);
}

export class Player {
  private ctx: AudioContext | null = null;
  private synth: EPSynth | null = null;
  private clickBus: GainNode | null = null;
  private timer: number | null = null;
  private raf: number | null = null;
  private startTime = 0;
  private secPerBeat = 0.5;
  private totalBeats = 0;
  private song: Song | null = null;
  private nextEventIdx = 0;
  private schedule: { time: number; dur: number; midi: number; vel: number; pan: number }[] = [];
  private loop = false;
  private cycle = 0;
  private humanize = 0;
  private nextClickBeat = 0;
  private toneId: ToneId = 'suitcase';
  click = false;
  onPosition: (bar: number) => void = () => {};
  onStop: () => void = () => {};

  get playing() { return this.timer !== null; }

  setLooping(v: boolean) { this.loop = v; }

  setClick(v: boolean) { this.click = v; }

  /** Jump playback to the top of a bar (while playing). */
  seek(bar: number) {
    if (!this.ctx || !this.song || this.timer === null) return;
    const beats = Math.max(0, bar) * 4;
    this.cycle = 0;
    this.startTime = this.ctx.currentTime + 0.06 - beats * this.secPerBeat;
    this.nextEventIdx = this.schedule.findIndex(e => e.time >= beats * this.secPerBeat - 1e-6);
    if (this.nextEventIdx < 0) this.nextEventIdx = this.schedule.length;
    this.nextClickBeat = beats;
  }

  setTone(id: ToneId) {
    if (id === this.toneId) return;
    this.toneId = id;
    if (this.ctx && this.synth) {
      // fade the old graph, keep playing on the new tone
      const g = this.synth.master.gain;
      const t = this.ctx.currentTime;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0, t + 0.25);
      this.synth = new EPSynth(this.ctx, TONES.find(x => x.id === id) ?? TONES[0]);
    }
  }

  private ensureCtx() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.synth = new EPSynth(this.ctx, TONES.find(x => x.id === this.toneId) ?? TONES[0]);
      this.clickBus = this.ctx.createGain();
      this.clickBus.gain.value = 0.9;
      this.clickBus.connect(this.ctx.destination);
    }
  }

  start(song: Song, bpm: number, loop: boolean, fromBar = 0) {
    this.stop();
    if (song.events.length === 0 || song.bars.length === 0) return;
    this.ensureCtx();
    this.ctx!.resume();
    this.song = song;
    this.loop = loop;
    this.secPerBeat = 60 / bpm;
    this.totalBeats = song.bars.length * 4;
    this.cycle = 0;
    this.humanize = song.settings.humanize;
    this.nextClickBeat = 0;

    this.schedule = song.events
      .map(e => {
        const startBeat = gridToBeats(e.start, song.settings);
        const endBeat = gridToBeats(e.start + e.d, song.settings);
        return {
          time: startBeat * this.secPerBeat,
          dur: Math.max(0.07, (endBeat - startBeat) * this.secPerBeat - 0.02),
          midi: e.midi,
          vel: e.vel,
          pan: e.hand === 'lh' ? -0.22 : 0.18,
        };
      })
      .sort((a, b) => a.time - b.time);

    const fromBeats = Math.max(0, fromBar) * 4;
    this.startTime = this.ctx!.currentTime + 0.12 - fromBeats * this.secPerBeat;
    this.nextEventIdx = this.schedule.findIndex(e => e.time >= fromBeats * this.secPerBeat - 1e-6);
    if (this.nextEventIdx < 0) this.nextEventIdx = this.schedule.length;
    this.nextClickBeat = fromBeats;
    this.timer = window.setInterval(() => this.tick(), 30);
    this.tick();
    const uiTick = () => {
      if (!this.ctx || this.timer === null) return;
      const t = this.ctx.currentTime - this.startTime;
      const beats = (t / this.secPerBeat) % (this.loop ? this.totalBeats : Infinity);
      const bar = Math.floor(beats / 4);
      if (bar >= 0 && this.song) {
        this.onPosition(Math.min(bar, this.song.bars.length - 1));
      }
      this.raf = requestAnimationFrame(uiTick);
    };
    this.raf = requestAnimationFrame(uiTick);
  }

  private tick() {
    if (!this.ctx || !this.synth || !this.song) return;
    const horizon = this.ctx.currentTime + 0.18;
    const cycleLen = this.totalBeats * this.secPerBeat;

    // metronome
    if (this.click && this.clickBus) {
      while (true) {
        const when = this.startTime + this.nextClickBeat * this.secPerBeat;
        if (when > horizon) break;
        if (!this.loop && this.nextClickBeat >= this.totalBeats) break;
        if (when >= this.ctx.currentTime - 0.01) {
          scheduleClick(this.ctx, Math.max(when, this.ctx.currentTime), this.nextClickBeat % 4 === 0, this.clickBus);
        }
        this.nextClickBeat++;
      }
    } else if (this.clickBus) {
      // keep the counter moving so enabling mid-play stays on the grid
      const elapsed = (this.ctx.currentTime - this.startTime) / this.secPerBeat;
      this.nextClickBeat = Math.max(this.nextClickBeat, Math.ceil(elapsed));
    }

    while (true) {
      if (this.nextEventIdx >= this.schedule.length) {
        if (this.loop) {
          this.nextEventIdx = 0;
          this.cycle++;
        } else {
          const endTime = this.startTime + cycleLen + 1.5;
          if (this.ctx.currentTime > endTime) this.stop();
          return;
        }
      }
      const ev = this.schedule[this.nextEventIdx];
      const jitter = (Math.random() - 0.5) * 2 * this.humanize * 0.011;
      const when = this.startTime + this.cycle * cycleLen + ev.time + jitter;
      if (when > horizon) return;
      this.synth.note(ev.midi, ev.vel, Math.max(when, this.ctx.currentTime), ev.dur, ev.pan);
      this.nextEventIdx++;
    }
  }

  stop() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      this.onStop();
    }
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    if (this.ctx && this.synth) {
      const g = this.synth.master.gain;
      const t = this.ctx.currentTime;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0, t + 0.1);
      this.synth = new EPSynth(this.ctx, TONES.find(x => x.id === this.toneId) ?? TONES[0]);
    }
  }
}
