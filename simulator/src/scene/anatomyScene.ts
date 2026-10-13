/**
 * Builds the anatomy as a Three.js scene graph: a beating heart with the coronary arteries on it, the
 * aorta, and the arteries of the access route. It needs no renderer or DOM, so it can be built and
 * checked in node; drawing it is `viewer.ts`'s job.
 *
 * World frame: x = patient's left, y = superior, z = anterior; 1 unit = 1 mm.
 */
import * as THREE from 'three';
import { AORTA_ENTRY_S, VESSEL_ORDER, LESION, type VesselId } from '../config/anatomy';
import { aortaRadiusAt, anatomyPaths, routeDiameterAt } from '../anatomy/centrelines';
import { beatFactor, fatWeight, heartSurfacePoint } from '../anatomy/heartShape';
import { labelAnchors, type LabelAnchor } from '../anatomy/labels';
import { Path } from '../anatomy/spline';
import { TubeTemplate, type Colour } from '../anatomy/tubeGeometry';
import type { Vec3 } from '../anatomy/vec3';
import { lesionWeight, lumenDiameterAt, type Treatment } from '../physics/lesion';

const MUSCLE: Colour = [0.55, 0.1, 0.12];
const FAT: Colour = [0.9, 0.74, 0.42];
const ARTERY: Colour = [0.82, 0.14, 0.12];
const PLAQUE: Colour = [0.96, 0.86, 0.5];

const mix = (a: Colour, b: Colour, t: number): Colour => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** A coronary vessel's colour along its length before any overlay: arterial red, pale where the plaque is. */
function baseColour(id: VesselId): (s: number) => Colour {
  return (s) => (id === LESION.vessel ? mix(ARTERY, PLAQUE, 0.9 * lesionWeight(s)) : ARTERY);
}

export interface AnatomyScene {
  readonly root: THREE.Group;
  /** The heart and the coronary arteries; scaled together by the beat. */
  readonly beating: THREE.Group;
  readonly heartMesh: THREE.Mesh;
  readonly coronaries: Readonly<Record<VesselId, THREE.Mesh>>;
  readonly labels: readonly LabelAnchor[];
  /** Bounding boxes, mm, for framing the camera. */
  readonly heartBounds: THREE.Box3;
  readonly routeBounds: THREE.Box3;
  /** Set the point in the cardiac cycle, 0 to 1. */
  setBeatPhase(phase: number): void;
  /** Redraw the coronary arteries for the given treatments (stents and balloons change the lumen). */
  setTreatments(treatments: readonly Treatment[]): void;
  /** Tint the coronary walls (dissection flaps, dye) over their base colour; null clears it. */
  setOverlay(overlay: ((id: VesselId, s: number, base: Colour) => Colour) | null): void;
  /** Fill the aorta with dye, 0 (none) to 1 (full). */
  setAortaDye(amount: number): void;
  dispose(): void;
}

function makeHeartMesh(): THREE.Mesh {
  const rings = 56;
  const around = 80;
  const positions: number[] = [];
  const colours: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const polar = (Math.PI * i) / rings;
    for (let j = 0; j <= around; j++) {
      const azimuth = (2 * Math.PI * j) / around;
      const direction: Vec3 = [Math.sin(polar) * Math.cos(azimuth), Math.cos(polar), Math.sin(polar) * Math.sin(azimuth)];
      const p = heartSurfacePoint(direction);
      positions.push(p[0], p[1], p[2]);
      const c = mix(MUSCLE, FAT, 0.6 * fatWeight(p));
      colours.push(c[0], c[1], c[2]);
    }
  }
  const indices: number[] = [];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < around; j++) {
      const a = i * (around + 1) + j;
      const b = a + 1;
      const c = a + around + 1;
      const d = c + 1;
      // Wound so the outside faces out.
      indices.push(a, b, c, b, d, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0 }));
  mesh.name = 'heart';
  return mesh;
}

/** A tube mesh whose radius can be re-applied later. */
class TubeMesh {
  readonly mesh: THREE.Mesh;
  private readonly template: TubeTemplate;
  private readonly positions: Float32Array;
  private readonly normals: Float32Array;
  private readonly colours: Float32Array;

