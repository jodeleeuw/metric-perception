/**
 * Dancer: an SVG cartoon character with headphones that bobs its head on every beat and
 * taps a foot (plus a bigger bob and a knee dip) on the strong beats of its own meter.
 *
 * The pose is a pure function of time in beats, so the caller drives it from the audio clock:
 *
 *   const d = new Dancer({ meter: 2, colors: { shirt: "#e8562a" } });
 *   container.appendChild(d.el);
 *   // each animation frame:
 *   d.update((audioContext.currentTime - beatZeroTime) / beatPeriodSeconds);
 *
 * Nothing here uses setTimeout or CSS transitions; every frame is drawn from the time you pass in.
 */
var Dancer = (function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  let nextId = 0;

  const DEFAULT_COLORS = {
    skin: "#c98a5b",
    hair: "#2b1d16",
    shirt: "#3d7a6b",
    accent: "#f2d16b",
    pants: "#334a6e",
    shoes: "#d94b3d",
    headphones: "#f3efe6",
  };

  // Amplitudes. All in SVG user units (viewBox is 160 x 240) or degrees.
  const DEFAULT_MOTION = {
    weakBob: 3, // head drop on every beat
    strongBob: 6, // extra head drop on strong beats
    dip: 4, // knee bend (whole upper body drops) on strong beats
    tap: 28, // toe lift angle in degrees before a strong beat
    armSwing: 7, // arm rotation on strong beats, degrees
    tilt: 4, // head tilt on strong beats, degrees
  };

  const HAIR_STYLES = ["puff", "swoop", "spiky", "buzz", "bun", "none"];
  const EYE_STYLES = ["closed", "open", "wink"];

  // ---- timing shapes ----------------------------------------------------------------------------

  const smooth = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : p * p * (3 - 2 * p));

  /**
   * A "hit" envelope around every multiple of `period` beats: 1 exactly at the beat, decaying to 0
   * over `release` beats afterwards, and rising from 0 to 1 over `attack` beats before the next one.
   * The quick attack and slow release are what make a bob read as landing *on* the beat.
   */
  function hit(tBeats, period, attack, release) {
    const x = ((tBeats % period) + period) % period;
    if (x < release) return 1 - smooth(x / release);
    if (x > period - attack) return smooth((x - (period - attack)) / attack);
    return 0;
  }

  /** Toe lift: rises during the half beat before a strong beat, then drops fast at the beat. */
  function lift(tBeats, period) {
    const x = ((tBeats % period) + period) % period;
    const drop = 0.07;
    const rise = Math.min(0.5, period * 0.4);
    if (x < drop) return 1 - smooth(x / drop);
    if (x > period - rise) return smooth((x - (period - rise)) / rise);
    return 0;
  }

  // ---- random characters ------------------------------------------------------------------------

  const SKIN_TONES = ["#f0c9a8", "#e8b995", "#d19a6e", "#c98a5b", "#a8673c", "#8a5a3a", "#5e3a26"];
  const HAIR_COLORS = ["#1e1512", "#3b2a1f", "#d9782a", "#e5c66a", "#8a2f2f", "#2fa39a", "#6d5aa8"];
  const HEADPHONE_COLORS = ["#f3efe6", "#25211f", "#e5b64a", "#d94b3d"];

  const pick = (a) => a[Math.floor(Math.random() * a.length)];

  function hsl(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return "#" + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
  }

  /**
   * A random character spec ({ hair, eyes, tapFoot, colors, hue }) for the Dancer constructor.
   * Clothing colors are derived from `hue` (random if omitted); fixed fields in `opts` win.
   */
  function random(opts = {}) {
    const h = opts.hue ?? Math.random() * 360;
    return {
      hair: pick(HAIR_STYLES),
      eyes: pick(EYE_STYLES),
      tapFoot: pick(["left", "right"]),
      ...opts,
      hue: Math.round(h),
      colors: {
        skin: pick(SKIN_TONES),
        hair: pick(HAIR_COLORS),
        shirt: hsl(h, 55, 48),
        accent: hsl((h + 180) % 360, 60, 80),
        pants: hsl((h + 210) % 360, 30, 32),
        shoes: hsl((h + 120) % 360, 60, 50),
        headphones: pick(HEADPHONE_COLORS),
        ...(opts.colors || {}),
      },
    };
  }

  /** Two random characters that are easy to tell apart: shirt hues 90-270 degrees apart, different hair. */
  function randomPair(opts = {}) {
    const a = random({ ...opts, hue: Math.random() * 360 });
    let b;
    do {
      b = random({ ...opts, hue: (a.hue + 90 + Math.random() * 180) % 360 });
    } while (b.hair === a.hair || b.colors.hair === a.colors.hair);
    return [a, b];
  }

  // ---- svg helpers ------------------------------------------------------------------------------

  function el(name, attrs, parent) {
    const node = document.createElementNS(NS, name);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }

  function shade(hex, amount) {
    // Lighten (amount > 0) or darken (amount < 0) a #rrggbb color.
    const n = parseInt(hex.slice(1), 16);
    const ch = (v) => Math.max(0, Math.min(255, Math.round(v + (amount > 0 ? (255 - v) * amount : v * amount))));
    const r = ch(n >> 16), g = ch((n >> 8) & 255), b = ch(n & 255);
    return "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
  }

  // ---- the character ----------------------------------------------------------------------------

  class Dancer {
    constructor(opts = {}) {
      this.id = "dancer" + nextId++;
      this.meter = opts.meter || 2;
      this.colors = { ...DEFAULT_COLORS, ...(opts.colors || {}) };
      this.motion = { ...DEFAULT_MOTION, ...(opts.motion || {}) };
      this.hair = opts.hair || "puff";
      this.eyes = opts.eyes || "closed";
      this.tapFoot = opts.tapFoot || "right";
      this.t = 0;

      this.el = el("svg", {
        viewBox: "0 0 160 240",
        class: "dancer",
        role: "img",
        "aria-label": "Cartoon dancer wearing headphones",
      });
      if (opts.height) this.el.style.height = opts.height + "px";
      this._build();
      this.update(0);
    }

    _build() {
      const svg = this.el;
      const defs = el("defs", {}, svg);
      const clip = el("clipPath", { id: this.id + "-torso" }, defs);
      el("rect", { x: 50, y: 116, width: 60, height: 62, rx: 18 }, clip);

      // Ground shadow
      this.shadow = el("ellipse", { cx: 80, cy: 226, rx: 40, ry: 5, fill: "rgba(0,0,0,0.18)" }, svg);

      // Legs: lines from hip to ankle. Hip end moves with the knee dip; ankle stays put.
      this.legL = el("line", { x1: 70, y1: 170, x2: 70, y2: 214, "stroke-width": 15, "stroke-linecap": "round" }, svg);
      this.legR = el("line", { x1: 90, y1: 170, x2: 90, y2: 214, "stroke-width": 15, "stroke-linecap": "round" }, svg);

      // Shoes: profile shape with the heel at the local origin and the toe pointing +x.
      // The left shoe is mirrored with scale(-1,1) so the same negative angle lifts either toe.
      const shoePath = "M -5 0 L 24 0 Q 33 0 33 -7 Q 33 -13 25 -14 L 8 -14 Q -5 -14 -5 0 Z";
      this.shoeL = el("g", {}, svg);
      this.shoeR = el("g", {}, svg);
      for (const g of [this.shoeL, this.shoeR]) {
        el("path", { d: shoePath, class: "shoe" }, g);
        el("path", { d: "M -5 0 L 24 0 Q 33 0 33 -7 L 33 -4 Q 33 -3 24 -3 L -5 -3 Z", class: "sole" }, g);
        el("circle", { cx: 12, cy: -9, r: 2, class: "lace" }, g);
      }

      // Everything above the knees moves together for the dip.
      this.upper = el("g", {}, svg);

      // Arms rotate about the shoulder.
      this.armL = el("g", {}, this.upper);
      this.armR = el("g", {}, this.upper);
      el("line", { x1: 58, y1: 132, x2: 46, y2: 180, "stroke-width": 12, "stroke-linecap": "round", class: "sleeve" }, this.armL);
      el("circle", { cx: 45, cy: 184, r: 7.5, class: "skin" }, this.armL);
      el("line", { x1: 102, y1: 132, x2: 114, y2: 180, "stroke-width": 12, "stroke-linecap": "round", class: "sleeve" }, this.armR);
      el("circle", { cx: 115, cy: 184, r: 7.5, class: "skin" }, this.armR);

      // Torso
      el("rect", { x: 50, y: 116, width: 60, height: 62, rx: 18, class: "shirt" }, this.upper);
      const stripes = el("g", { "clip-path": `url(#${this.id}-torso)` }, this.upper);
      el("rect", { x: 40, y: 140, width: 80, height: 11, class: "accent" }, stripes);
      el("rect", { x: 40, y: 155, width: 80, height: 4, class: "accent" }, stripes);
      // Neck
      el("rect", { x: 73, y: 104, width: 14, height: 20, class: "skin" }, this.upper);

      // Head group: bobs and tilts. Origin of rotation is the base of the neck.
      this.head = el("g", {}, this.upper);
      this.hairBack = el("g", {}, this.head);
      el("circle", { cx: 46, cy: 84, r: 7, class: "skin" }, this.head);
      el("circle", { cx: 114, cy: 84, r: 7, class: "skin" }, this.head);
      el("rect", { x: 46, y: 44, width: 68, height: 68, rx: 27, class: "skin" }, this.head);
      this.hairFront = el("g", {}, this.head);

      // Face
      this.brows = el("g", {}, this.head);
      el("path", { d: "M 60 68 Q 67 64 74 68", class: "line" }, this.brows);
      el("path", { d: "M 86 68 Q 93 64 100 68", class: "line" }, this.brows);
      this.eyesG = el("g", {}, this.head);
      el("circle", { cx: 66, cy: 92, r: 4.5, class: "cheek" }, this.head);
      el("circle", { cx: 94, cy: 92, r: 4.5, class: "cheek" }, this.head);
      el("path", { d: "M 72 96 Q 80 104 88 96", class: "line" }, this.head);

      // Headphones: cups over the ears, band over the top.
      el("path", { d: "M 43 84 A 37 37 0 0 1 117 84", class: "band" }, this.head);
      for (const x of [36, 110]) {
        el("rect", { x, y: 70, width: 14, height: 28, rx: 6, class: "phones" }, this.head);
        el("rect", { x: x + 4, y: 76, width: 6, height: 16, rx: 3, class: "pad" }, this.head);
      }

      this._applyHair();
      this._applyEyes();
      this._applyColors();
    }

    _applyHair() {
      this.hairBack.innerHTML = "";
      this.hairFront.innerHTML = "";
      const h = this.hair;
      if (h === "puff") {
        el("circle", { cx: 80, cy: 66, r: 46, class: "hair" }, this.hairBack);
      } else if (h === "swoop") {
        el("path", { d: "M 46 74 C 44 40 66 34 88 38 C 108 40 118 52 116 74 C 108 60 98 54 88 58 C 74 46 58 54 46 74 Z", class: "hair" }, this.hairFront);
      } else if (h === "spiky") {
        el("path", { d: "M 48 70 L 50 44 L 60 56 L 66 32 L 76 52 L 84 28 L 92 52 L 100 34 L 106 56 L 112 44 L 113 70 Q 80 54 48 70 Z", class: "hair" }, this.hairFront);
      } else if (h === "buzz") {
        el("path", { d: "M 46 72 C 46 42 62 38 80 38 C 98 38 114 42 114 72 C 106 62 94 58 80 58 C 66 58 54 62 46 72 Z", class: "hair" }, this.hairFront);
      } else if (h === "bun") {
        el("path", { d: "M 46 72 C 46 42 62 38 80 38 C 98 38 114 42 114 72 C 106 62 94 58 80 58 C 66 58 54 62 46 72 Z", class: "hair" }, this.hairFront);
        el("circle", { cx: 104, cy: 38, r: 12, class: "hair" }, this.hairBack);
      }
    }

    _applyEyes() {
      this.eyesG.innerHTML = "";
      const open = (cx) => {
        el("circle", { cx, cy: 82, r: 4, class: "ink" }, this.eyesG);
        el("circle", { cx: cx + 1.5, cy: 80.5, r: 1.3, fill: "#fff" }, this.eyesG);
      };
      const closed = (cx) => el("path", { d: `M ${cx - 6} 83 Q ${cx} 76 ${cx + 6} 83`, class: "line" }, this.eyesG);
      if (this.eyes === "open") { open(67); open(93); }
      else if (this.eyes === "wink") { open(67); closed(93); }
      else { closed(67); closed(93); }
    }

    _applyColors() {
      const c = this.colors;
      const s = this.el.style;
      s.setProperty("--skin", c.skin);
      s.setProperty("--hair", c.hair);
      s.setProperty("--shirt", c.shirt);
      s.setProperty("--accent", c.accent);
      s.setProperty("--pants", c.pants);
      s.setProperty("--shoes", c.shoes);
      s.setProperty("--sole", shade(c.shoes, 0.55));
      s.setProperty("--phones", c.headphones);
      s.setProperty("--pad", shade(c.headphones, -0.35));
      s.setProperty("--ink", shade(c.skin, -0.72));
      s.setProperty("--cheek", shade(c.skin, -0.18));
      this.legL.setAttribute("stroke", c.pants);
      this.legR.setAttribute("stroke", c.pants);
    }

    // ---- public API -----------------------------------------------------------------------------

    setColors(partial) { Object.assign(this.colors, partial); this._applyColors(); return this; }
    setHair(style) { this.hair = style; this._applyHair(); return this; }
    setEyes(style) { this.eyes = style; this._applyEyes(); return this; }
    setMeter(n) { this.meter = n; this.update(this.t); return this; }
    setMotion(partial) { Object.assign(this.motion, partial); this.update(this.t); return this; }
    setTapFoot(side) { this.tapFoot = side; this.update(this.t); return this; }

    /** Pose the character for time `tBeats` (fractional beats since beat 0; beat 0 is strong). */
    update(tBeats) {
      this.t = tBeats;
      const P = this.meter;
      const weak = hit(tBeats, 1, 0.12, 0.5);
      const strong = hit(tBeats, P, 0.15, 0.6);
      const toe = lift(tBeats, P);
      this._pose(weak, strong, toe);
    }

    /** Neutral standing pose (no beat envelopes active). */
    rest() {
      this._pose(0, 0, 0);
    }

    /** Write transforms for the given envelope values (each 0..1). */
    _pose(weak, strong, toe) {
      const m = this.motion;
      const dip = m.dip * strong;
      const bob = m.weakBob * weak + m.strongBob * strong;
      const tilt = -m.tilt * strong;

      this.upper.setAttribute("transform", `translate(0 ${dip.toFixed(2)})`);
      this.legL.setAttribute("y1", (170 + dip).toFixed(2));
      this.legR.setAttribute("y1", (170 + dip).toFixed(2));
      this.head.setAttribute("transform", `translate(0 ${bob.toFixed(2)}) rotate(${tilt.toFixed(2)} 80 112)`);
      this.brows.setAttribute("transform", `translate(0 ${(-2.5 * strong).toFixed(2)})`);
      this.armL.setAttribute("transform", `rotate(${(m.armSwing * strong).toFixed(2)} 58 132)`);
      this.armR.setAttribute("transform", `rotate(${(-m.armSwing * strong).toFixed(2)} 102 132)`);

      const angL = this.tapFoot === "left" ? -m.tap * toe : 0;
      const angR = this.tapFoot === "right" ? -m.tap * toe : 0;
      this.shoeL.setAttribute("transform", `translate(72 222) scale(-1 1) rotate(${angL.toFixed(2)})`);
      this.shoeR.setAttribute("transform", `translate(88 222) rotate(${angR.toFixed(2)})`);
      this.shadow.setAttribute("rx", (40 + 2 * strong).toFixed(2));
    }
  }

  Dancer.HAIR_STYLES = HAIR_STYLES;
  Dancer.EYE_STYLES = EYE_STYLES;
  Dancer.DEFAULT_COLORS = DEFAULT_COLORS;
  Dancer.DEFAULT_MOTION = DEFAULT_MOTION;
  Dancer.random = random;
  Dancer.randomPair = randomPair;
  Dancer.hit = hit;
  Dancer.lift = lift;

  // Part colors are CSS custom properties on the <svg>, so a stylesheet is all the parts need.
  const style = document.createElement("style");
  style.textContent = `
    svg.dancer { display: block; overflow: visible; }
    svg.dancer .skin { fill: var(--skin); }
    svg.dancer .hair { fill: var(--hair); }
    svg.dancer .shirt { fill: var(--shirt); }
    svg.dancer .sleeve { stroke: var(--shirt); }
    svg.dancer .accent { fill: var(--accent); }
    svg.dancer .shoe { fill: var(--shoes); }
    svg.dancer .sole { fill: var(--sole); }
    svg.dancer .lace { fill: var(--sole); }
    svg.dancer .phones { fill: var(--phones); }
    svg.dancer .pad { fill: var(--pad); }
    svg.dancer .band { fill: none; stroke: var(--phones); stroke-width: 7; stroke-linecap: round; }
    svg.dancer .ink { fill: var(--ink); }
    svg.dancer .line { fill: none; stroke: var(--ink); stroke-width: 2.6; stroke-linecap: round; }
    svg.dancer .cheek { fill: var(--cheek); opacity: 0.45; }
  `;
  document.head.appendChild(style);

  return Dancer;
})();
