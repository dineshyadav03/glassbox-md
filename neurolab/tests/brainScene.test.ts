import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ANATOMY } from '../src/config/anatomy';
import { PULSE_SWELL, buildBrainScene, pulseWave } from '../src/scene/brainScene';
import { clampSwing, easeInOut, fovFor } from '../src/scene/cameraMath';

describe('pulseWave', () => {
  it('rises quickly to its peak and then falls away, once a beat', () => {
    expect(pulseWave(0)).toBe(0);
    expect(pulseWave(0.2)).toBeCloseTo(1, 6);
    expect(pulseWave(0.6)).toBeLessThan(pulseWave(0.3));
    expect(pulseWave(1.2)).toBeCloseTo(pulseWave(0.2), 6);
    expect(pulseWave(-0.8)).toBeCloseTo(pulseWave(0.2), 6);
  });
});

describe('the operative field', () => {
  const scene = buildBrainScene();

  it('has the lobes, every artery and nerve, the sac and bleb, the blades, and a membrane segment for each config entry', () => {
    expect(scene.lobes.frontal.name).toBe('frontal-lobe');
    expect(Object.keys(scene.vessels).sort()).toEqual(['a1', 'achoa', 'ica', 'm1', 'm2-lower', 'm2-upper', 'pcom']);
    expect(Object.keys(scene.nerves).sort()).toEqual(['oculomotor', 'optic']);
    expect(scene.aneurysm.sac.name).toBe('aneurysm-sac');
    expect(scene.spatulas).toHaveLength(2);
    expect([...scene.arachnoid.keys()]).toEqual(ANATOMY.arachnoid.segments.map((s) => s.id));
    expect(scene.labels.length).toBeGreaterThanOrEqual(10);
  });

  it('is built from finite geometry with every index in range', () => {
    scene.root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const position = object.geometry.attributes.position!;
      expect(position.count, object.name).toBeGreaterThan(3);
      for (const value of position.array) expect(Number.isFinite(value), object.name).toBe(true);
      const index = object.geometry.index;
      if (index) expect(Math.max(...index.array), object.name).toBeLessThan(position.count);
    });
  });

  it('places the aneurysm sac and bleb beside the ICA, inside the field bounds', () => {
    const bounds = scene.fieldBounds;
    expect(bounds.containsPoint(scene.aneurysm.bleb.position)).toBe(true);
    const sacBox = new THREE.Box3().setFromObject(scene.aneurysm.sac);
    expect(sacBox.getSize(new THREE.Vector3()).length()).toBeGreaterThan(6);
  });

  it('starts opened, with the blades showing; closing the fissure brings the lobes together and hides them', () => {
    expect(scene.fissureOpening).toBe(1);
    const openGap = scene.lobes.frontal.parent!.position.y - scene.lobes.temporal.parent!.position.y;
    expect(openGap).toBe(ANATOMY.lobes.frontal.retractionMm + ANATOMY.lobes.temporal.retractionMm);
    expect(scene.spatulas.every((blade) => blade.visible)).toBe(true);

    scene.setFissureOpening(0);
    expect(scene.lobes.frontal.parent!.position.y).toBe(0);
    expect(scene.lobes.temporal.parent!.position.y).toBeCloseTo(0, 9);
    expect(scene.spatulas.some((blade) => blade.visible)).toBe(false);

    scene.setFissureOpening(5);
    expect(scene.fissureOpening).toBe(1);
    scene.setFissureOpening(-3);
    expect(scene.fissureOpening).toBe(0);
    scene.setFissureOpening(1);
  });

  it('stretches the membrane with the gap it spans', () => {
    const segment = ANATOMY.arachnoid.segments[0]!;
    scene.setFissureOpening(0);
    const closed = scene.arachnoid.get(segment.id)!.scale.y;
    scene.setFissureOpening(1);
    expect(scene.arachnoid.get(segment.id)!.scale.y).toBeGreaterThan(closed);
  });

  it('cuts and restores a membrane segment, and refuses an unknown one', () => {
    const id = ANATOMY.arachnoid.segments[1]!.id;
    expect(scene.isArachnoidCut(id)).toBe(false);
    scene.setArachnoidCut(id, true);
    expect(scene.isArachnoidCut(id)).toBe(true);
    expect(scene.arachnoid.get(id)!.visible).toBe(false);
    expect(scene.arachnoid.get(ANATOMY.arachnoid.segments[0]!.id)!.visible).toBe(true);
    scene.setArachnoidCut(id, false);
    expect(scene.arachnoid.get(id)!.visible).toBe(true);
    expect(() => scene.setArachnoidCut('nope', true)).toThrow(/unknown/);
  });

  it('swells the arteries with the pulse, by the stated fraction, and not the nerves', () => {
    const radiusOf = (mesh: THREE.Mesh): number => {
      const p = mesh.geometry.attributes.position!;
      // The first ring's distance from the centreline start.
      const ring = [0, 1, 2, 3].map((i) => new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)));
      const centre = ring.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(1 / ring.length);
      return ring[0]!.distanceTo(centre);
    };
    const ica = scene.vessels.ica;
    const optic = scene.nerves.optic;
    scene.setPulse(0.9);
    const rest = radiusOf(ica);
    const opticRest = radiusOf(optic);
    scene.setPulse(0.2);
    const peak = radiusOf(ica);
    expect(peak / rest).toBeGreaterThan(1 + PULSE_SWELL * 0.5);
    expect(radiusOf(optic)).toBe(opticRest);
  });

  it('follows a config edit: a 10 mm dome gives a bigger sac', () => {
    const copy = structuredClone(ANATOMY) as { aneurysm: { domeDiameterMm: number } } & typeof ANATOMY;
    copy.aneurysm.domeDiameterMm = 10;
    const big = buildBrainScene(copy);
    const size = (s: ReturnType<typeof buildBrainScene>): number => new THREE.Box3().setFromObject(s.aneurysm.sac).getSize(new THREE.Vector3()).length();
    expect(size(big)).toBeGreaterThan(size(scene) + 2);
    big.dispose();
  });

  it('disposes without throwing', () => {
    const extra = buildBrainScene();
    expect(() => extra.dispose()).not.toThrow();
  });
});

describe('camera maths', () => {
  it('eases from 0 to 1 and stays within them', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 9);
    expect(easeInOut(-1)).toBe(0);
    expect(easeInOut(7)).toBe(1);
  });

  it('keeps the swing limit in a safe range', () => {
    expect(clampSwing(38)).toBeCloseTo((38 * Math.PI) / 180, 9);
    expect(clampSwing(0)).toBeCloseTo((5 * Math.PI) / 180, 9);
    expect(clampSwing(500)).toBeCloseTo((80 * Math.PI) / 180, 9);
  });

  it('keeps the configured field of view in a landscape window and widens it in a narrow one', () => {
    expect(fovFor(22, 1.8)).toBe(22);
    expect(fovFor(22, 0.9)).toBeGreaterThan(22);
    expect(fovFor(22, 0.2)).toBeLessThanOrEqual(70);
  });
});
