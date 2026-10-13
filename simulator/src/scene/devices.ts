/**
 * Draws the devices over the anatomy: the guide catheter, the wire, the balloon and stent catheters,
 * deployed stents, dissection flaps and the contrast fill, all from a `Simulation`. Headless-safe (no
 * renderer needed), so it can be built and updated in node; how it looks is checked in a browser.
 */
import * as THREE from 'three';
import { INFLATION, LESION, STENT } from '../config/anatomy';
import { anatomyPaths, vesselPosition } from '../anatomy/centrelines';
import { Path } from '../anatomy/spline';
import { TubeTemplate } from '../anatomy/tubeGeometry';
import { normalize, rotateAbout, sub, dot, scale, type Vec3 } from '../anatomy/vec3';
import { treatmentsOf, type Simulation } from '../engine/simulation';
import { inflatedDiameter, type Catheter } from '../tools/devices';
import type { AnatomyScene } from './anatomyScene';
import {
  WIRE_ROUTES,
  buildChainPath,
  chainDistance,
  indexCountFor,
  overlayFor,
  overlayKey,
  ringsToShow,
  routeFor,
} from './deviceMath';

const GUIDE_RADIUS = 1.0; // a 6F catheter is 2 mm across
const WIRE_RADIUS = 0.18; // 0.014 inch is 0.356 mm across
const SHAFT_RADIUS = 0.4;
const STEP = 1;

/** A tube that can be shown only part way along, by limiting how much of its index buffer is drawn. */
class GrowingTube {
  readonly mesh: THREE.Mesh;
  readonly path: Path;
  private readonly template: TubeTemplate;

  constructor(path: Path, radius: number, material: THREE.Material, radial: number, name: string, step = STEP) {
    this.path = path;
    this.template = new TubeTemplate(path, { step, radialSegments: radial });
    const positions = new Float32Array(this.template.vertexCount * 3);
    const normals = new Float32Array(this.template.vertexCount * 3);
    this.template.fill(() => radius, positions, normals);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(this.template.indices(), 1));
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.show(0);
  }

  /** Show the first `mm` of the path. */
  show(mm: number): void {
    const rings = ringsToShow(mm, this.template.ringDistances()[1] ?? STEP, this.path.length);
    this.mesh.visible = rings >= 2;
    this.mesh.geometry.setDrawRange(0, indexCountFor(rings, this.template.radialSegments));
  }
}

/** A tube over a stretch of a path that is rebuilt only when its shape changes (a balloon swelling, a stent moving). */
class SegmentTube {
  readonly mesh: THREE.Mesh;
  private key = '';

