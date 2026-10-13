/** Text for the lab screen, as plain data so tests can check it without a DOM. */

export const LAB_TITLE = 'Cath Lab: PCI Simulator';

export const LAB_DISCLAIMER =
  'Educational demonstration only. Simplified anatomy and invented numbers. Not clinical training, not medical advice.';

/** What is and is not here yet, shown in the help panel so the screen never overclaims. */
export const LAB_LIMITS =
  'Not built yet: the demo autopilot and sound. The X-ray picture is a simplified teaching image (flat shadows of a ' +
  'stylised anatomy), and contrast also shows on the vessels in the 3D view as a teaching aid.';

export const NO_WEBGL_MESSAGE =
  'This browser could not start WebGL, so the 3D lab cannot be shown. Try a current version of Chrome, Edge, Firefox or Safari, ' +
  'with hardware acceleration enabled.';

export const LAB_TOUCH_HINT = 'On a touch screen, press and hold the on-screen buttons instead of the keys.';

export const PAUSE_TEXT = 'Paused. The patient and the clock are stopped.';

export const END_CASE_WARNING = 'Ending now scores the case as incomplete.';

/** The grade colour classes used by the debrief, by grade. */
export const GRADE_CLASS: Readonly<Record<string, string>> = {
  Excellent: 'grade-excellent',
  Good: 'grade-good',
  Acceptable: 'grade-acceptable',
  'Needs work': 'grade-needs-work',
  Incomplete: 'grade-incomplete',
};

export const STATUS_WORD: Readonly<Record<'ok' | 'warn' | 'bad', string>> = {
  ok: 'Good',
  warn: 'Could be better',
  bad: 'Problem',
};
