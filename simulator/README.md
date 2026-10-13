# Cath Lab: PCI Simulator (educational)

A browser-based **educational** simulator of percutaneous coronary intervention (PCI): stenting a 90%
mid-LAD stenosis through the right radial artery. It is a coding project and a teaching demo. **It is
not clinical training and not medical advice.** Its anatomy, physiology, device rules and scoring are
simplified models with invented numbers, and it must not be used to make or inform any clinical
decision. Keep the disclaimer on the start screen if you share or modify it.

It is part of the Glassbox MD app: the app serves the built simulator at `/cathlab/` on its own server
(`src/glassbox_md/cathlab.py`), behind the same login when login is configured, and offers it from the start
menu. It is **not connected to the diagnostic pipeline**: the pipeline reasons about real-shaped documents,
this simulates a procedure with made-up physiology, so it reads no case and no patient report links to it;
mixing the two would blur what each one claims.

The design follows a public specification-style prompt (Vite + strict TypeScript + Three.js + Vitest,
simulation logic in pure functions, every constant in one config file, 1 scene unit = 1 mm).

## Run it

Inside Glassbox MD (the normal way): build once, then start the app and use the start menu.

```bash
cd simulator
npm install
npm run build      # typecheck + production build into simulator/dist
cd ..
chainlit run app.py -w     # then http://localhost:8000/cathlab/
```

While working on the simulator itself:

```bash
cd simulator
npm run dev        # hot reload at http://localhost:5173/cathlab/
npm test           # unit tests
```

The build is for the path `/cathlab/` (`base` in `vite.config.ts`); a Python test checks it matches the
server. Needs Node 20 or newer.

## Status

| Phase | What | State |
|---|---|---|
| 0 | Scaffold, strict TypeScript, tests, disclaimer start screen | done |
| 1 | Pure logic: flow and TIMI, devices, physiology, guide and wire, stages, debrief | done: 289 unit tests |
| 2 | Procedural heart and vessels, 3D view | done: beating heart, six coronaries at true lumen, aorta, wrist-to-root route, labels, orbit camera |
| 3 | Devices and the six-stage procedure UI | done: playable end to end with a scored debrief (see below for what is simplified) |
| 4 | X-ray view and C-arm | not started |
| 5 | Demo autopilot and complications | not started |
| 6 | README polish, CI, deploy decision | not started |

**What you can do today:** the whole case is playable in the browser. Press "Enter the cath lab" and work through
the six steps: advance the guide from the wrist to the aortic root, seat it in the left main, take a diagnostic
angiogram, give heparin, steer the wire into the LAD and across the lesion without forcing it, pre-dilate with a
balloon, size and deploy a stent, and finish with an angiogram from two projections. You then get a scored debrief
that explains each item. The screen has the step checklist with a "Why this step?" note, a tool bar that locks tools
until their step (saying why), a tip-rotation dial with the target angles, a pressure gauge with the balloon's rated
and rupture pressures, a patient monitor with a live ECG, and a mentor log. Keys: `1`-`4` tools, `W`/`S` or the wheel
advance and retract, `A`/`D` rotate, `Shift` fine, `E`/`Q` inflate and deflate, `G` heparin, `C` or `5` contrast,
`7` measure, `Space` or `6` fluoro pedal, `V` C-arm, `L` labels, `F` follow, `H` help, `M` mentor, `Esc` pause.
On a touch screen the on-screen buttons can be held instead.

**What is not built:** the X-ray (fluoroscopy) view and C-arm images, the demo autopilot, and sound. Until the X-ray
view exists, contrast is drawn straight onto the 3D vessels, and the C-arm projection is only a setting that the
final-angiogram step counts (two different projections are required). The start screen and the help panel say so.

## How the 3D part is organised

- `src/anatomy/` is pure maths with no Three.js: vectors, splines, the heart surface, the centrelines of every
  vessel and the access route, tube meshes, label data. All of it is unit tested.
- `src/scene/anatomyScene.ts` builds the Three.js scene from that, and can be built and checked in node.
- `src/engine/simulation.ts` is the procedure engine: pure `tick` and `act` functions that step the guide, wire,
  balloon and stent catheters, the patient and the stage progress together. A scripted learner
  (`tests/helpers/player.ts`) plays the whole case through it, so the stage rules are proven completable.
- `src/scene/devices.ts` draws the devices, dissection flaps and contrast from a `Simulation`; headless-safe.
- `src/ui/hudModel.ts` computes everything each panel shows (tested); `hud.ts`, `gauges.ts`, `monitor.ts` and
  `debriefScreen.ts` only place it in the DOM; `input.ts` maps keys, on-screen holds and the wheel to controls.
- `src/scene/viewer.ts` and `src/ui/labScreen.ts` are the only code that touches WebGL, frames and browser events.
  They are checked by playing in a browser, not by unit tests.
- Each vessel's 3D path is cut or extended to exactly its configured length, so what the rules say (distance along
  a rail) and what is drawn cannot drift apart.