  constructor(material: THREE.Material, name: string) {
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  set(path: Path | null, radius: number): void {
    if (!path || path.length < 0.5) {
      this.mesh.visible = false;
      this.key = '';
      return;
    }
    const start = path.positionAt(0);
    const key = `${path.length.toFixed(2)}|${start[0].toFixed(2)},${start[1].toFixed(2)},${start[2].toFixed(2)}|${radius.toFixed(3)}`;
    this.mesh.visible = true;
    if (key === this.key) return;
    this.key = key;
    const template = new TubeTemplate(path, { step: 1, radialSegments: 16 });
    const positions = new Float32Array(template.vertexCount * 3);
    const normals = new Float32Array(template.vertexCount * 3);
    template.fill(() => radius, positions, normals);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(template.indices(), 1));
    this.mesh.geometry.dispose();
    this.mesh.geometry = geometry;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}

export interface DeviceView {
  update(sim: Simulation): void;
  dispose(): void;
}

const v3 = (p: Vec3): THREE.Vector3 => new THREE.Vector3(p[0], p[1], p[2]);

export function createDeviceView(anatomy: AnatomyScene): DeviceView {
  const { route } = anatomyPaths();
  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(thing: T): T => {
    disposables.push(thing);
    return thing;
  };

  const steel = own(new THREE.MeshStandardMaterial({ color: 0xe6edf5, metalness: 0.3, roughness: 0.35, emissive: 0x2a3a4a }));
  const wireMaterial = own(new THREE.MeshStandardMaterial({ color: 0xf2f6fa, metalness: 0.4, roughness: 0.25, emissive: 0x335577 }));
  const tipMaterial = own(new THREE.MeshStandardMaterial({ color: 0xffd54a, emissive: 0x886600, roughness: 0.4 }));
  const shaftMaterial = own(new THREE.MeshStandardMaterial({ color: 0x9fb2c4, metalness: 0.3, roughness: 0.5 }));
  const balloonMaterial = own(new THREE.MeshStandardMaterial({ color: 0x7fc4ff, transparent: true, opacity: 0.6, roughness: 0.3, depthWrite: false }));
  const latticeMaterial = own(new THREE.MeshBasicMaterial({ color: 0xe4eaf0, wireframe: true }));

  // --- the guide: the route to the root, then a few mm into the left main ----------------------
  const lmStart = vesselPosition('LM', 0);
  const guidePath = new Path([...route.points, lmStart, vesselPosition('LM', 5)]);
  const engagedExtra = guidePath.length - route.length;
  const guide = own(wrap(new GrowingTube(guidePath, GUIDE_RADIUS, steel, 12, 'guide-catheter', 1.5)));
  anatomy.root.add(guide.mesh);

  const guideTip = new THREE.Mesh(new THREE.SphereGeometry(1.5, 12, 8), tipMaterial);
  guideTip.name = 'guide-tip';
  guideTip.visible = false;
  anatomy.root.add(guideTip);
  disposables.push({ dispose: () => guideTip.geometry.dispose() });
  const tipArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 9, 0xffd54a, 3.2, 2.4);
  tipArrow.name = 'guide-tip-direction';
  tipArrow.visible = false;
  anatomy.root.add(tipArrow);

