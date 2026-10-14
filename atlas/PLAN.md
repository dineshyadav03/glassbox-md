# Plan: Human Atlas (3D anatomy explorer), for approval

**Status: plan only. No code has been written and nothing has been downloaded. Nothing here happens until you approve it.**

Source: the "Build Your Own Human Atlas" build guide you pasted. The in-app credits must carry the BodyParts3D attribution (a license requirement).
Where it will live: `atlas/` in this repository, served by the Glassbox MD app at `/atlas/`, like the cath lab at
`/cathlab/`. Not connected to the diagnostic pipeline.

## 1. What it is

A full-screen 3D human anatomy explorer: orbit/pan/zoom with damped camera; eight toggleable systems (skeleton,
muscles, heart, sensory organs, arteries, veins, nervous system, respiratory); an explode slider that moves every piece
from its anatomical position to a catalogued "specimen atlas" layout, every piece still selectable; hover labels; an
info panel; isolate mode; search that flies the camera to a structure; regional collections; credits.

It needs an educational disclaimer too, which the guide omits: *educational and illustrative only, not medical advice,
not a diagnostic or surgical reference.* I would add it to the credits panel, the README, and the first screen.

## 2. Facts I checked (not taken from the guide)

I read the dataset's official pages (no files downloaded):

- **Source:** BodyParts3D, Database Center for Life Science (DBCLS), Japan; a whole-body model of an adult male.
  Last updated **2013/05**. The page does not say how many parts it has.
- **License:** CC BY 4.0. Required attribution, exactly: *"BodyParts3D, (c) The Database Center for Life Science licensed
  under CC Attribution 4.0 International"*. Redistribution and derived works are permitted with that credit, so committing
  our compressed GLBs is allowed. The page does not address commercial use specifically.
