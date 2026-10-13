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

## Not done yet

Everything visual and interactive: the heart and vessel meshes, both views, the C-arm, devices on screen,
the HUD, mentor panel and monitor, sound, the demo autopilot, and the "no console errors" run. The
specification's "demo ends with an Excellent debrief" is therefore only tested here at the logic level
(`tests/scenario.test.ts`), by chaining the real modules for a good case and for the bad case.
