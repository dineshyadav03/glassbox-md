import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { labelAnchors } from '../src/anatomy/labels';
import { heartField } from '../src/anatomy/heartShape';
import { buildAnatomyScene } from '../src/scene/anatomyScene';
import { LESION, VESSELS, VESSEL_ORDER } from '../src/config/anatomy';
import type { Treatment } from '../src/physics/lesion';

const scene = buildAnatomyScene();

function widthAt(mesh: THREE.Mesh, ringIndex: number, perRing: number): number {
  // Distance between two opposite vertices of a ring is the tube's diameter.
  const position = mesh.geometry.attributes.position!;
  const a = new THREE.Vector3().fromBufferAttribute(position, ringIndex * perRing);
  const b = new THREE.Vector3().fromBufferAttribute(position, ringIndex * perRing + perRing / 2);
  return a.distanceTo(b);
}

describe('anatomy scene', () => {
  it('draws the heart and all six coronary arteries in the beating group', () => {
    expect(scene.beating.children).toContain(scene.heartMesh);
    for (const id of VESSEL_ORDER) expect(scene.beating.children).toContain(scene.coronaries[id]);
  });

  it('draws the aorta and the access route outside the beating group, so they do not pulse', () => {
    const fixed = scene.root.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh).map((m) => m.name);
    expect(fixed).toContain('aorta');
    expect(fixed).toContain('access-route');
    expect(scene.beating.children.map((c) => c.name)).not.toContain('aorta');
  });

  it('has lights', () => {
    const lights = scene.root.children.filter((c) => (c as THREE.Light).isLight);
    expect(lights.length).toBeGreaterThanOrEqual(2);
  });

  it('has a heart mesh with finite vertices, normals and colours, and valid indices', () => {
    const g = scene.heartMesh.geometry;
    for (const name of ['position', 'normal', 'color'] as const) {
      const array = g.attributes[name]!.array as Float32Array;
      expect(array.every((x) => Number.isFinite(x))).toBe(true);
    }
    const max = Math.max(...(g.index!.array as Uint32Array | Uint16Array));
    expect(max).toBeLessThan(g.attributes.position!.count);
  });

  it('has a heart whose outward normals point away from the centre (not inside out)', () => {
    const g = scene.heartMesh.geometry;
    const position = g.attributes.position!;
    const normal = g.attributes.normal!;
    let outward = 0;
    let total = 0;
    for (let i = 0; i < position.count; i += 7) {
      const p = new THREE.Vector3().fromBufferAttribute(position, i);
      const n = new THREE.Vector3().fromBufferAttribute(normal, i);
      if (n.lengthSq() < 0.5) continue; // the poles collapse to a point; skip them
      total++;
      if (p.dot(n) > 0) outward++;
    }
    expect(outward / total).toBeGreaterThan(0.97);
  });

  it('keeps every heart vertex on the implicit surface the arteries were snapped to', () => {
    const position = scene.heartMesh.geometry.attributes.position!;
    for (let i = 0; i < position.count; i += 11) {
      const p = new THREE.Vector3().fromBufferAttribute(position, i);
      expect(heartField([p.x, p.y, p.z])).toBeCloseTo(1, 3);
    }
  });

  it('beats: the group shrinks in systole and is full size in diastole', () => {
    scene.setBeatPhase(0);
    expect(scene.beating.scale.x).toBeCloseTo(1, 9);
    scene.setBeatPhase(0.38);
    expect(scene.beating.scale.x).toBeLessThan(0.95);
    expect(scene.beating.scale.x).toBeGreaterThan(0.9);
    scene.setBeatPhase(0);
  });

  it('draws the LAD narrowed at the lesion, to true scale', () => {
    const mesh = scene.coronaries.LAD;
    const perRing = 14;
    const ringStep = 0.75; // mm between rings in the scene builder
    const atLesion = widthAt(mesh, Math.round(LESION.centreS / ringStep), perRing);
    const upstream = widthAt(mesh, Math.round(20 / ringStep), perRing);
    // 90% diameter stenosis of a ~2.97 mm vessel leaves about 0.3 mm.
    expect(atLesion).toBeLessThan(0.5);
    expect(upstream).toBeGreaterThan(3.2);
    expect(upstream / atLesion).toBeGreaterThan(8);
  });

  it('opens the lesion when a stent is deployed over it, and restores it when removed', () => {
    const mesh = scene.coronaries.LAD;
    const perRing = 14;
    const ringStep = 0.75;
    const ring = Math.round(LESION.centreS / ringStep);
    const before = widthAt(mesh, ring, perRing);
    const stent: Treatment = { kind: 'stent', vessel: 'LAD', centreS: LESION.centreS, length: 18, diameter: 3.0 };
    scene.setTreatments([stent]);
    const after = widthAt(mesh, ring, perRing);
    expect(after).toBeGreaterThan(before * 5);
    expect(after).toBeLessThan(3.2);
    scene.setTreatments([]);
    expect(widthAt(mesh, ring, perRing)).toBeCloseTo(before, 4);
  });

  it('only changes the vessel that was treated', () => {
    const rca = scene.coronaries.RCA;
    const before = Array.from(rca.geometry.attributes.position!.array as Float32Array);
    scene.setTreatments([{ kind: 'stent', vessel: 'LAD', centreS: 48, length: 18, diameter: 3.0 }]);
    const after = Array.from(rca.geometry.attributes.position!.array as Float32Array);
    scene.setTreatments([]);
    expect(after).toEqual(before);
  });

  it('fits the camera bounds: the heart box is small, the route box spans the whole body', () => {
    const heart = scene.heartBounds.getSize(new THREE.Vector3());
    const all = scene.routeBounds.getSize(new THREE.Vector3());
    expect(heart.y).toBeGreaterThan(80);
    expect(heart.y).toBeLessThan(160);
    expect(all.y).toBeGreaterThan(400);
    expect(all.x).toBeGreaterThan(200);
  });
});