  constructor(
    path: Path,
    radiusAt: (s: number) => number,
    colourAt: (s: number) => Colour,
    material: THREE.Material,
    step: number,
    radialSegments: number,
    name: string,
  ) {
    this.template = new TubeTemplate(path, { step, radialSegments });
    this.positions = new Float32Array(this.template.vertexCount * 3);
    this.normals = new Float32Array(this.template.vertexCount * 3);
    this.colours = new Float32Array(this.template.vertexCount * 3);
    this.template.fill(radiusAt, this.positions, this.normals);
    this.template.fillColours(colourAt, this.colours);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colours, 3));
    geometry.setIndex(new THREE.BufferAttribute(this.template.indices(), 1));
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = name;
  }

  setColours(colourAt: (s: number) => Colour): void {
    this.template.fillColours(colourAt, this.colours);
    this.mesh.geometry.attributes.color!.needsUpdate = true;
  }

  setRadius(radiusAt: (s: number) => number): void {
    this.template.fill(radiusAt, this.positions, this.normals);
    const geometry = this.mesh.geometry;
    geometry.attributes.position!.needsUpdate = true;
    geometry.attributes.normal!.needsUpdate = true;
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
  }
}

export function buildAnatomyScene(): AnatomyScene {
  const { vessels, route, aorta } = anatomyPaths();
  const root = new THREE.Group();
  root.name = 'anatomy';

  // Lights: a soft sky/ground fill and one key light from the front-left-above, like a studio setup.
  root.add(new THREE.HemisphereLight(0xdfe9ff, 0x7a5a58, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.9);
  key.position.set(120, 180, 220);
  root.add(key);
  const rim = new THREE.DirectionalLight(0x9fc4ff, 0.7);
  rim.position.set(-160, 60, -200);
  root.add(rim);
  const fill = new THREE.DirectionalLight(0xffd9c8, 0.55);
  fill.position.set(80, -220, 120);
  root.add(fill);

  const beating = new THREE.Group();
  beating.name = 'beating';
  root.add(beating);

  const heartMesh = makeHeartMesh();
  beating.add(heartMesh);

  const arteryMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0, side: THREE.DoubleSide });
  const coronaryTubes = {} as Record<VesselId, TubeMesh>;
  const coronaries = {} as Record<VesselId, THREE.Mesh>;
  for (const id of VESSEL_ORDER) {
    const colourAt = baseColour(id);
    const tube = new TubeMesh(vessels[id], (s) => lumenDiameterAt(id, s) / 2, colourAt, arteryMaterial, 0.75, 14, `coronary-${id}`);
    coronaryTubes[id] = tube;
    coronaries[id] = tube.mesh;
    beating.add(tube.mesh);
  }

  // The aorta: translucent, so the access route and the coronary ostia can be seen through it.
  const aortaMaterial = new THREE.MeshStandardMaterial({
    color: 0xd9676a,
    roughness: 0.5,
    transparent: true,
    opacity: 0.38,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const aortaTube = new TubeMesh(aorta, (s) => aortaRadiusAt(s, aorta.length), () => [1, 1, 1], aortaMaterial, 3, 28, 'aorta');
  aortaTube.mesh.renderOrder = 2;
  root.add(aortaTube.mesh);

  // The access arteries, wrist to the brachiocephalic trunk (the last stretch of the route lies inside the aorta).
  const accessPath = route.slice(0, AORTA_ENTRY_S);
  const accessMaterial = new THREE.MeshStandardMaterial({ color: 0xd9776b, roughness: 0.45, side: THREE.DoubleSide });
  const accessTube = new TubeMesh(accessPath, (s) => routeDiameterAt(s) / 2, () => [1, 1, 1], accessMaterial, 4, 16, 'access-route');
  root.add(accessTube.mesh);

  const heartBounds = new THREE.Box3().setFromObject(beating);
  const routeBounds = new THREE.Box3().setFromObject(root);

  const applyOverlay = (overlay: ((id: VesselId, s: number, base: Colour) => Colour) | null): void => {
    for (const id of VESSEL_ORDER) {
      const base = baseColour(id);
      coronaryTubes[id].setColours(overlay ? (s) => overlay(id, s, base(s)) : base);
    }
  };

  const applyTreatments = (treatments: readonly Treatment[]): void => {
    for (const id of VESSEL_ORDER) coronaryTubes[id].setRadius((s) => lumenDiameterAt(id, s, treatments) / 2);
  };

  return {
    root,
    beating,
    heartMesh,
    coronaries,
    labels: labelAnchors(),
    heartBounds,
    routeBounds,
    setBeatPhase(phase: number): void {
      beating.scale.setScalar(beatFactor(phase));
    },
    setTreatments: applyTreatments,
    setOverlay: applyOverlay,
    setAortaDye(amount: number): void {
      aortaMaterial.color.setHex(0xd9676a).lerp(new THREE.Color(0x8fd8ff), Math.min(1, Math.max(0, amount)));
      aortaMaterial.opacity = 0.38 + 0.3 * Math.min(1, Math.max(0, amount));
    },
    dispose(): void {
      root.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const material = object.material;
          if (Array.isArray(material)) material.forEach((m) => m.dispose());
          else material.dispose();
        }
      });
    },
  };
}
