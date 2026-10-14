# Plan: Brain Surgery Simulator (aneurysm clipping), for approval

**Status: approved with the fastest defaults (D1 copy, D2 English+Japanese, D3 no reviewer, D4 straight+curved clips, D5 before the Atlas). M0 done (shell served at `/neurolab/`, labs mounted by `labs.py`); M1 next.**

Source: the "Build a Brain Surgery Simulator in Your Browser" build guide you pasted (the prompt and milestones).
Where it will live: `neurolab/` in this repository, served by the Glassbox MD app at `/neurolab/`, the same way
the cath lab is served at `/cathlab/`. Not connected to the diagnostic pipeline.

## 1. What it is, and what it must say

A browser simulator of microsurgical clipping of a right internal carotid to posterior communicating artery
(IC-PC) aneurysm through a pterional, transsylvian approach: an operating-microscope view, six stages, ten tools,
live vitals, bleeding and rupture, clip evaluation by ICG and Doppler, a debrief, a demo mode, and English and
Japanese.

It must say on its start screen, in the README and on the debrief that it is **educational only, not clinical
training, not a medical device, not medical advice**, and that the anatomy is simplified, procedural 3D shapes. Same
rule as the cath lab: that wording is part of the product and has a test.

## 2. The honest difference from the cath lab

The cath lab guide gave me numbers (pressures, thresholds, sizes, a scoring list). This one gives **almost none**:
a 6.6 mm aneurysm, six stage names, ten tool names, and a list of vitals. Everything else (how fast blood is lost,
how a rupture raises risk, how long a temporary clip can stay on, what makes a clip "good", how the debrief scores)
I would have to invent. I did the same for the cath lab and listed every invented number in `DESIGN-NOTES.md`; I would
do that again here. **I am not a neurosurgeon**, so a clinician reviewing the stage rules, the tool rules and the
scoring before anyone treats it as more than a demo is the one thing I would ask you to arrange. It is also the one
risk that no amount of testing on my side removes.

## 3. How it is built (same discipline as the cath lab)

- Vite + strict TypeScript + Three.js + Vitest; no backend; state in memory.
- Folders as the guide asks: `src/scene`, `src/anatomy`, `src/tools`, `src/procedure`, `src/ui`, `src/physics`,
  `src/audio`, plus `src/config/anatomy.ts` (every size and position in one file) and `src/i18n`.
- **Rules are pure functions with unit tests**; only the renderer, audio and DOM events are not unit tested. Same split
  that let me prove the cath-lab demo scores Excellent at any frame rate.