describe('labels', () => {
  const labels = labelAnchors();

  it('has a label for every coronary vessel, the lesion, the aorta and each access segment', () => {
    const ids = labels.map((l) => l.id);
    for (const id of VESSEL_ORDER) expect(ids).toContain(`vessel-${id}`);
    for (const id of ['lesion', 'aorta', 'aortic-root', 'route-radial', 'route-brachial', 'route-axillary', 'route-subclavian', 'route-brachiocephalic']) {
      expect(ids).toContain(id);
    }
  });

  it('has unique ids, finite positions and non-empty text', () => {
    expect(new Set(labels.map((l) => l.id)).size).toBe(labels.length);
    for (const l of labels) {
      expect(l.position.every((c) => Number.isFinite(c))).toBe(true);
      expect(l.text.length).toBeGreaterThan(0);
      expect(l.detail.length).toBeGreaterThan(10);
    }
  });

  it('quotes lengths from the config, so a tooltip cannot disagree with the rules', () => {
    for (const id of VESSEL_ORDER) {
      const label = labels.find((l) => l.id === `vessel-${id}`)!;
      expect(label.detail).toContain(`${VESSELS[id].length} mm`);
    }
    expect(labels.find((l) => l.id === 'lesion')!.detail).toContain('90%');
  });

  it('shows coronary labels only when zoomed in, and route labels at any zoom', () => {
    for (const l of labels.filter((x) => x.id.startsWith('vessel-') || x.id === 'lesion' || x.id === 'aortic-root')) expect(l.scope).toBe('heart');
    for (const l of labels.filter((x) => x.id.startsWith('route-') || x.id === 'aorta')) expect(l.scope).toBe('body');
  });

  it('marks the lesion as the emphasised label and puts the coronary labels in the beating group', () => {
    expect(labels.filter((l) => l.emphasis).map((l) => l.id)).toEqual(['lesion']);
    for (const l of labels.filter((x) => x.id.startsWith('vessel-') || x.id === 'lesion')) expect(l.beats).toBe(true);
    for (const l of labels.filter((x) => x.id.startsWith('route-'))) expect(l.beats).toBe(false);
  });

  it('keeps coronary labels clear of the vessel they name (outside the heart surface)', () => {
    for (const l of labels.filter((x) => x.beats)) expect(heartField(l.position)).toBeGreaterThan(1);
  });
});
