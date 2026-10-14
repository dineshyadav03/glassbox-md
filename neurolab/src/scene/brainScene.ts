/**
 * Builds the operative field as a Three.js scene graph: the two lobes with the sylvian fissure between them,
 * the arteries, nerves and aneurysm, the arachnoid membrane in cuttable segments, the spatulas, and a dark
 * backdrop. It needs no renderer or DOM, so it can be built and checked in node; drawing it is `microscope.ts`'s job.
 *
 * World frame: see `config/anatomy.ts` (1 unit = 1 mm, the surgeon looks along -z).
 */
import * as THREE from 'three';
import { ANATOMY, COLOURS } from '../config/anatomy';
import { aneurysmGeometry } from '../anatomy/aneurysm';
import { labelAnchors, type LabelAnchor } from '../anatomy/labels';
import { buildLobe, lobeSurfaceY } from '../anatomy/lobe';
import { TubeTemplate, type Colour } from '../anatomy/tubeGeometry';
import { buildNerves, buildVessels, type NerveId, type Tube, type VesselId } from '../anatomy/vessels';

type Config = typeof ANATOMY;

/** Pulse shape for the arteries, 0 to 1 over one beat: a quick systolic rise and a slower fall. */
export function pulseWave(phase: number): number {
  const p = ((phase % 1) + 1) % 1;
  return p < 0.2 ? Math.sin((p / 0.2) * (Math.PI / 2)) : Math.exp(-(p - 0.2) * 5);
}

/** How much the arteries swell with the pulse (a fraction of their radius). Purely visual. */
export const PULSE_SWELL = 0.04;

export interface BrainScene {
  readonly root: THREE.Group;
  readonly lobes: { readonly frontal: THREE.Mesh; readonly temporal: THREE.Mesh };
  readonly vessels: Readonly<Record<VesselId, THREE.Mesh>>;
  readonly nerves: Readonly<Record<NerveId, THREE.Mesh>>;
  readonly aneurysm: { readonly sac: THREE.Mesh; readonly bleb: THREE.Mesh };
  /** The two retractor blades (frontal, temporal); they ride with the lobes they hold. */
  readonly spatulas: readonly THREE.Mesh[];
  readonly arachnoid: ReadonlyMap<string, THREE.Mesh>;
  readonly labels: readonly LabelAnchor[];
  /** Box around the vessels, nerves and aneurysm, mm, for framing the camera. */
  readonly fieldBounds: THREE.Box3;
  /** 0 = the fissure closed (lobes together), 1 = opened and held apart by the spatulas. */
  readonly fissureOpening: number;
  setFissureOpening(opening: number): void;
  setArachnoidCut(id: string, cut: boolean): void;
  isArachnoidCut(id: string): boolean;
  /** Swell the arteries for this point in the heart cycle, 0 to 1. */
  setPulse(phase: number): void;
  dispose(): void;
}

interface Live {
  readonly mesh: THREE.Mesh;
  readonly refill: (scale: number) => void;
}

function tubeMesh(tube: Tube, colour: Colour, material: THREE.Material, radialSegments = 16): Live {
  const template = new TubeTemplate(tube.path, { radialSegments, step: 0.8 });
  const positions = new Float32Array(template.vertexCount * 3);
  const normals = new Float32Array(template.vertexCount * 3);
  const colors = new Float32Array(template.vertexCount * 3);
  template.fillColours(() => colour, colors);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(template.indices(), 1));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = tube.id;
  const refill = (scale: number): void => {
    template.fill((s) => tube.radiusAt(s) * scale, positions, normals);
    geometry.attributes.position!.needsUpdate = true;
    geometry.attributes.normal!.needsUpdate = true;
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
  };
  refill(1);
  return { mesh, refill };
}

function lobeMesh(lobe: Config['lobes']['frontal'], material: THREE.Material, name: string, config: Config): THREE.Mesh {
  const data = buildLobe(lobe, config.lobes.gyriAmplitudeMm, config.lobes.gyriWavelengthMm);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  return mesh;
}

/** One membrane segment: a soft oval, one unit across, scaled to its size (and stretched with the fissure). */
function arachnoidSheet(material: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.CircleGeometry(0.5, 48), material);
}

