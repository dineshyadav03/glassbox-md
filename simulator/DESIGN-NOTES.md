# Design notes: where the specification left room, and what I chose

The specification fixes a lot (stack, sizes, pressures, thresholds, the six stages, the test list) but
leaves some numbers and rules open. These are the choices made in Phase 1, so they can be challenged.
All of them are teaching approximations, not clinical values, and each lives in
`src/config/anatomy.ts` unless noted.

## Where it lives

Inside the Glassbox MD app, not beside it: `src/glassbox_md/cathlab.py` mounts `simulator/dist` at
`/cathlab/` on the app's own server, ahead of Chainlit's catch-all route (which would otherwise answer every
path with the chat page). A bare `/cathlab` gets its own redirect for the same reason. With login configured,
the mount sits behind Chainlit's own session cookie, checked with Chainlit's own helpers. It is not wired to the
pipeline: no case data goes in, nothing comes out, and no report links to it.

## Invented numbers (not in the specification)

- **Vessel lengths and diameters.** LM 12 mm; LAD 110 mm tapering 3.8 to 1.9 mm; LCx 75 mm; D1 leaves
  the LAD at 30 mm, D2 at 70 mm. The lesion sits at 41 to 55 mm, between them. Chosen so the LAD
  reference diameter at the lesion is 2.97 mm (specified: about 2.9 to 3.0).
- **Access route.** Wrist to aortic root is 830 mm (radial 250, brachial 270, axillary 100, subclavian 60,
  brachiocephalic 40, aorta 110). The elbow is at 250 mm.
- **Tip angles.** Left cusp +60 degrees, right cusp -60, non-coronary 180, start at 0. For the wire,
  LAD -45, LCx +20, D1 +70, D2 -70. So a neutral wire tip goes into the circumflex, and the learner has
  to rotate toward the LAD at the end of the left main, then back toward neutral before the diagonals
  (which are entered within 50 degrees of their angle).
- **Contrast speed** 60 mm/s in an unobstructed vessel; rings every 2 mm.
- **Wire risk**: 0.35 risk per second per 100% over the safe speed, capped at 0.9; spinning the wire at
  90 degrees/s doubles the safe speed (8 to 16 mm/s).
- **Physiology**: base heart rate 72, BP 128/76, SpO2 98, ACT 128 s; the rest follows the specified
  20 s rise, 8 s recovery, 40 s and 60 s occlusion thresholds. The BP drop rate and the HR rise are mine.

## Interpretations

- **"flowFactor falls steeply"** is `1 - ((ds - 0.6) / 0.38)^2.5`. The exponent was picked so that a 90%
  stenosis gives 0.45 (TIMI 2) while 75% still gives TIMI 3 and 95% gives TIMI 1.
- **Occlusion "beyond 40 s / 60 s"** counts continuous complete occlusion and resets the moment any flow
  returns, so a brief release avoids instability.
- **An inflated balloon stops flow** only if it is at least 80% of the local reference diameter; a small
  one does not seal. Flow is stopped beyond its proximal end, so D1 (proximal) still fills and D2 does not.
- **"Across the lesion"** for a balloon means it overlaps at least 80% of the lesion and spans its middle,
  so a 12 mm balloon on a 14 mm lesion counts.
- **Stent coverage** margins are measured from the stent's ends to the lesion's ends: negative means it
  stops short (a geographic miss).
- **An oversized balloon's dissection** is placed at its distal end; an oversized stent's just beyond its
  distal end (so that stent cannot seal it); a forced wire's at the lesion centre.
- **The guide cannot translate while the wire is out**, but it can still rotate (and so can still pop out).

## Additions to the specification

- **Safety caps in the debrief.** The specification lists the items and their thresholds but not their
  weights, and says a deliberately bad case must come out "Needs work". The weights (summing to 100) are
  mine. With them alone, an oversized short stent still scored "Acceptable", so an unsealed dissection,
  a balloon rupture or a geographic miss now cap the grade at "Needs work" whatever the score. The
  debrief says when that cap applied.
- **The build-status line** on the start screen, and the disabled buttons, so a half-built app does not
  look finished.

## Phase 2: the 3D anatomy

- **The shapes are stylised, not anatomical measurements.** The heart is a tilted, tapered ellipsoid (apex left,
  forward and down, a fuller right-ventricle border, a flatter base). Control points for each artery are
  hand-placed and then snapped onto that surface, so only their rough course matters.
- **Lengths come from the config, not from the drawing.** Each coronary course is smoothed, snapped to the
  surface, then cut (or, if short, continued straight on) to exactly the configured length. A test requires the
  hand-drawn course to be within a modest factor of that length, so a large cut or extension would fail.
- **The access route is built outward from the aortic root**, so its end at the root is exact, and the far end at
  the wrist is the part that is cut or extended. The boundaries between the six segments therefore fall at the
  configured lengths from the wrist, which only approximates where the real joints would be.
- **True diameters** are drawn: the lesion narrows the LAD to about 0.3 mm, and the radial artery is 2.6 mm. In
  the whole-route view the arm artery is a thin line for that reason.
- **The beat** shrinks the heart and the coronaries together by 7% (systole 38% of the cycle, at the base heart
  rate). The aorta and route do not move, so the coronary openings shift by up to about 3 mm against the aortic
  root during a beat, which the root's width hides. With `prefers-reduced-motion` the heart does not beat.