- A pure engine (`tick` / `act`) like the cath lab's, so a scripted learner can play the whole case in a test, and the
  demo autopilot drives the same engine through the same controls (the guide asks for exactly this, and for "click to
  take over").
- A real-build integration test in Python, as for the cath lab, so a wrong base path cannot ship as a blank page.

### Reuse from the cath lab (what exists today)

| Already built | Reuse here |
|---|---|
| `anatomy/vec3`, `spline`, `tubeGeometry` (tubes along splines, parallel-transport frames, radius as a function) | Vessels (ICA, M1, M2, A1, PCom, anterior choroidal) are exactly this |
| `ui/dom`, `input` (held keys, wheel, on-screen holds), `hudModel` pattern, `monitor` (ECG canvas) | Keys 1-0, vitals panel, ECG trace |
| `audio/cues` + `sound` (synthesised tones, fake-context tests) | Alarms, and a new Doppler tone |
| `procedure/stages` pattern, `evaluation` pattern, `demo/autopilot` pattern | Checklist, debrief, demo mode |
| `scene/viewer` (orbit camera, labels, pointer picking), `framing` | Camera and labels |
| `cathlab.py` (mount behind the login, redirect, path guard) | Generalise to serve several labs |

New work: the microscope look, procedural brain and arachnoid, ten tool behaviours, bleeding and pooling, the clip
model and its evaluation, the Doppler/ICG/endoscope views, Japanese.

**Decision needed (section 8, D1):** the reusable pieces currently live inside `simulator/`. Either I move them into a
small `shared/` folder both apps import (cleaner; touches the cath lab, whose 552 tests would guard it), or I copy what
I need (faster; duplicates code). I recommend extracting, as the first and separately committed step.

## 4. The model I would build (all numbers to be listed in `DESIGN-NOTES.md`)

**Anatomy (procedural, in `config/anatomy.ts`):** frontal and temporal lobes with the sylvian fissure between them;
arachnoid as separate cuttable membrane segments; ICA, M1 (and M2 branches), A1, PCom, anterior choroidal artery as
splines with radii; optic and oculomotor nerves; a 6.6 mm aneurysm at the IC-PC junction projecting posterolaterally
and downward, with a bleb; two spatulas. Tissue shading is moist and glossy with a pulse synced to heart rate. Every
size and position is a config value, so changing 6.6 mm to 10 mm is a one-line edit, as the guide intends.

**Ten tools, each with a testable rule** (from the guide): suction clears pooled blood; scissors cut arachnoid segments
(a segment is either intact or cut, not a mesh boolean); bipolar stops small bleeding points; dissector frees the
aneurysm neck; spatula holds the lobes apart; clip (straight or curved) is positioned, rotated and set to a blade depth,
then applied; ICG switches to a fluorescence view of which vessels are filling; Doppler plays a pulsing tone on a vessel
with flow and silence where flow is blocked; endoscope opens a picture-in-picture from behind the aneurysm; temporary
clip on the ICA lowers bleeding and starts an occlusion timer.

**Six stages** (each unlocks when its goals are met): open the sylvian fissure; identify M1; identify the ICA and optic
nerve; confirm the PCom and dissect the aneurysm neck; clip the aneurysm; confirm PCom patency. Each has sub-tasks, a
calm hint and a "why this step" note, like the cath lab.

**Physiology:** ECG, HR, arterial BP, SpO2, operation time, temporary occlusion timer, estimated blood loss, MEP %.
Bleeding lowers BP and raises HR; a long temporary occlusion lowers MEP. A hidden rupture risk rises with rough handling
of the dome; oozing from small vessel injuries is stopped by bipolar; a rupture is fast arterial bleeding that fills the
field, and the learner must suction, apply a temporary clip, then clip definitively. Blood is a particle/decal effect
plus a pooling layer that rises over time.

**Clip evaluation:** after clipping, check neck fully closed, no residual neck, ICA not narrowed, PCom and anterior
choroidal still open, and *show* it through ICG and Doppler (what the guide stresses), not just a message.

**Debrief:** total time, blood loss, temporary occlusion time, rupture yes or no, clip result, and specific tips, as a pure
function of a case summary, tested on a good case, a rupture, a bad clip, and a too-long temporary clip.

## 5. Milestones (the guide's six, with a zero in front)

Each is runnable, tested, committed on its own, and I stop and tell you what to look at before the next.

| | Deliverable | Checked by |
|---|---|---|
| **M0** | Extract the shared core (if you choose D1 = extract); generalise `cathlab.py` into a lab-mounting module; a menu entry; empty `neurolab/` app that builds and is served | cath-lab tests unchanged and green; Python test serves both builds |
| **M1** | Scene, camera, microscope look, procedural anatomy | loads; zoom/pan; lobes, arteries, nerves visible; config edit changes the aneurysm |
| **M2** | Toolbar and the ten tools | keys 1-0; own cursors; scissors cut a segment; each rule has a unit test |
| **M3** | Stage engine, checklist, mentor panel | sub-tasks tick; stages unlock; a scripted learner completes stages 1-4 |
| **M4** | Vitals and bleeding | vitals react to injury; rupture needs suction + temporary clip + clip; physiology tests |
| **M5** | Clipping, ICG, Doppler, endoscope | clip placement/evaluation tests; Doppler tone only on flowing vessels |
| **M6** | Debrief, demo, English/Japanese, polish, README/CI | demo ends on an Excellent debrief with no console errors; both languages complete |

## 6. Risks I can already see

- **Looking real.** Procedural lobes and arteries can look crude; the microscope vignette, depth of field and lighting
  carry a lot of the effect. `postprocessing` 6.39 supports these and needs Three.js `>=0.168 <0.187`; the simulator
  uses 0.186, so it fits, but Three.js must be pinned below 0.187.
- **Depth of field with transparency.** Semi-transparent arachnoid plus a blur pass often misbehaves; I would prototype
  that first in M1 and fall back to a simpler focus effect if it does.
- **Blood.** A particle system plus a rising pool must stay at a good frame rate; I would measure rather than guess.
- **Japanese.** I can write it, but a native reader should check it before it is called good. The language toggle will
  be tested for *completeness* (every key has both languages), not for quality.
- **Verification.** As with the cath lab, the browser pane here only paints when a screenshot is taken, so I verify
  visuals by eye and logic by tests, and I will say plainly which is which. Sound is verified against a fake audio
  context, not by ear.

## 7. What it will not do

No real patient data, no connection to the diagnostic pipeline, no clinical claims, no scoring that pretends to be an
assessment standard. Thresholds and weights will be labelled teaching choices, as in the cath lab debrief.

## 8. Decisions I need from you

- **D1.** Shared code: extract into `shared/` first (recommended) or copy?
- **D2.** Languages: English and Japanese as the guide says. Do you want any others, and can you get a native Japanese
  reader to review?
- **D3.** Is there a clinician (or a med-student friend, as the guide suggests) who can review stage rules and scoring?
- **D4.** Clip variants: straight and curved as in the guide, or more?
- **D5.** Order: this before or after the Human Atlas plan?

Approve with changes, or tell me what to cut, and I will start at M0 and report after each milestone.
