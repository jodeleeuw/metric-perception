var jsPsychMetricalTrajectory = (function (jspsych) {
  "use strict";

  const { ParameterType } = jspsych;

  const info = {
    name: "metrical-trajectory",
    version: "0.1.0",
    parameters: {
      /** Meter established by the first cue: "duple" or "triple". */
      cued_meter: { type: ParameterType.SELECT, options: ["duple", "triple"], default: undefined },
      /** Whether a reversal cue to the other meter follows the post-cue phase. */
      reversal: { type: ParameterType.BOOL, default: false },
      /** Which side (circle or dancer, depending on config.VISUAL_MODE) carries the duple accent pattern. */
      duple_side: { type: ParameterType.SELECT, options: ["left", "right"], default: "left" },
      /** Settings object; see config.js. */
      config: { type: ParameterType.OBJECT, default: undefined },
      /**
       * Time in ms from beat 0 during which clicks and key presses are ignored. When it ends the
       * choice prompt appears and the participant can respond whenever ready, while the rhythm
       * plays. The rhythm keeps going (in the final meter) past the scheduled phases until a
       * choice is made, and the choice stops sound and motion at once.
       */
      response_lockout_ms: { type: ParameterType.INT, default: 1000 },
      /** Record mouse position as gaze when no eye tracker is running (for testing). */
      simulate_gaze_with_mouse: { type: ParameterType.BOOL, default: false },
    },
    data: {
      final_meter: { type: ParameterType.STRING },
      choice_side: { type: ParameterType.STRING },
      choice_meter: { type: ParameterType.STRING },
      correct: { type: ParameterType.BOOL },
      choice_method: { type: ParameterType.STRING },
      rt: { type: ParameterType.FLOAT },
      choice_time_ms: { type: ParameterType.FLOAT },
      choice_beat: { type: ParameterType.FLOAT },
      response_lockout_ms: { type: ParameterType.INT },
      beat_onsets_ms: { type: ParameterType.FLOAT, array: true },
      accented_beats: { type: ParameterType.BOOL, array: true },
      onsets: {
        type: ParameterType.COMPLEX,
        array: true,
        nested: {
          beat: { type: ParameterType.INT },
          step: { type: ParameterType.INT },
          voice: { type: ParameterType.STRING },
          velocity: { type: ParameterType.FLOAT },
          time_ms: { type: ParameterType.FLOAT },
        },
      },
      rhythm_patterns: { type: ParameterType.OBJECT },
      /** Seed used for each generated pattern, keyed by pattern name (null if not generated). */
      rhythm_seeds: { type: ParameterType.OBJECT },
      phase_boundaries: {
        type: ParameterType.COMPLEX,
        array: true,
        nested: {
          phase: { type: ParameterType.STRING },
          beat: { type: ParameterType.INT },
          time_ms: { type: ParameterType.FLOAT },
        },
      },
      gaze: {
        type: ParameterType.COMPLEX,
        array: true,
        nested: {
          x: { type: ParameterType.FLOAT },
          y: { type: ParameterType.FLOAT },
          t: { type: ParameterType.FLOAT },
          t_perf: { type: ParameterType.FLOAT },
        },
      },
      gaze_source: { type: ParameterType.STRING },
      viewport_width: { type: ParameterType.INT },
      viewport_height: { type: ParameterType.INT },
      scale_factor: { type: ParameterType.FLOAT },
      circle_left_x: { type: ParameterType.FLOAT },
      circle_right_x: { type: ParameterType.FLOAT },
      circle_y: { type: ParameterType.FLOAT },
      audio_output_latency_s: { type: ParameterType.FLOAT },
      audio_base_latency_s: { type: ParameterType.FLOAT },
      visual_mode: { type: ParameterType.STRING },
      /** Character spec shown on each side (name, hair, eyes, tapFoot, colors). */
      character_left: { type: ParameterType.OBJECT },
      character_right: { type: ParameterType.OBJECT },
    },
  };

  const PERIOD_BEATS = { duple: 2, triple: 3 };
  const other = (meter) => (meter === "duple" ? "triple" : "duple");

  // One AudioContext and Rhythm.Player for the whole experiment.
  let audio = null;

  /**
   * Compiles one RHYTHM_PATTERNS value into { pattern, seed }. A string is a Rhythm preset name,
   * played as-is; { generate: {...} } is passed to Rhythm.generate, with a fresh random seed when
   * its seed is null; any other object is a spec compiled with a velocity map derived from
   * cfg.ACCENT_GAIN_DB (X = full velocity, x = ACCENT_GAIN_DB below it, o = twice that below).
   */
  function compilePattern(value, cfg) {
    if (typeof value === "string") return { pattern: Rhythm.preset(value), seed: null };
    if (value.generate) {
      const seed = value.generate.seed ?? Math.floor(Math.random() * 2 ** 31);
      return { pattern: Rhythm.generate({ swing: 0, ...value.generate, seed }), seed };
    }
    const down = Math.pow(10, -cfg.ACCENT_GAIN_DB / 20);
    const vel = { X: 1, x: down, o: down * down };
    return { pattern: Rhythm.fromStrings(value.sub, value.meter, value.voices, value.swing || 0, vel), seed: null };
  }

  /**
   * Beat-level plan for one trial: which meter is metrically cued on each beat, and where the
   * phase boundaries fall. `accented` records, per beat, whether that beat is metrically strong in
   * the grid cued at that time; it is no longer what drives the audio (a Rhythm.Sequencer does
   * that, from patterns keyed by revAnchor) — it's a convenience label for analysis. The cue
   * starts at beat 0.
   */
  function buildSchedule(trial, cfg) {
    const P = cfg.PHASE_BEATS;
    const postStart = P.cue;
    const revStart = postStart + P.post_cue;
    const totalBeats = trial.reversal ? revStart + P.reversal_cue + P.reversal_post : revStart;

    const boundaries = [
      { phase: "cue", beat: 0 },
      { phase: "post_cue", beat: postStart },
    ];

    // Reversal accents start on the first beat that is strong in the new grid and weak in the old.
    let revAnchor = Infinity;
    if (trial.reversal) {
      const oldP = PERIOD_BEATS[trial.cued_meter];
      const newP = PERIOD_BEATS[other(trial.cued_meter)];
      revAnchor = revStart;
      while (!(revAnchor % newP === 0 && revAnchor % oldP !== 0)) revAnchor++;
      boundaries.push(
        { phase: "reversal_cue", beat: revStart },
        { phase: "reversal_accent_onset", beat: revAnchor },
        { phase: "reversal_post", beat: revStart + P.reversal_cue }
      );
    }
    // The rhythm continues past this point in the final meter until the participant chooses.
    boundaries.push({ phase: "schedule_end", beat: totalBeats });

    const accented = [];
    for (let b = 0; b < totalBeats; b++) {
      const meter = b >= revAnchor ? other(trial.cued_meter) : trial.cued_meter;
      accented.push(b % PERIOD_BEATS[meter] === 0);
    }

    return {
      totalBeats,
      accented,
      boundaries,
      revAnchor,
      finalMeter: trial.reversal ? other(trial.cued_meter) : trial.cued_meter,
    };
  }

  class MetricalTrajectoryPlugin {
    static info = info;

    constructor(jsPsych) {
      this.jsPsych = jsPsych;
    }

    /** Create the shared AudioContext. Call from a user gesture (e.g. a button's on_finish). */
    static initAudio(cfg) {
      if (!audio) {
        const ctx = new AudioContext({ latencyHint: "interactive" });
        const master = ctx.createGain();
        master.gain.value = cfg.MASTER_GAIN;
        master.connect(ctx.destination);
        const player = new Rhythm.Player(ctx, master, { voiceGain: cfg.VOICE_GAINS });
        audio = { ctx, master, player };
      }
      audio.ctx.resume();
      return audio;
    }

    trial(display_element, trial) {
      const cfg = trial.config;
      const { ctx, master } = MetricalTrajectoryPlugin.initAudio(cfg);
      // Per-trial output, so a choice can silence hits already queued on the audio clock.
      const trialOut = ctx.createGain();
      trialOut.connect(master);
      const player = new Rhythm.Player(ctx, trialOut, { voiceGain: cfg.VOICE_GAINS });
      const period = cfg.BEAT_PERIOD_MS / 1000;
      const schedule = buildSchedule(trial, cfg);
      const patterns = {};
      const rhythmSeeds = {};
      for (const name of ["duple", "triple"]) {
        const compiled = compilePattern(cfg.RHYTHM_PATTERNS[name], cfg);
        patterns[name] = compiled.pattern;
        rhythmSeeds[name] = compiled.seed;
      }
      const dancersMode = cfg.VISUAL_MODE === "dancers";
      let characters = cfg.CHARACTERS;
      if (characters === "random") {
        const [left, right] = Dancer.randomPair({ tapFoot: "right" });
        characters = { left, right };
      }

      // ---- layout -----------------------------------------------------------------------------
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const scale = Math.min(1, vw / cfg.REFERENCE_WIDTH_PX);
      const cx = vw / 2;
      const cy = vh / 2;
      const pos = { left: cx - cfg.CIRCLE_OFFSET_PX * scale, right: cx + cfg.CIRCLE_OFFSET_PX * scale };
      const meterSide = {
        duple: trial.duple_side,
        triple: trial.duple_side === "left" ? "right" : "left",
      };
      const sideMeter = { [meterSide.duple]: "duple", [meterSide.triple]: "triple" };

      const dpr = window.devicePixelRatio || 1;
      display_element.innerHTML = "";
      const canvas = document.createElement("canvas");
      canvas.width = vw * dpr;
      canvas.height = vh * dpr;
      Object.assign(canvas.style, {
        position: "fixed",
        left: "0",
        top: "0",
        width: vw + "px",
        height: vh + "px",
        background: cfg.BACKGROUND_COLOR,
        cursor: "none",
      });
      display_element.appendChild(canvas);
      const g = canvas.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);

      // ---- dancers (VISUAL_MODE === "dancers") -------------------------------------------------
      // Overlay for the SVG dancers, layered above the canvas. pointer-events: none so clicks
      // still reach the canvas for the choice hit test.
      let overlay = null;
      let dancers = null;
      if (dancersMode) {
        overlay = document.createElement("div");
        Object.assign(overlay.style, { position: "fixed", inset: "0", pointerEvents: "none" });
        display_element.appendChild(overlay);

        const dancerHeight = cfg.DANCER_HEIGHT_PX * scale;
        const dancerWidth = dancerHeight * (160 / 240);
        dancers = {};
        for (const side of ["left", "right"]) {
          const meter = sideMeter[side] === "duple" ? 2 : 3;
          const spec = characters[side];
          const dancer = new Dancer({
            meter,
            colors: spec.colors,
            hair: spec.hair,
            eyes: spec.eyes,
            tapFoot: spec.tapFoot,
            motion: cfg.DANCER_MOTION,
            height: dancerHeight,
          });
          Object.assign(dancer.el.style, {
            position: "absolute",
            left: pos[side] - dancerWidth / 2 + "px",
            top: cy - dancerHeight / 2 + "px",
            width: dancerWidth + "px",
            height: dancerHeight + "px",
          });
          overlay.appendChild(dancer.el);
          dancers[side] = dancer;
        }
      }

      // ---- clocks -----------------------------------------------------------------------------
      // Convert a performance.now() time to the AudioContext clock at the moment of audible
      // output, so visuals and gaze align with what the participant hears, not with what was queued.
      const perfToAudio = (perfMs) => {
        const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
        if (ts && ts.performanceTime > 0) {
          return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
        }
        return ctx.currentTime - (ctx.outputLatency || 0) + (perfMs - performance.now()) / 1000;
      };
      const audioNow = () => perfToAudio(performance.now());

      let startTime = null; // AudioContext time of beat 0 onset; trial time zero
      const onsets = [];
      let sequencer = null;
      let schedulerId = null;
      let rafId = null;
      let choiceOnsetPerf = null; // performance.now() when responses were enabled
      let responseOpen = false;
      let finished = false;

      // ---- gaze -------------------------------------------------------------------------------
      const gaze = [];
      let gazeSource = "none";
      let unsubscribeGaze = null;
      const recordGaze = (sample) => {
        if (startTime === null || finished) return;
        gaze.push({
          x: sample.x,
          y: sample.y,
          t: (perfToAudio(sample.t) - startTime) * 1000,
          t_perf: sample.t,
        });
      };
      const saccade = this.jsPsych.extensions.saccade;
      if (saccade && saccade.isInitialized && saccade.isInitialized()) {
        gazeSource = "saccade";
        unsubscribeGaze = saccade.onGazeUpdate(recordGaze);
      } else if (trial.simulate_gaze_with_mouse) {
        gazeSource = "mouse";
        const onMouse = (e) => recordGaze({ x: e.clientX, y: e.clientY, t: performance.now() });
        document.addEventListener("mousemove", onMouse);
        unsubscribeGaze = () => document.removeEventListener("mousemove", onMouse);
      }

      // ---- audio scheduler --------------------------------------------------------------------
      // patternAt: the cued meter's pattern from beat 0, the other meter's pattern from the reversal
      // anchor beat (if the trial reverses).
      const patternAt = (b) => patterns[b >= schedule.revAnchor ? other(trial.cued_meter) : trial.cued_meter];

      const scheduleBeats = () => {
        for (const hit of sequencer.schedule(ctx.currentTime + cfg.SCHEDULER_LOOKAHEAD_S)) {
          onsets.push({
            beat: hit.beat,
            step: hit.step,
            voice: hit.voice,
            velocity: hit.velocity,
            time_ms: (hit.when - startTime) * 1000,
          });
        }
      };

      // ---- drawing ----------------------------------------------------------------------------
      const circleDiameter = (meter, beat, msSinceBeat) => {
        if (beat < 0 || msSinceBeat >= cfg.PULSE_DURATION_MS) {
          return cfg.CIRCLE_BASE_DIAMETER;
        }
        const peak =
          beat % PERIOD_BEATS[meter] === 0 ? cfg.CIRCLE_STRONG_DIAMETER[meter] : cfg.CIRCLE_WEAK_DIAMETER;
        const p = msSinceBeat / cfg.PULSE_DURATION_MS;
        const easeOut = 1 - (1 - p) * (1 - p);
        return peak - (peak - cfg.CIRCLE_BASE_DIAMETER) * easeOut;
      };

      const draw = (beat, msSinceBeat, prompt) => {
        g.fillStyle = cfg.BACKGROUND_COLOR;
        g.fillRect(0, 0, vw, vh);
        if (!dancersMode) {
          g.fillStyle = cfg.CIRCLE_COLOR;
          for (const side of ["left", "right"]) {
            const d = circleDiameter(sideMeter[side], beat, msSinceBeat) * scale;
            g.beginPath();
            g.arc(pos[side], cy, d / 2, 0, 2 * Math.PI);
            g.fill();
          }
        }
        if (prompt) {
          g.fillStyle = "#000";
          g.font = `${Math.round(22 * Math.max(scale, 0.75))}px sans-serif`;
          g.textAlign = "center";
          g.fillText(prompt, cx, cy + 160 * scale);
        }
      };

      const k = cfg.CHOICE_KEYS;
      const prompt = `Which ${dancersMode ? "dancer" : "shape"} fits the rhythm better? Click it, or press ${k.left.toUpperCase()} (left) / ${k.right.toUpperCase()} (right).`;

      const frame = () => {
        const t = audioNow() - startTime;
        const beat = t < 0 ? -1 : Math.floor(t / period);
        if (!responseOpen && t * 1000 >= trial.response_lockout_ms) openResponse();
        draw(beat, (t - Math.max(beat, 0) * period) * 1000, responseOpen ? prompt : null);
        if (dancersMode) {
          dancers.left.update(t / period);
          dancers.right.update(t / period);
        }
        rafId = requestAnimationFrame(frame);
      };

      // ---- choice -----------------------------------------------------------------------------
      let keyboardListener = null;
      const onClick = (e) => {
        for (const side of ["left", "right"]) {
          if (Math.hypot(e.clientX - pos[side], e.clientY - cy) <= cfg.AOI_CIRCLE_HALF_WIDTH_PX * scale) {
            endTrial(side, "click");
            return;
          }
        }
      };

      const openResponse = () => {
        responseOpen = true;
        choiceOnsetPerf = performance.now();
        canvas.style.cursor = "default";
        canvas.addEventListener("click", onClick);
        keyboardListener = this.jsPsych.pluginAPI.getKeyboardResponse({
          callback_function: (info) => endTrial(info.key === k.left ? "left" : "right", "keyboard"),
          valid_responses: [k.left, k.right],
          rt_method: "performance",
          persist: false,
          allow_held_key: false,
        });
      };

      const endTrial = (choiceSide, method) => {
        if (finished) return;
        finished = true;
        const choicePerf = performance.now();
        const rt = choicePerf - choiceOnsetPerf;
        const choiceTime = perfToAudio(choicePerf) - startTime;
        cancelAnimationFrame(rafId);
        clearInterval(schedulerId);
        // Silence hits already queued, then release the per-trial output.
        trialOut.gain.setTargetAtTime(0, ctx.currentTime, 0.005);
        setTimeout(() => trialOut.disconnect(), 500);
        canvas.removeEventListener("click", onClick);
        if (keyboardListener) this.jsPsych.pluginAPI.cancelKeyboardResponse(keyboardListener);
        if (unsubscribeGaze) unsubscribeGaze();

        const phaseBoundaries = schedule.boundaries.map((b) => ({
          ...b,
          time_ms: b.beat * cfg.BEAT_PERIOD_MS,
        }));
        phaseBoundaries.push({
          phase: "choice_onset",
          beat: null,
          time_ms: (perfToAudio(choiceOnsetPerf) - startTime) * 1000,
        });
        phaseBoundaries.push({ phase: "choice", beat: null, time_ms: choiceTime * 1000 });
        // Beats whose onsets were heard before the choice (including any past the schedule).
        const beatsPlayed = Math.max(0, Math.floor(choiceTime / period) + 1);

        const choiceMeter = sideMeter[choiceSide];
        display_element.innerHTML = "";
        this.jsPsych.finishTrial({
          final_meter: schedule.finalMeter,
          choice_side: choiceSide,
          choice_meter: choiceMeter,
          correct: choiceMeter === schedule.finalMeter,
          choice_method: method,
          rt,
          choice_time_ms: choiceTime * 1000,
          choice_beat: choiceTime / period,
          response_lockout_ms: trial.response_lockout_ms,
          beat_onsets_ms: Array.from({ length: beatsPlayed }, (_, b) => b * cfg.BEAT_PERIOD_MS),
          accented_beats: Array.from({ length: beatsPlayed }, (_, b) =>
            b < schedule.totalBeats ? schedule.accented[b] : b % PERIOD_BEATS[schedule.finalMeter] === 0
          ),
          onsets: onsets.filter((o) => o.time_ms <= choiceTime * 1000), // drop hits silenced by the choice
          rhythm_patterns: cfg.RHYTHM_PATTERNS,
          rhythm_seeds: rhythmSeeds,
          phase_boundaries: phaseBoundaries,
          gaze,
          gaze_source: gazeSource,
          viewport_width: vw,
          viewport_height: vh,
          scale_factor: scale,
          circle_left_x: pos.left,
          circle_right_x: pos.right,
          circle_y: cy,
          audio_output_latency_s: ctx.outputLatency ?? null,
          audio_base_latency_s: ctx.baseLatency ?? null,
          visual_mode: cfg.VISUAL_MODE,
          character_left: dancersMode ? characters.left : null,
          character_right: dancersMode ? characters.right : null,
        });
      };

      // ---- go ---------------------------------------------------------------------------------
      ctx.resume().then(() => {
        startTime = ctx.currentTime + cfg.AUDIO_LEAD_IN_S;
        sequencer = new Rhythm.Sequencer(player, { startTime, period, patternAt, endBeat: null });
        scheduleBeats();
        schedulerId = setInterval(scheduleBeats, cfg.SCHEDULER_INTERVAL_MS);
        rafId = requestAnimationFrame(frame);
      });
    }
  }

  return MetricalTrajectoryPlugin;
})(jsPsychModule);
