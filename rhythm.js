/**
 * Rhythm: a 12-beat pattern model, four drum-voice synths, and a beat-based scheduler.
 *
 * A pattern is a 12-beat cycle divided into `sub` steps per beat, with a velocity (0 = rest) per
 * step for each of four voices (kick, snare, hat, block). Velocity scales loudness, so accents are
 * just louder hits.
 *
 * No DOM or page globals are used, so this file loads with a plain <script> tag and works the same
 * way inside a jsPsych plugin: `new Rhythm.Player(audioContext, destinationNode)` synthesizes the
 * voices, and `new Rhythm.Sequencer(player, { startTime, period, patternAt })` schedules them on
 * the AudioContext clock, beat by beat, so a pattern (and its subdivision) can change cleanly at
 * any beat boundary.
 */
var Rhythm = (function () {
  "use strict";

  const BEATS = 12;
  const VOICES = ["kick", "snare", "hat", "block"];
  // "X" = 1, "x" = 0.7, "o" = 0.45, "." (or anything else) = rest.
  const VEL = { X: 1, x: 0.7, o: 0.45 };

  // ---- pattern model ------------------------------------------------------------------------------

  function empty(sub, meter, swing = 0) {
    const n = BEATS * sub;
    const voices = {};
    for (const k of VOICES) voices[k] = new Float32Array(n);
    return { sub, meter, swing, voices };
  }

  // Each spec string repeats to fill the cycle. `vel` optionally overrides the X/x/o velocity map,
  // e.g. { X: Math.pow(10, -6 / 20) } for a 6 dB accent instead of full scale.
  function fromStrings(sub, meter, spec, swing = 0, vel = VEL) {
    const p = empty(sub, meter, swing);
    const n = BEATS * sub;
    for (const k in spec) {
      for (let i = 0; i < n; i++) p.voices[k][i] = vel[spec[k][i % spec[k].length]] || 0;
    }
    return p;
  }

  function clone(pattern) {
    const voices = {};
    for (const k of VOICES) voices[k] = pattern.voices[k].slice();
    return { sub: pattern.sub, meter: pattern.meter, swing: pattern.swing, voices };
  }

  // Metric weight of a step: 4 downbeat of a 2-bar group, 3 strong beat, 2 weak beat, 1 half-beat,
  // 0 other subdivision.
  function metricWeight(step, sub, meter) {
    const b = Math.floor(step / sub), w = step % sub;
    if (w !== 0) return sub % 2 === 0 && w === sub / 2 ? 1 : 0;
    if (!meter) return 2;
    if (b % (2 * meter) === 0) return 4;
    if (b % meter === 0) return 3;
    return 2;
  }

  // Offset in beats of step `w` (a step *within a beat*, 0..sub-1) from the beat's onset, including
  // swing: odd steps of even subdivisions are delayed by (swing / 3) / sub, up to a 2:1 ratio.
  function stepOffset(w, pattern) {
    let off = w / pattern.sub;
    if (pattern.sub % 2 === 0 && w % 2 === 1) off += (pattern.swing / 3) / pattern.sub;
    return off;
  }

  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Seeded generator. Each step gets an onset probability from its metric weight and the density;
   * syncopation mixes the weight ladder with its mirror image so weak positions fill in and strong
   * ones thin out. Strong beats go to the kick, weak beats to the snare, subdivisions to the hat.
   */
  function generate({ meter, sub, density, syncopation, swing, seed, click }) {
    const rand = mulberry32(seed);
    const p = empty(sub, meter, swing);
    const n = BEATS * sub;
    const ladder = [0.45, 0.65, 0.95, 1.25, 1.5];
    for (let s = 0; s < n; s++) {
      const w = metricWeight(s, sub, meter);
      const prop = ladder[w] * (1 - syncopation) + ladder[4 - w] * syncopation;
      if (rand() >= Math.min(1, density * prop)) continue;
      const vel = 0.55 + 0.45 * (w / 4);
      if (!meter) { (w >= 2 ? p.voices.kick : p.voices.hat)[s] = w >= 2 ? 0.8 : vel; continue; }
      if (w >= 3) p.voices.kick[s] = vel;
      else if (w === 2) p.voices.snare[s] = 0.8;
      else if (w === 1) (rand() < syncopation ? p.voices.snare : p.voices.hat)[s] = 0.45 + 0.45 * syncopation;
      else p.voices.hat[s] = 0.5;
    }
    if (meter && syncopation < 0.6) p.voices.kick[0] = 1; // keep the cycle anchored
    if (click) for (let b = 0; b < BEATS; b++) p.voices.block[b * sub] = 0.7;
    return p;
  }

  const PRESETS = [
    { name: "Isochronous", note: "the experiment's ambiguous phase", make: () => fromStrings(1, 0, { block: "x" }) },
    { name: "Accented duple", note: "the experiment's duple cue", make: () => fromStrings(1, 2, { block: "Xx" }) },
    { name: "Accented triple", note: "the experiment's triple cue", make: () => fromStrings(1, 3, { block: "Xxx" }) },
    { name: "Backbeat", note: "duple, eighths", make: () => fromStrings(2, 2, { kick: "X...", snare: "..x.", hat: "o" }) },
    { name: "Waltz", note: "triple, eighths", make: () => fromStrings(2, 3, { kick: "X.....", snare: "..o.o.", hat: "o." }) },
    { name: "Shuffle", note: "duple beats, triplet subdivision", make: () => fromStrings(3, 2, { kick: "X.....", snare: "...x..", hat: "o.o" }) },
    { name: "Hemiola", note: "kick in threes against snare in twos", make: () => fromStrings(1, 0, { kick: "X..", snare: "x." }) },
    { name: "Funk", note: "duple, sixteenths, syncopated", make: () => fromStrings(4, 2, { kick: "X.....x...X.x...", snare: "....X.......X..o", hat: "o.o.o.o.o.o.o.o." }, 0.3) },
  ];

  function preset(name) {
    const p = PRESETS.find((entry) => entry.name === name);
    if (!p) throw new Error(`Rhythm.preset: unknown preset "${name}"`);
    return p.make();
  }

  // ---- clock ---------------------------------------------------------------------------------------
  // Output-time-corrected clock, same approach the plugin uses: getOutputTimestamp when available,
  // falling back to currentTime minus outputLatency.
  function audioNow(ctx) {
    const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    if (ts && ts.performanceTime > 0) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    return ctx.currentTime - (ctx.outputLatency || 0);
  }

  // ---- synths ---------------------------------------------------------------------------------------

  // Woodblock click: 50 ms, 1200 Hz plus a 2.76x partial, 2 ms attack, 12 ms exponential decay.
  // Same recipe as the plugin's synthesizeTone.
  function synthesizeBlock(ctx) {
    const freq = 1200;
    const n = Math.round(0.05 * ctx.sampleRate);
    const b = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = b.getChannelData(0);
    const attack = Math.round(0.002 * ctx.sampleRate);
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate;
      const e = Math.min(1, i / attack) * Math.exp(-t / 0.012);
      d[i] = e * (0.7 * Math.sin(2 * Math.PI * freq * t) + 0.3 * Math.sin(2 * Math.PI * 2.76 * freq * t));
    }
    return b;
  }

  function synthesizeNoise(ctx) {
    const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  const env = (g, when, peak, decay) => {
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(peak, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + decay);
  };

  const SYNTH = {
    kick(player, when, v) {
      const ctx = player.ctx;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(170, when);
      o.frequency.exponentialRampToValueAtTime(45, when + 0.12);
      env(g, when, 1.1 * v, 0.28);
      o.connect(g).connect(player.destination); o.start(when); o.stop(when + 0.3);
    },
    snare(player, when, v) {
      const ctx = player.ctx;
      const n = ctx.createBufferSource(); n.buffer = player.noiseBuffer;
      const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1900; f.Q.value = 0.7;
      const g = ctx.createGain(); env(g, when, 0.7 * v, 0.16);
      n.connect(f).connect(g).connect(player.destination); n.start(when); n.stop(when + 0.2);
      const o = ctx.createOscillator(), g2 = ctx.createGain();
      o.type = "triangle"; o.frequency.value = 190; env(g2, when, 0.5 * v, 0.08);
      o.connect(g2).connect(player.destination); o.start(when); o.stop(when + 0.1);
    },
    hat(player, when, v) {
      const ctx = player.ctx;
      const n = ctx.createBufferSource(); n.buffer = player.noiseBuffer;
      const f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 7500;
      const g = ctx.createGain(); env(g, when, 0.35 * v, 0.045);
      n.connect(f).connect(g).connect(player.destination); n.start(when); n.stop(when + 0.06);
    },
    block(player, when, v) {
      const ctx = player.ctx;
      const s = ctx.createBufferSource(); s.buffer = player.blockBuffer;
      const g = ctx.createGain(); g.gain.value = 0.85 * v;
      s.connect(g).connect(player.destination); s.start(when);
    },
  };

  class Player {
    constructor(audioContext, destinationNode, { voiceGain } = {}) {
      this.ctx = audioContext;
      this.destination = destinationNode;
      this.voiceGain = Object.assign({ kick: 1, snare: 1, hat: 1, block: 1 }, voiceGain);
      this.blockBuffer = synthesizeBlock(audioContext);
      this.noiseBuffer = synthesizeNoise(audioContext);
    }
    trigger(voice, when, velocity) {
      if (velocity <= 0) return;
      const v = velocity * (this.voiceGain[voice] ?? 1);
      SYNTH[voice](this, when, v);
    }
  }

  // ---- scheduler ---------------------------------------------------------------------------------------

  /**
   * Schedules pattern hits beat by beat (and, within a beat, step by step), so a change of pattern
   * (including its subdivision) between beats is clean: state is just `nextBeat` and `nextStep`.
   */
  class Sequencer {
    constructor(player, { startTime, period, patternAt, endBeat = null }) {
      this.player = player;
      this.startTime = startTime;
      this.period = period;
      this.patternAt = patternAt;
      this.endBeat = endBeat;
      this.nextBeat = 0;
      this.nextStep = 0;
    }

    beatsAt(seconds) {
      return (seconds - this.startTime) / this.period;
    }

    // Keeps the current beat phase continuous across a tempo change.
    retime(newPeriod, nowSeconds) {
      const t = this.beatsAt(nowSeconds);
      this.startTime = nowSeconds - t * newPeriod;
      this.period = newPeriod;
    }

    schedule(horizonSeconds) {
      const scheduled = [];
      for (;;) {
        if (this.endBeat !== null && this.nextBeat >= this.endBeat) break;
        const pattern = this.patternAt(this.nextBeat);
        const sub = pattern.sub;
        const cyclePos = ((this.nextBeat % BEATS) + BEATS) % BEATS;
        const when = this.startTime + (this.nextBeat + stepOffset(this.nextStep, pattern)) * this.period;
        if (when >= horizonSeconds) break;
        const i = cyclePos * sub + this.nextStep;
        for (const voice of VOICES) {
          const velocity = pattern.voices[voice][i];
          if (velocity > 0) {
            this.player.trigger(voice, when, velocity);
            scheduled.push({ beat: this.nextBeat, step: this.nextStep, voice, velocity, when });
          }
        }
        this.nextStep++;
        if (this.nextStep >= sub) { this.nextStep = 0; this.nextBeat++; }
      }
      return scheduled;
    }
  }

  // ---- exports ---------------------------------------------------------------------------------------

  const Rhythm = {};
  Rhythm.BEATS = BEATS;
  Rhythm.VOICES = VOICES;
  Rhythm.VEL = VEL;
  Rhythm.empty = empty;
  Rhythm.fromStrings = fromStrings;
  Rhythm.clone = clone;
  Rhythm.metricWeight = metricWeight;
  Rhythm.stepOffset = stepOffset;
  Rhythm.generate = generate;
  Rhythm.PRESETS = PRESETS;
  Rhythm.preset = preset;
  Rhythm.audioNow = audioNow;
  Rhythm.Player = Player;
  Rhythm.Sequencer = Sequencer;

  return Rhythm;
})();
