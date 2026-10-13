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
| 1 | Pure logic: flow and TIMI, devices, physiology, guide and wire, stages, debrief | done: 289 unit tests, no UI yet |
| 2 | Procedural heart and vessels, 3D view | not started |
| 3 | Devices and the six-stage procedure UI | not started |
| 4 | X-ray view and C-arm | not started |
| 5 | Demo autopilot and complications | not started |
| 6 | README polish, CI, deploy decision | not started |

The start screen's buttons stay disabled until the 3D lab exists.