  // --- the wire: one route per possible end vessel, shown up to the tip -----------------------------
  const wires = new Map<string, GrowingTube>();
  for (const id of WIRE_ROUTES) {
    const tube = own(wrap(new GrowingTube(buildChainPath(id), WIRE_RADIUS, wireMaterial, 6, `wire-${id}`)));
    wires.set(id, tube);
    anatomy.beating.add(tube.mesh);
  }
  const wireTip = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), tipMaterial);
  wireTip.name = 'wire-tip';
  wireTip.visible = false;
  anatomy.beating.add(wireTip);
  disposables.push({ dispose: () => wireTip.geometry.dispose() });

  // --- the catheters over the wire, in the LAD ----------------------------------------------------------------
  const ladChain = buildChainPath('LAD');
  const ladPath = anatomyPaths().vessels[LESION.vessel];
  const makeCatheter = (kind: 'balloon' | 'stent') => {
    const shaft = own(wrap(new GrowingTube(ladChain, SHAFT_RADIUS, shaftMaterial, 8, `${kind}-shaft`)));
    const body = own(wrap(new SegmentTube(balloonMaterial, `${kind}-body`)));
    const lattice = own(wrap(new SegmentTube(latticeMaterial, `${kind}-stent-lattice`)));
    anatomy.beating.add(shaft.mesh, body.mesh, lattice.mesh);
    return { shaft, body, lattice };
  };
  const balloonParts = makeCatheter('balloon');
  const stentParts = makeCatheter('stent');
  const deployed: SegmentTube[] = [];
  const deployedAt = (n: number): SegmentTube => {
    while (deployed.length <= n) {
      const tube = own(wrap(new SegmentTube(latticeMaterial, `deployed-stent-${deployed.length}`)));
      anatomy.beating.add(tube.mesh);
      deployed.push(tube);
    }
    return deployed[n]!;
  };

  const showCatheter = (parts: ReturnType<typeof makeCatheter>, c: Catheter, kind: 'balloon' | 'stent'): void => {
    const out = !c.inGuide && !c.ruptured && c.centreS !== null;
    if (!out) {
      parts.shaft.mesh.visible = false;
      parts.body.set(null, 0);
      parts.lattice.set(null, 0);
      return;
    }
    const centre = c.centreS as number;
    const half = c.spec.length / 2;
    const radius = Math.max(0.45, inflatedDiameter(c.spec, c.pressure) / 2);
    parts.shaft.show(chainDistance(LESION.vessel, centre - half));
    parts.shaft.mesh.visible = true;
    const segment = ladPath.slice(centre - half, centre + half);
    if (kind === 'balloon' || !c.deployed) parts.body.set(segment, radius);
    else parts.body.set(null, 0);
    if (kind === 'stent' && !c.deployed) parts.lattice.set(segment, radius + 0.04);
    else parts.lattice.set(null, 0);
  };

  let appliedTreatments = '';
  let appliedOverlay = '';
  let appliedDye = -1;

  return {
    update(sim: Simulation): void {
      // Guide.
      const route0 = Math.min(sim.guide.s, route.length);
      const shown = route0 + (sim.guide.engaged ? engagedExtra : 0);
      guide.show(shown);
      const tipAt = guidePath.positionAt(shown);
      guideTip.visible = sim.guide.s > 0.5;
      guideTip.position.copy(v3(tipAt));
      const tangent = guidePath.tangentAt(shown);
      const reference: Vec3 = [1, 0, 0];
      const perpendicular = normalize(sub(reference, scale(tangent, dot(reference, tangent))));
      const direction = rotateAbout(perpendicular, tangent, (sim.guide.rotationDeg * Math.PI) / 180);
      tipArrow.visible = guideTip.visible && sim.tool === 'guide';
      tipArrow.position.copy(v3(tipAt));
      tipArrow.setDirection(v3(direction));

      // Wire.
      const w = sim.wire;
      for (const tube of wires.values()) tube.mesh.visible = false;
      if (w.outOfGuide && w.vessel !== null) {
        const tube = wires.get(routeFor(w.vessel))!;
        tube.show(chainDistance(w.vessel, w.s));
        wireTip.visible = true;
        wireTip.position.copy(v3(vesselPosition(w.vessel, w.s)));
      } else {
        wireTip.visible = false;
      }

      // Catheters and stents.
      showCatheter(balloonParts, sim.balloon, 'balloon');
      showCatheter(stentParts, sim.stent, 'stent');
      const stents = treatmentsOf(sim).filter((t) => t.kind === 'stent');
      const inflatedNow = sim.stent.pressure >= INFLATION.inflatedAtm || sim.balloon.pressure >= INFLATION.inflatedAtm;
      stents.forEach((t, i) => {
        const diameter = t.diameter * (inflatedNow ? 1 : 1 - STENT.recoil);
        const path = anatomyPaths().vessels[t.vessel].slice(t.centreS - t.length / 2, t.centreS + t.length / 2);
        deployedAt(i).set(path, diameter / 2 + 0.03);
      });
      for (let i = stents.length; i < deployed.length; i++) deployed[i]!.set(null, 0);

      // The lumen, the wall tint and the dye.
      const treatments = treatmentsOf(sim);
      const treatmentKey = treatments.map((t) => `${t.kind}${t.vessel}${t.centreS.toFixed(2)}${t.length}${t.diameter.toFixed(3)}`).join(';');
      if (treatmentKey !== appliedTreatments) {
        appliedTreatments = treatmentKey;
        anatomy.setTreatments(treatments);
      }
      const overlay = overlayKey(sim);
      if (overlay !== appliedOverlay) {
        appliedOverlay = overlay;
        anatomy.setOverlay(overlayFor(sim));
      }
      const injection = sim.injection;
      const dye = injection && !injection.selective ? 1 - Math.min(1, Math.max(0, (sim.time - injection.start) / injection.duration)) : 0;
      if (Math.abs(dye - appliedDye) > 0.02) {
        appliedDye = dye;
        anatomy.setAortaDye(dye);
      }
    },

    dispose(): void {
      for (const thing of disposables) thing.dispose();
      anatomy.root.remove(guideTip, tipArrow);
    },
  };
}

/** Give a tube wrapper a dispose() that frees its geometry, so it can be tracked with the others. */
function wrap<T extends { mesh: THREE.Mesh }>(tube: T): T & { dispose(): void } {
  return Object.assign(tube, {
    dispose(): void {
      tube.mesh.geometry.dispose();
    },
  });
}
