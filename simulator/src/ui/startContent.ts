/** Everything the start screen says, as plain data, so a test can assert the
 * disclaimer is present without rendering a DOM. The wording here is part of the
 * product: keep the disclaimer when sharing or modifying this simulator. */

export const TITLE = 'Cath Lab: PCI Simulator';

/** The start screen's headline, split so the second line can be styled quietly. */
export const EYEBROW = 'Glassbox MD · Educational simulator';
export const HEADLINE = 'Cath Lab';
export const SUBTITLE = 'PCI simulator';
export const TAGLINE = 'Stent a 90% blockage in the LAD through the wrist: seat the guide, steer the wire, open the artery, and see how you did.';

export const DISCLAIMER =
  'Educational demonstration only. This is a coding project, not clinical training and not medical advice. ' +
  'The anatomy, physiology, device rules and scoring are simplified teaching models with invented numbers; ' +
  'they must not be used to make or inform any clinical decision. No real patient data is used or accepted.';

export const CASE_VIGNETTE =
  'A 68-year-old, 80 kg patient has exertional angina despite medical therapy. Stress testing shows ' +
  'anterior ischaemia. Angiography is planned to treat a 90% mid-LAD stenosis through the right radial artery.';

export const YOU_WILL: readonly string[] = [
  'Advance a guide catheter from the wrist to the aortic root',
  'Engage the left main coronary artery and take a diagnostic angiogram',
  'Steer a guidewire across the 90% blockage without forcing it',
  'Pre-dilate with a balloon while watching the pressure gauge',
  'Size, position and deploy a stent over the whole lesion',
  'Take a final angiogram in two projections, then review a scored debrief',
];

/** [keys, what they do], from the specification. */
export const CONTROLS: readonly (readonly [string, string])[] = [
  ['1 to 7', 'Select tool: guide, wire, balloon, stent, contrast, fluoro pedal, measure (7 again toggles hovering an artery in 3D for its diameter)'],
  ['W / S or wheel', 'Advance / retract the selected device (Shift for fine movement)'],
  ['A / D', 'Rotate the device tip'],
  ['E (hold) / Q', 'Inflate / deflate the balloon or stent (Shift for fine control)'],
  ['G', 'Give heparin'],
  ['5 or C', 'Inject contrast'],
  ['Space or 6 (hold)', 'Fluoroscopy pedal'],
  ['Tab', 'Switch between the 3D view and the X-ray view'],
  ['V / arrow keys', 'Cycle the C-arm presets (Shift+V goes back) / fine-tune the angle (Shift: 5 degrees)'],
  ['F', 'Follow the device tip with the camera'],
  ['L', 'Toggle anatomy labels'],
  ['H / M / N', 'Help / mentor panel / sound (off until you press N)'],
  ['Esc', 'Pause (during the demo, any key, click or scroll takes control)'],
  ['Drag / Ctrl + wheel', 'Orbit / zoom the 3D camera (the plain wheel moves the selected device)'],
];

/** Honest build status, shown on the screen so a half-built app never looks finished. */
export const BUILD_STATUS =
  'Build status: the lab is playable end to end: all six steps, the devices, the 3D and X-ray views with a movable C-arm, ' +
  'the patient monitor, the scored debrief, a narrated demo and optional sound (press N). Everything is simplified: see the notes in the help panel.';
