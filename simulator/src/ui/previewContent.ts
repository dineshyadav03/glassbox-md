/** Text for the 3D anatomy preview, as plain data so tests can check it without a DOM. */

export const PREVIEW_TITLE = 'Anatomy preview';

/** Shown on the preview screen so it never reads as a finished simulator. */
export const PREVIEW_NOTE =
  'You are looking at a simplified, stylised model: the beating heart, the coronary arteries drawn at their true ' +
  'lumen size, the aorta and the arteries from the right wrist. Only the camera is interactive so far; the ' +
  'devices, procedure, X-ray view and demo mode are not built yet.';

export const PREVIEW_DISCLAIMER = 'Educational demonstration only. Simplified anatomy with invented numbers. Not clinical training, not medical advice.';

export const PREVIEW_HINT = 'Drag to orbit, scroll to zoom, right-drag to pan. Hover a label for detail.';

export const NO_WEBGL_MESSAGE =
  'This browser could not start WebGL, so the 3D anatomy cannot be shown. Try a current version of Chrome, Edge, Firefox or Safari, ' +
  'with hardware acceleration enabled.';

/** Keyboard shortcuts that work in the preview. */
export const PREVIEW_KEYS: readonly (readonly [string, string])[] = [
  ['L', 'Toggle anatomy labels'],
  ['H', 'Frame the heart'],
  ['R', 'Frame the whole route, wrist to heart'],
  ['Esc', 'Back to the start screen'],
];