- **Labels** are HTML over the canvas, dimmed when the point is behind the heart. Heart labels appear only when
  zoomed in, route labels at any zoom, because at whole-route zoom the heart labels overlap. Tooltip lengths are
  read from the config.
- **"Enter the cath lab"** opens this anatomy preview and is labelled as one. The start screen's build-status line
  says what exists and what does not, and the demo button stays disabled.
- **Not verified here:** WebGL rendering is checked by eye in a browser (desktop and a 375 px phone width), not by
  automated tests; the WebGL-unavailable message has not been exercised on a real browser without WebGL.

## Phase 3: devices and the procedure

- **The engine composes, it does not decide.** Every rule (guide seating, wire branch choice, forcing risk,
  pressure-diameter curve, rupture, sealing, flow, physiology, stage latching, tool unlocks, debrief) is in the Phase 1
  modules. `src/engine/simulation.ts` only wires them over time and keeps the bookkeeping the specification asks for:
  contrast volume, fluoroscopy seconds, distinct final projections, heparin timing.
- **Catheters are delivered abstractly through the left main.** A balloon or stent leaves the guide into the LAD
  (its proximal end at the start of the LAD) and slides along the LAD over the wire; the left main passage is not
  simulated. It needs the wire to be in the LAD tree and stays at least 1 mm behind the wire tip.
- **A deployed stent stays.** Withdrawing its delivery catheter files the stent as a lasting treatment and loads a fresh
  one of the same size in the guide. A ruptured balloon is replaced the same way (and counted).
- **Contrast without the pedal is wasted.** An injection with the fluoroscopy pedal up spends the dye but records
  nothing, so it does not count as an angiogram. Without the X-ray view the dye is drawn on the 3D vessels either way.
- **An aortic flush** (guide not seated) uses more dye and fills only the aorta, so it does not count either.
- **A short stent cannot finish the case.** Covering the whole lesion is a required sub-task of step 5, so a stent that
  stops short leaves the step open (the learner must add one, which the debrief counts). Ending the case early then scores
  the geographic miss and grades it "Incomplete".
- **A wire dissection on an untreated lesion is TIMI 1**, not 2: the tear's factor of 0.45 multiplies the lesion's own.
- **The camera follows the tip** at a distance chosen by the tool (far for the arm, near for the wire and catheters);
  dragging cancels a fly-to, `F` toggles following. The plain wheel moves the device, Ctrl+wheel zooms, and when the page
  itself scrolls (narrow layouts) the wheel is left alone so it cannot silently pull a device back.
- **Slow devices run slowly, not wrongly:** a frame is capped at 0.25 s of simulated time and split into 0.05 s steps.
- **Verified by playing in a browser, with limits:** the opening steps, wire steering, resistance meter, balloon
  inflation and gauge, contrast fill, mentor log and monitor were played with real key events; the debrief and the
  deployed stent were rendered from a scripted finished case rather than played live (the browser pane here stops
  animating when hidden). The WebGL-missing message and touch holding have not been tried on real devices.

## Phase 4: the X-ray view and the C-arm

- **The picture is orthographic.** Real fluoroscopy has a diverging beam and magnification; this is a flat shadow of
  the same 3D model the other view draws, seen along the C-arm's beam. LAO is positive and cranial is positive; the
  patient's left is on the right of the image, as on a cath-lab monitor. Foreshortening therefore comes out of the
  geometry (a vessel seen end-on is short) and different projections really do show different vessels.
- **The backdrop is a sketch.** Ribs, spine, forearm and upper-arm bones and a collar bone are simple shapes placed
  by hand, and the heart is the convex shadow of the heart surface, blurred. There are no lungs, diaphragm or soft
  tissue detail. It exists to give the catheters a believable place to move, not to be anatomical.
- **What is visible when.** The anatomy backdrop is always there; the guide, wire, balloon markers and stent struts only
  while the beam is on (pedal down, or a recorded run being acquired); dye only during a run, and only if the run was
  started with the pedal down or the pedal is pressed during it. This is the engine's existing "recorded" rule.
- **The angiogram is the best-filled frame**, kept when the run ends and shown as "LAST ANGIOGRAM (held)" until the next
  fluoroscopy. If the learner switches to the 3D view mid-run the display keeps capturing, so the frame is not lost.
- **A different projection means 20 degrees.** After the stent, a recorded selective injection counts as a new final
  projection only if its beam is at least 20 degrees from every one already counted, so nudging the angle by a few degrees
  does not satisfy step 6. The 20 is mine (`CARM.minSeparationDeg`); the specification only asks for "two projections".
- **The field of view follows the tip**, using the same distance the 3D camera uses (times 1.25), eased over about a second.
- **Dye is drawn on its own layer** where overlapping segments keep the darkest, then multiplied onto the image. Drawing
  each translucent segment separately made beads and bristles at every joint.
- **Dissections** show as a filling defect in the dye (more when unsealed than when a stent covers the tear).
- **Verified by eye** in a browser at several views: the arm view while the guide advances, a mid-run cine with the lesion
  pinch, the held angiogram after a stent. Its content rules (visibility, pinch, defect, foreshortening) are unit tested.
  Frame rate and feel on a real GPU, and the look on other browsers (the blur uses canvas filters, which Safari lacks, so
  soft tissue would look sharper there), have not been checked.

## Not done yet

Sound, and the demo autopilot. The specification's "demo ends with an Excellent debrief" is therefore only
tested at the logic level (`tests/scenario.test.ts`), by chaining the real modules for a good case and for the
bad case.
