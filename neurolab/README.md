# Brain Surgery Simulator (educational)

A browser simulator of microsurgical clipping of a right internal carotid to posterior communicating artery (IC-PC)
aneurysm through a pterional, transsylvian approach, seen through an operating microscope.

**Educational only. It is not clinical training, not a medical device and not medical advice. The anatomy is
simplified, procedural 3D shapes and every number is invented** (see [DESIGN-NOTES.md](DESIGN-NOTES.md)). It is not
connected to the Glassbox MD diagnostic pipeline or to any case.

## Status: milestone M3 of M6

Done: the operating-microscope view of the field (folded lobes, the sylvian fissure that opens and closes, ICA, M1 and
M2, A1, PCom, anterior choroidal artery, optic and oculomotor nerves, the 6.6 mm aneurysm with its bleb, the two
retractor blades, arachnoid membrane in cuttable segments), pulsing arteries, labels, zoom, pan and a limited orbit.

Also done (M2): the ten tools, each with its own rule and cursor: suction, scissors, bipolar, dissector, spatula, clip
(straight or curved, turned and set to a blade depth), ICG, Doppler, endoscope and temporary clip. Cutting the membrane
outer-first lets the spatula open the fissure; the dissector then frees the aneurysm neck; the clip goes on a freed neck.
A readout shows the membrane, fissure, neck, dome strain, bleeding points, temporary-clip clock, clip and injuries.

Also done (M3): the six steps (open the sylvian fissure; identify M1; identify the carotid and optic nerve; confirm the
PCom and expose the neck; clip; confirm the PCom still flows), each with sub-tasks that tick off, locked until the one
before is finished. A mentor panel gives a calm next-step hint and why the step matters, and comments when a step is
done, when something goes wrong, and when the temporary clip or the retraction has gone on too long. To identify a
structure, point at it and press `I` (or click Identify, then the structure). The checks in step 6 only count after the
clip is on.

Next: vitals and bleeding (M4), clip evaluation, ICG and Doppler detail and the endoscope (M5), debrief, demo, English
and Japanese (M6). The plan is in [PLAN.md](PLAN.md).

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

Keys: `1` to `9` and `0` pick the tools (suction, scissors, bipolar, dissector, spatula, clip, ICG, Doppler, endoscope,
temporary clip). With the clip: `A` and `D` turn it, `W` and `S` set blade depth, `V` swaps straight and curved, and
Backspace removes it. `L` labels, `R` resets the view. Left-click uses the tool; right-drag looks around, scroll zooms,
and the arrow keys or middle-drag move.

## Changing the anatomy

Every size and position is in `src/config/anatomy.ts`. For example, `aneurysm.domeDiameterMm: 6.6` makes the dome
10 mm wide if you change it to `10`.