- **Files** (all in DBCLS's `LATEST` directory):

| File | What | Size |
|---|---|---|
| `isa_parts_list_e.txt` | IDs and names, IS-A tree | 126 KB |
| `partof_parts_list_e.txt` | IDs and names, PART-OF tree | 58 KB |
| `isa_inclusion_relation_list.txt` | how organs include one another, IS-A | 203 KB |
| `partof_inclusion_relation_list.txt` | same, PART-OF | 90 KB |
| `isa_element_parts.txt` | compound organs defined from elements, IS-A | 1.1 MB |
| `partof_element_parts.txt` | same, PART-OF | 654 KB |
| `isa_BP3D_4.0_obj_99.zip` | OBJ meshes, 99% polygon reduction, IS-A | **136 MB** |
| `partof_BP3D_4.0_obj_99.zip` | OBJ meshes, 99% polygon reduction, PART-OF | **62 MB** |

- **The guide says "download the 99% OBJ archive" as if there were one.** There are two (IS-A and PART-OF). Which one is
  right depends on how compound organs are meshed, which I cannot tell from the pages. So the first step is to read the
  small tables (about 2.3 MB total), decide, and only then ask you about a mesh zip.
- **Not documented on the pages I read:** the part count, the coordinate system and units, whether all meshes share one
  frame, and **whether muscle-to-bone attachments exist at all.** See the next section.

## 3. A requirement in the guide that the data may not support

The guide's info panel lists, for muscles, "clickable attachment bones and supporting vessels", and insists "never invent
anatomical relationships." The dataset's own descriptions mention IS-A and PART-OF hierarchies and inclusion relations, not
attachments. If that holds after I inspect the tables, then:

- **Verified** relationships I can show: the part-of and is-a hierarchy (parent, children, what includes what), taken straight
  from the tables.
- **"Nearby"** I can compute (bounding-box proximity), labelled "nearby", never as an attachment.
- **Attachments and supporting vessels** I will **not** show unless a verified, licensable source is found. Tell me if you
  want me to look for one; otherwise the panel simply omits that section.

## 4. Stack (versions checked on npm today)

React 19.3, `@react-three/fiber` 9.8 (needs React 19, Three.js >= 0.156), `@react-three/drei` 10.7, Three.js 0.186.1 (the
version the cath lab already uses), Framer Motion / `motion` 14.2, `@gltf-transform/core` + `cli` 4.5, `meshoptimizer`
1.3, `tsx` to run the TypeScript build script, Vitest for tests. All compatible. This is a **separate package**: React is not
used by the cath lab, so the two share nothing and need no extraction.

## 5. The data pipeline (the hard part, and the interesting one)

`scripts/build-anatomy.ts`, run once locally, raw OBJs never committed (`assets/anatomy/raw` is gitignored):

1. Read the name tables; map each element ID to its English name.
2. Classify each piece into one of the eight systems from its position in the IS-A tree and its name, with the rules written
   as plain data and tested. Anything it cannot place goes to `unclassified.log`, not a guess.
3. Detect side (left, right, midline) from the name.
4. Convert OBJ to GLB, compress with meshopt, write `manifest.json`: `{ id, name, system, region, side, meshFile,
   assembledPosition, explodedPosition }`.
5. Compute `explodedPosition` for every piece with a deterministic **atlas layout**: shelf-packed rows, largest structures
   at the top and smaller denser toward the bottom, no overlaps (tested).
6. Print a report: pieces per system, unclassified count, the 20 most doubtful classifications, total GLB size.

**Repository size:** I will not commit anything until I know the GLB total. If it is under about 50 MB I would commit it;
otherwise it goes in a release asset or Git LFS (your choice, D3). GitHub blocks files over 100 MB.

## 6. How it renders, and the one real design choice

Over a thousand separate meshes means over a thousand draw calls, which is borderline for 60 fps on a laptop, and the guide's
rule is "never update React state every frame."

- **Plan A (start here):** one mesh per piece, positions eased inside `useFrame` from a single explode value, raycast for
  hover. Simple and correct. I **measure** draw calls and frame rate on the real model before deciding anything.
- **Plan B (only if A is too slow):** merge each system into one geometry, carry assembled and exploded positions as vertex
  attributes, interpolate in the vertex shader (one number drives the whole body), and pick with a BVH or an ID render.
  Fewer draw calls and no per-piece CPU work, at the price of more code.

## 7. Milestones

Each is runnable, tested, and committed on its own; I report after each.

| | Deliverable | Checked by |
|---|---|---|
| **A0** | Read the small tables only (needs your OK to download ~2.3 MB); report what is in them, the part count, and whether attachment data exists | a written findings note |
| **A1** | Pipeline on the tables; classification and side rules; unclassified log; tests | unit tests on rules; the report |
| **A2** | Ask you before downloading the mesh zip (file, source, size); convert to GLB and manifest; atlas layout | layout no-overlap test; size report |
| **A3** | App shell, canvas, camera, lighting; systems panel and fades | loads; 8 toggles |
| **A4** | Hover, selection, info panel, focus, isolate | raycast/focus unit tests; live check |
| **A5** | Explode slider and animation; search; collections; camera toolbar | easing/focus/search tests; frame rate measured |
| **A6** | Credits, microinteractions, performance pass (Plan B if measured), mobile layout, README, CI, serve at `/atlas/` | build; Python real-build test; console clean |

## 8. Risks

- **Unknown data layout** (above). A0 exists to find out cheaply.
- **Names.** Raw anatomical names have odd capitalisation and long forms; search needs normalising and tests.
- **Mobile.** A model this size may not hold 60 fps on a phone; I would report what I measure instead of promising it.
- **The dataset is 2013 and an adult male only.** The credits and README should say so, so nobody reads it as a general reference.
- **Verification.** As with the cath lab: logic by tests, visuals by eye, and I will say which is which.

## 9. Decisions I need from you

- **D1.** OK to download the small name/relationship tables (about 2.3 MB, from dbarchive.biosciencedbc.jp) for step A0?
  I will ask again, with exact file name and size, before any mesh archive (62 MB or 136 MB).
- **D2.** Attachments: show only what the data verifies (my recommendation), or should I hunt for a licensable source?
- **D3.** If the GLBs are too big for git: release asset, Git LFS, or build on demand?
- **D4.** Order relative to the brain-surgery simulator.

Approve with changes, or tell me what to cut.
