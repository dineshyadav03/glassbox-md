# Brain Surgery Simulator (educational)

A browser simulator of microsurgical clipping of a right internal carotid to posterior communicating artery (IC-PC)
aneurysm through a pterional, transsylvian approach, seen through an operating microscope.

**Educational only. It is not clinical training, not a medical device and not medical advice. The anatomy is
simplified, procedural 3D shapes and every number is invented** (see [DESIGN-NOTES.md](DESIGN-NOTES.md)). It is not
connected to the Glassbox MD diagnostic pipeline or to any case.

## Status: milestone M1 of M6

Done: the operating-microscope view of the field (folded lobes, the sylvian fissure that opens and closes, ICA, M1 and
M2, A1, PCom, anterior choroidal artery, optic and oculomotor nerves, the 6.6 mm aneurysm with its bleb, the two
retractor blades, arachnoid membrane in cuttable segments), pulsing arteries, labels, zoom, pan and a limited orbit.

Next: the toolbar and ten tools (M2), stages and mentor (M3), vitals and bleeding (M4), clipping, ICG, Doppler and
endoscope (M5), debrief, demo, English and Japanese (M6). The plan is in [PLAN.md](PLAN.md).

## Run it

Needs Node 20 or newer.

```bash
cd neurolab
npm install
npm run dev        # http://localhost:5173/neurolab/
npm test           # unit tests
npm run build      # production build into dist/, which the Glassbox app serves at /neurolab/
```

Inside the Glassbox app: build it once, restart the app, and pick "Brain surgery simulator" in the start menu.

Keys: `L` labels, `O` open or close the fissure, `R` reset view. Drag to look around, scroll to zoom, right-drag to move.

## Changing the anatomy

Every size and position is in `src/config/anatomy.ts`. For example, `aneurysm.domeDiameterMm: 6.6` makes the dome
10 mm wide if you change it to `10`.
