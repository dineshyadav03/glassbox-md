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
Doppler gives a text reading, not a tone (M5).

## Judging the clip (M5)

`physics/clipEval.ts`, with every threshold in `RULES.clip`. A clip is a bar across the neck, turned about the neck's
axis and set to a blade depth. The angles are worked out from the anatomy, so a config edit moves them: the angle at
which the bar lies along the parent artery (the ideal), and the angles at which a deep clip points at the PCom or at the
anterior choroidal artery. With the shipped anatomy those are about -56, -17 and +87 degrees.

| Judgement | Rule |
|---|---|
| Neck closed | less than 0.5 mm left open. Straight clip needs depth 0.7, curved 0.8; turned off the artery by more than 35 (straight) or 55 (curved) degrees leaves up to 40% of the neck open |
| Carotid narrowed | blades deeper than 0.9 reach into it (up to 60%); a large turn adds up to 40% (half for a curved clip) |
| Branch pinched | depth at least 0.8 and the bar within 25 degrees of the branch |
| Beyond a blocked carotid | at 70% narrowing the arteries beyond lose flow |
| Rupture still bleeding | a clipped but unclosed sac leaks at 30% of the free rate |

The checks the learner makes (Doppler on the sac and the PCom, ICG) record what they found, good or bad, and the mentor
only comments on what has been checked: it does not announce the result of a clip nobody has looked at. Removing the
clip, or placing another, clears them. The Doppler is now held on a vessel; it makes one short whoosh per heartbeat
while the probe is on a vessel with flow, and nothing otherwise (synthesised, no audio files; tested with a fake audio
context, not by ear).

## Vitals and bleeding (M4)

All in `config/rules.ts` (`bleed*`, `pool*`, `vitals`), invented.

| Rule | Value |
|---|---|
| Blood loss | 0.03 ml/s from a small ooze, 0.4 ml/s from a cut artery, 10 ml/s from a rupture that has no clip |
| Temporary clip on the carotid | every leak falls to 20% |
| Clip across the neck | stops the rupture bleeding (how well it is placed is judged in M5) |
| Pool | 0.5 pool unit per ml, at most 20; suction clears 4 units/s, so it keeps up with a clamped rupture (1 unit/s) but not a free one (5 units/s) |
| Field hidden | at 8 pool units the dissector and the clip are refused until it is suctioned |
| Vitals | baseline HR 72, BP 118/74, SpO2 99; they move toward HR +60, SBP -65, DBP -35, SpO2 -9 as loss approaches 1500 ml, with a 20 s lag |
| MEP | falls 0.25%/s after 90 s on the temporary clip, recovers 0.4%/s once it is off and the pressure is adequate; low pressure also lowers it |
| Alarms | SBP below 90, SpO2 below 92, MEP below 80, HR above 120 |

The monitor draws a synthetic ECG at the current heart rate, which is also the rate the arteries pulse at. The pool is a
translucent red volume that rises between the lobes, and an uncontrolled rupture shows a jet of drops from the dome.

## The six steps and the mentor (M3)

Stages are pure functions of the field state (`procedure/stages.ts`), so a scripted learner can play them in a test
(`tests/stages.test.ts` plays all six with a clean record).

- A stage is complete when all its sub-tasks are. The current stage is the first that is not; later ones are locked.
  Work done early is remembered and ticks when its stage unlocks, and the mentor announces each step it runs through.
- Sub-tasks read what the state remembers, not what is true right now: the most the fissure was opened, what was cut,
  what was identified, the checks made after clipping. So releasing the spatula does not un-tick step 1. The one
  exception is the clip: take it off to reposition it and step 5 un-ticks until it is on again.
- "Identify" is a teaching device I added: the guide lists steps such as "identify M1", and a checklist needs something
  the learner does. They point at a structure and press `I`. Any artery, nerve or the aneurysm can be identified;
  pointing at the wrong one just tells them what it is.
- The step-6 checks (Doppler silent in the sac, Doppler flowing in the PCom, ICG looked at) only count when a clip is on
  and the temporary clip is off, because only then do they mean anything.
- The mentor's notes are pure too (`procedure/mentor.ts`): a step finished, a refusal explained, an injury or rupture
  with how to think about it, and the strain, temporary-clip and retraction clocks crossing their lines once each. The
  advice for a rupture (suction, temporary clip, then clip) is the plan from the brief; the bleeding it refers to arrives
  in M4.

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

Geometry and rules are tested in node (134 tests): aneurysm size and its config edit, branch connections, label
placement, fold height bounds, fissure opening, membrane cutting, pulse swelling, camera maths. What the picture looks
like is checked by eye in the browser; I say so plainly rather than claim a test proves it looks right.
