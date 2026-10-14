# Design notes: Brain Surgery Simulator

Teaching choices, not facts. The first section lists every invented number so nobody mistakes one for a measurement.

## Invented numbers (M1)

All in `src/config/anatomy.ts`, in millimetres. Change a value there and the scene, labels and tests follow it.

| What | Value | Note |
|---|---|---|
| Aneurysm dome | 6.6 mm | The brief's size; one number to edit |
| Aneurysm neck | 3.2 mm, 1.0 mm stalk | Chosen so the neck is clearly narrower than the dome |
| Aneurysm direction | posterolateral and down | `(0.85, -0.45, -0.25)` |
| Junction | 8.5 mm back from the ICA bifurcation | Posterior communicating artery leaves here |
| ICA radius | 2.4 to 2.1 mm | Simplified |
| M1 / A1 / M2 | 1.6 to 1.25, 1.3 to 1.1, about 1.0 mm | Simplified |
| PCom / anterior choroidal | 0.75 and 0.5 mm | Simplified |
| Lobes | ellipsoids with sine-wave folds, 2.6 mm deep | Not an atlas |
| Fissure opening | each lobe moves 12 mm | Closed gap is about 12 mm; open is about 36 mm |
| Pulse | arteries swell 4% of their radius | Visual only |

## Invented numbers (M2: the tool rules)

All in `src/config/rules.ts`. They are teaching choices, not clinical standards.

| Rule | Value |
|---|---|
| Membrane order | outer first: lateral, mid, deep, then the carotid cistern |
| Fissure opening allowed | one third per fissure segment cut (the carotid cistern does not add to it) |
| Suction rate | 4 pool units per second |
| Bipolar to seal a small ooze | 1 s; a brisk leak from a cut artery needs 3 s |
| Bipolar on a vessel or nerve before it is injured | 2.5 s |
| Dissector step on the neck | 25% per stroke; fissure at least 60% open and the carotid membrane cut first |
| Neck free enough to clip | 75% |
| Dome strain | 0.3 per rough stroke; 0.1 per second of suction; 0.5 per second of bipolar; rupture at 1 |
| Temporary clip: warn, long | 180 s, 300 s (the debrief will use these) |
| Retraction warning | 600 s |
| Clip angle, depth | up to 90 degrees each way in 10 degree steps; depth 0 to 1 in 0.1 steps |

What the neck is, for pointing: the half of the sac nearest the carotid, so it can be reached from the side the camera
sees. The aneurysm now points mostly outward (lateral) and down, with only a little backward, for the same reason.

What a tool does not do yet: bleeding has no effect on vitals (M4); the clip is recorded but not evaluated (M5); the
Doppler gives a text reading, not a tone (M5); stages and the mentor are not there (M3).

## How M1 looks the way it does

- **Procedural anatomy.** Lobes are folded ellipsoids built from a few sine waves (no random numbers, so the same config
  always gives the same brain). Vessels and nerves are tubes along smooth splines; the code starts every branch exactly
  on its parent, so editing the ICA moves everything attached to it. The aneurysm is a sac of revolution (stalk, cone,
  sphere) plus a small bleb sphere.
- **Microscope look.** A narrow field of view, a headlight that travels with the camera, a circular vignette over the
  canvas, and orbit limited to a cone around the straight-on view. In a narrow or portrait window the field of view is
  widened so the deep vessels do not fall off the sides.
- **No depth of field yet.** The plan flagged blur plus transparent membrane as a risk to prototype in M1. I did not add
  the `postprocessing` dependency: the vignette and lighting carry the look, and a blur pass can be tried later without
  changing the scene. The membrane is therefore drawn as soft translucent ovals that stretch with the fissure.
- **Shading trap found.** A strong clear-coat made the arteries render almost black under the headlight in this scene;
  the vessel materials use a light clear-coat instead.

## Known rough edges, on purpose for now

- Anatomy labels are always shown when on, even for structures the closed lobes hide. Hiding them by occlusion belongs
  with the stages (M3), when "identify this structure" becomes a task.
- Labels and the start screen are English only; Japanese arrives in M6.
- The membrane ovals look like panes rather than strands. A better look is a texture task for the polish milestone.

## Verification

Geometry and rules are tested in node (113 tests): aneurysm size and its config edit, branch connections, label
placement, fold height bounds, fissure opening, membrane cutting, pulse swelling, camera maths. What the picture looks
like is checked by eye in the browser; I say so plainly rather than claim a test proves it looks right.