export function buildBrainScene(config: Config = ANATOMY, opening = 1): BrainScene {
  const root = new THREE.Group();
  root.name = 'operative-field';

  const brainMaterial = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.48, clearcoat: 0.75, clearcoatRoughness: 0.22 });
  const arteryMaterial = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.55, clearcoat: 0.25, clearcoatRoughness: 0.4, emissive: 0x3a0a0a });
  const aneurysmMaterial = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.35, emissive: 0x440c0c });
  const nerveMaterial = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.55, clearcoat: 0.3 });
  const membraneMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xf3e7e2,
    roughness: 0.3,
    transparent: true,
    opacity: 0.1,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const steel = new THREE.MeshStandardMaterial({ color: 0x8e98a6, metalness: 0.6, roughness: 0.4 });
  const backdropMaterial = new THREE.MeshBasicMaterial({ color: COLOURS.backdrop });

  // --- lobes, each in a group that moves them apart as the fissure is opened --------------------------
  const frontalGroup = new THREE.Group();
  const temporalGroup = new THREE.Group();
  const frontal = lobeMesh(config.lobes.frontal, brainMaterial, 'frontal-lobe', config);
  const temporal = lobeMesh(config.lobes.temporal, brainMaterial, 'temporal-lobe', config);
  frontalGroup.add(frontal);
  temporalGroup.add(temporal);

  // Spatulas ride with the lobes they hold: one under the frontal lobe, one on top of the temporal lobe.
  const sp = config.spatulas;
  const spatulaX = 14;
  const spatulaZ = -8;
  const under = lobeSurfaceY(config.lobes.frontal, spatulaX, spatulaZ, 'bottom') ?? 0;
  const over = lobeSurfaceY(config.lobes.temporal, spatulaX, spatulaZ, 'top') ?? 0;
  const gap = config.lobes.gyriAmplitudeMm + sp.thicknessMm;
  const frontalSpatula = new THREE.Mesh(new THREE.BoxGeometry(sp.widthMm, sp.thicknessMm, sp.lengthMm), steel);
  frontalSpatula.position.set(spatulaX, under - gap / 2 - 0.3, spatulaZ);
  frontalSpatula.name = 'spatula-frontal';
  const temporalSpatula = new THREE.Mesh(new THREE.BoxGeometry(sp.widthMm, sp.thicknessMm, sp.lengthMm), steel);
  temporalSpatula.position.set(spatulaX, over + gap / 2 + 0.3, spatulaZ);
  temporalSpatula.name = 'spatula-temporal';
  frontalGroup.add(frontalSpatula);
  temporalGroup.add(temporalSpatula);
  const spatulas = [frontalSpatula, temporalSpatula];

  // --- vessels, nerves, aneurysm -------------------------------------------------------------------------
  const vesselTubes = buildVessels(config);
  const nerveTubes = buildNerves(config);
  const live: Live[] = [];
  const vessels = {} as Record<VesselId, THREE.Mesh>;
  for (const id of Object.keys(vesselTubes) as VesselId[]) {
    const made = tubeMesh(vesselTubes[id], COLOURS.artery, arteryMaterial);
    vessels[id] = made.mesh;
    live.push(made);
  }
  const nerves = {} as Record<NerveId, THREE.Mesh>;
  for (const id of Object.keys(nerveTubes) as NerveId[]) {
    const made = tubeMesh(nerveTubes[id], COLOURS.nerve, nerveMaterial, 14);
    nerves[id] = made.mesh;
  }

  const an = aneurysmGeometry(config);
  const sacLive = tubeMesh({ id: 'aneurysm-sac', path: an.path, radiusAt: an.radiusAt }, COLOURS.aneurysm, aneurysmMaterial, 28);
  const blebGeometry = new THREE.SphereGeometry(an.bleb.radius, 18, 14);
  const blebColours = new Float32Array(blebGeometry.attributes.position!.count * 3);
  for (let i = 0; i < blebColours.length; i += 3) blebColours.set(COLOURS.aneurysm, i);
  blebGeometry.setAttribute('color', new THREE.BufferAttribute(blebColours, 3));
  const bleb = new THREE.Mesh(blebGeometry, aneurysmMaterial);
  bleb.position.set(...an.bleb.centre);
  bleb.name = 'aneurysm-bleb';
  live.push(sacLive);

  // --- arachnoid -----------------------------------------------------------------------------------------
  const arachnoid = new Map<string, THREE.Mesh>();
  const cut = new Set<string>();
  for (const segment of config.arachnoid.segments) {
    const sheet = arachnoidSheet(membraneMaterial);
    sheet.position.set(...segment.position);
    sheet.scale.set(segment.size[0], segment.size[1], 1);
    sheet.name = segment.id;
    arachnoid.set(segment.id, sheet);
  }

  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(520, 420), backdropMaterial);
  backdrop.position.set(0, 0, -102);
  backdrop.name = 'backdrop';

  root.add(frontalGroup, temporalGroup, backdrop, ...Object.values(vessels), ...Object.values(nerves), sacLive.mesh, bleb, ...arachnoid.values());

  const fieldBounds = new THREE.Box3();
  for (const mesh of [...Object.values(vessels), ...Object.values(nerves), sacLive.mesh, bleb]) fieldBounds.union(new THREE.Box3().setFromObject(mesh));

  let currentOpening = 0;
  const scene: BrainScene = {
    root,
    lobes: { frontal, temporal },
    vessels,
    nerves,
    aneurysm: { sac: sacLive.mesh, bleb },
    spatulas,
    arachnoid,
    labels: labelAnchors(config),
    fieldBounds,
    get fissureOpening(): number {
      return currentOpening;
    },
    setFissureOpening(next: number): void {
      currentOpening = Math.min(1, Math.max(0, next));
      frontalGroup.position.y = config.lobes.frontal.retractionMm * currentOpening;
      temporalGroup.position.y = -config.lobes.temporal.retractionMm * currentOpening;
      for (const blade of spatulas) blade.visible = currentOpening > 0.02;
      // The membrane stretches with the gap it spans.
      const stretch = config.lobes.frontal.retractionMm + config.lobes.temporal.retractionMm;
      for (const segment of config.arachnoid.segments) {
        arachnoid.get(segment.id)!.scale.y = segment.size[1] + stretch * currentOpening;
      }
    },
    setArachnoidCut(id: string, isCut: boolean): void {
      const sheet = arachnoid.get(id);
      if (!sheet) throw new Error(`unknown arachnoid segment: ${id}`);
      sheet.visible = !isCut;
      if (isCut) cut.add(id);
      else cut.delete(id);
    },
    isArachnoidCut: (id) => cut.has(id),
    setPulse(phase: number): void {
      const swell = 1 + PULSE_SWELL * pulseWave(phase);
      for (const item of live) item.refill(swell);
    },
    dispose(): void {
      root.traverse((object) => {
        if (object instanceof THREE.Mesh) object.geometry.dispose();
      });
      for (const material of [brainMaterial, arteryMaterial, aneurysmMaterial, nerveMaterial, membraneMaterial, steel, backdropMaterial]) material.dispose();
    },
  };
  scene.setFissureOpening(opening);
  return scene;
}
