// Top-level constants for piloting. Adjust here, not in plugin logic.
const CONFIG = {
  // Timing
  BEAT_PERIOD_MS: 500,
  PHASE_BEATS: {
    cue: 12,
    post_cue: 24,
    reversal_cue: 12,
    reversal_post: 24,
  },
  AUDIO_LEAD_IN_S: 0.3, // delay between trial start and beat 0, so the first beats schedule cleanly
  SCHEDULER_LOOKAHEAD_S: 0.1,
  SCHEDULER_INTERVAL_MS: 25,

  // Audio
  ACCENT_GAIN_DB: 6, // in pattern specs, X is full velocity, x is ACCENT_GAIN_DB below it, o is
  // twice that below, and "." is a rest.
  MASTER_GAIN: 0.8, // linear gain applied to the whole rhythm; a full-velocity woodblock hit lands
  // near the old accented level
  VOICE_GAINS: { kick: 1, snare: 1, hat: 1, block: 1 },

  // Rhythm played in each phase. Each value is one of:
  //   - a Rhythm preset name (string), played as-is;
  //   - a spec { sub, meter, swing, voices: { block: "Xx", ... } } compiled with the velocity map
  //     derived from ACCENT_GAIN_DB;
  //   - a generator spec { generate: { sub, meter, density, syncopation, swing, click, seed } },
  //     passed to Rhythm.generate (which sets its own velocities). seed: null draws a new seed for
  //     each trial; the seeds used are saved as rhythm_seeds.
  // Patterns repeat every 12 beats and phase boundaries fall on beat onsets, so cycle position
  // b % 12 stays aligned with the metric grid for both meters. With density >= 0.9 and
  // syncopation <= 0.1 the generator puts a kick on every strong beat, so the meter stays clear.
  RHYTHM_PATTERNS: {
    duple: { generate: { sub: 2, meter: 2, density: 0.9, syncopation: 0.1, swing: 0, click: false, seed: null } },
    triple: { generate: { sub: 2, meter: 3, density: 0.9, syncopation: 0.1, swing: 0, click: false, seed: null } },
  },

  // Visual (px at a 1280 px wide viewport; scaled down on smaller screens)
  REFERENCE_WIDTH_PX: 1280,
  CIRCLE_OFFSET_PX: 300,
  CIRCLE_BASE_DIAMETER: 80,
  CIRCLE_WEAK_DIAMETER: 100,
  CIRCLE_STRONG_DIAMETER: { duple: 140, triple: 140 }, // raise triple to match salience in piloting
  PULSE_DURATION_MS: 100,
  BACKGROUND_COLOR: "#808080",
  CIRCLE_COLOR: "#ffffff",

  // Which stimulus embodies the meter: "dancers" (SVG cartoon characters) or "circles"
  // (the plain pulsing shapes, kept for salience piloting).
  VISUAL_MODE: "dancers",
  DANCER_HEIGHT_PX: 260, // at the reference width; multiplied by the scale factor
  DANCER_MOTION: {
    weakBob: 3, // head drop on every beat
    strongBob: 6, // extra head drop on strong beats
    dip: 4, // knee bend (whole upper body drops) on strong beats
    tap: 28, // toe lift angle in degrees before a strong beat
    armSwing: 7, // arm rotation on strong beats, degrees
    tilt: 4, // head tilt on strong beats, degrees
  },
  // "random": each trial draws a new pair of characters from Dancer.randomPair (distinct shirt
  // hues and hair), each tapping its right foot; the specs are saved as character_left/right.
  // Set to an object { left: {...}, right: {...} } (like FIXED_CHARACTERS) to keep the same two
  // characters on the same sides all session. Which side carries the duple meter is randomized
  // per trial either way (see duple_side).
  CHARACTERS: "random",
  FIXED_CHARACTERS: {
    left: {
      name: "Juniper",
      hair: "puff",
      eyes: "closed",
      tapFoot: "right",
      colors: {
        skin: "#a8673c",
        hair: "#1e1512",
        shirt: "#3d7a6b",
        accent: "#f2d16b",
        pants: "#334a6e",
        shoes: "#d94b3d",
        headphones: "#f3efe6",
      },
    },
    right: {
      name: "Otto",
      hair: "swoop",
      eyes: "open",
      tapFoot: "right",
      colors: {
        skin: "#f0c9a8",
        hair: "#d9782a",
        shirt: "#2f3f6b",
        accent: "#f3efe6",
        pants: "#c9b48a",
        shoes: "#f3efe6",
        headphones: "#25211f",
      },
    },
  },

  // AOIs (logged only; assignment happens offline)
  AOI_CIRCLE_HALF_WIDTH_PX: 150,
  AOI_CENTER_HALF_WIDTH_PX: 100,

  // Choice
  CHOICE_KEYS: { left: "f", right: "j" },
  RESPONSE_LOCKOUT_MS: 4000, // from beat 0; responses are ignored this long, then the prompt appears

  // Practice trials: settings here replace the top-level ones above. Practice is short and
  // unambiguous: sound only on strong beats (not generated), and dancers that
  // move only on their own strong beats, so the one tapping along with the sound is obvious.
  PRACTICE: {
    PHASE_BEATS: { cue: 12, post_cue: 0 },
    RHYTHM_PATTERNS: {
      duple: { sub: 1, meter: 2, voices: { block: "X." } },
      triple: { sub: 1, meter: 3, voices: { block: "X.." } },
    },
    DANCER_MOTION: { weakBob: 0, strongBob: 10, dip: 8, tap: 40, armSwing: 14, tilt: 7 },
    CIRCLE_WEAK_DIAMETER: 80, // circles mode: no pulse on weak beats
  },

  // Design
  TRIALS_PER_CELL: 6, // 2 cued meters x 2 reversal x 6 = 24 main trials
  MAX_CUED_METER_RUN: 2,
  ITI_MS: 1500,
  VALIDATE_EVERY_N_TRIALS: 8,

  // Eye tracking
  VALIDATION_POINTS_5: [[50, 50], [20, 20], [80, 20], [20, 80], [80, 80]],
  MAX_VALIDATION_ERROR_VIEWPORT: 0.15, // placeholder until the acceptable threshold is decided
};
