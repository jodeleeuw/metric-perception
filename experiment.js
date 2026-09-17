// URL flags for testing:
//   ?eyetracking=0  skip saccade.js; record mouse position as gaze instead
//   ?quick=1        6-beat phases and 4 main trials, for walking through the flow
const params = new URLSearchParams(window.location.search);
const USE_EYETRACKING = params.get("eyetracking") !== "0" && typeof jsPsychExtensionSaccade !== "undefined";
const QUICK = params.get("quick") === "1";

if (QUICK) {
  for (const phase of Object.keys(CONFIG.PHASE_BEATS)) CONFIG.PHASE_BEATS[phase] = 6;
}

const jsPsych = initJsPsych({
  extensions: USE_EYETRACKING ? [{ type: jsPsychExtensionSaccade }] : [],
  on_finish: () => {
    // TODO: replace with the lab's data pipeline endpoint.
    jsPsych.data.get().localSave("json", `metrical-trajectory-${Date.now()}.json`);
  },
});

jsPsych.data.addProperties({ eyetracking: USE_EYETRACKING, quick_mode: QUICK });

// ---- design -------------------------------------------------------------------------------------

function buildMainTrials() {
  const trials = [];
  for (const cued_meter of ["duple", "triple"]) {
    for (const reversal of [true, false]) {
      const sides = jsPsych.randomization.shuffle(["left", "right"]);
      for (let i = 0; i < CONFIG.TRIALS_PER_CELL; i++) {
        trials.push({ cued_meter, reversal, duple_side: sides[i % 2] });
      }
    }
  }
  // Reject orders where the same cued meter runs longer than allowed.
  let order;
  do {
    order = jsPsych.randomization.shuffle(trials);
  } while (maxRun(order.map((t) => t.cued_meter)) > CONFIG.MAX_CUED_METER_RUN);
  return QUICK ? order.slice(0, 4) : order;
}

function maxRun(values) {
  let best = 0;
  let run = 0;
  values.forEach((v, i) => {
    run = i > 0 && v === values[i - 1] ? run + 1 : 1;
    best = Math.max(best, run);
  });
  return best;
}

const PRACTICE_TRIALS = jsPsych.randomization
  .shuffle(["duple", "triple"])
  .map((cued_meter) => ({
    cued_meter,
    reversal: false,
    duple_side: jsPsych.randomization.sampleWithoutReplacement(["left", "right"], 1)[0],
  }));

const PRACTICE_CONFIG = { ...CONFIG, ...CONFIG.PRACTICE };

// ---- trial builders -----------------------------------------------------------------------------

function metricalTrial(condition, trialType, trialNumber) {
  return {
    type: jsPsychMetricalTrajectory,
    ...condition,
    config: trialType === "practice" ? PRACTICE_CONFIG : CONFIG,
    response_lockout_ms: CONFIG.RESPONSE_LOCKOUT_MS,
    simulate_gaze_with_mouse: !USE_EYETRACKING,
    // Attaching the extension also stores its own saccade_data and saccade_timing per trial.
    extensions: USE_EYETRACKING ? [{ type: jsPsychExtensionSaccade }] : [],
    data: { task: "metrical_trajectory", trial_type_label: trialType, trial_number: trialNumber, ...condition },
  };
}

const iti = {
  type: jsPsychHtmlKeyboardResponse,
  stimulus: "",
  choices: "NO_KEYS",
  trial_duration: CONFIG.ITI_MS,
  on_start: () => (document.body.style.background = CONFIG.BACKGROUND_COLOR),
  data: { task: "iti" },
};

function validationCheck(label) {
  return {
    timeline: [
      {
        type: jsPsychSaccadeValidate,
        validation_points: CONFIG.VALIDATION_POINTS_5,
        data: { task: "validation", validation_label: label },
      },
      {
        timeline: [
          {
            type: jsPsychHtmlKeyboardResponse,
            stimulus: "",
            choices: "NO_KEYS",
            on_load: () =>
              jsPsych.abortExperiment(
                "<p>The eye tracker is no longer accurate enough to continue. Thank you for your time.</p>",
                { task: "abort", reason: "validation_failed", validation_label: label }
              ),
          },
        ],
        conditional_function: () => {
          const last = jsPsych.data.get().filter({ task: "validation" }).last(1).values()[0];
          return last.median_error_viewport > CONFIG.MAX_VALIDATION_ERROR_VIEWPORT;
        },
      },
    ],
  };
}

// ---- timeline -----------------------------------------------------------------------------------

const timeline = [];

if (USE_EYETRACKING) {
  timeline.push(
    { type: jsPsychSaccadePreview, data: { task: "eyetracking_setup" } },
    { type: jsPsychSaccadeTimeSync, data: { task: "eyetracking_setup" } },
    { type: jsPsychSaccadeCalibrate, data: { task: "calibration" } },
    {
      type: jsPsychSaccadeValidate,
      data: { task: "validation", validation_label: "initial" },
    }
  );
}

const k = CONFIG.CHOICE_KEYS;
const stimulusNoun = CONFIG.VISUAL_MODE === "dancers" ? "two characters dancing to a rhythm" : "two circles that pulse in time with a rhythm";
const choiceVerb = CONFIG.VISUAL_MODE === "dancers" ? "dancer whose dancing fit the rhythm better" : "shape whose movement fit the rhythm better";
timeline.push({
  type: jsPsychHtmlButtonResponse,
  stimulus: `<p>You will see ${stimulusNoun}.</p>
    <p>Watch them while the rhythm plays.</p>
    <p>After a moment, a question appears. Whenever you are ready, choose the ${choiceVerb}:
    click it, or press <b>${k.left.toUpperCase()}</b> for left and <b>${k.right.toUpperCase()}</b> for right.
    The rhythm keeps playing until you choose.</p>
    <p>We will start with two practice trials.</p>`,
  choices: ["Start practice"],
  // A click is a user gesture, so the AudioContext can start here.
  on_finish: () => jsPsychMetricalTrajectory.initAudio(CONFIG),
});

PRACTICE_TRIALS.forEach((condition, i) => {
  timeline.push(iti, metricalTrial(condition, "practice", i + 1));
});

timeline.push({
  type: jsPsychHtmlButtonResponse,
  stimulus: "<p>Practice is over. The main part of the study starts now.</p>",
  choices: ["Continue"],
});

buildMainTrials().forEach((condition, i) => {
  timeline.push(iti, metricalTrial(condition, "main", i + 1));
  const n = i + 1;
  if (USE_EYETRACKING && n % CONFIG.VALIDATE_EVERY_N_TRIALS === 0 && n < 24) {
    timeline.push(validationCheck(`after_trial_${n}`));
  }
});

timeline.push({
  type: jsPsychHtmlButtonResponse,
  stimulus: "<p>All done. Thank you for participating!</p>",
  choices: ["Finish"],
  on_start: () => (document.body.style.background = ""),
});

jsPsych.run(timeline);
