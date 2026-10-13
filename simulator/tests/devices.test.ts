import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createSimulation } from '../src/engine/simulation';
import { buildAnatomyScene } from '../src/scene/anatomyScene';
import { createDeviceView } from '../src/scene/devices';
import { Player, playGoodCase } from './helpers/player';

function setup() {
  const anatomy = buildAnatomyScene();
  const view = createDeviceView(anatomy);
  const find = (name: string) => {
    let found: THREE.Object3D | undefined;
    anatomy.root.traverse((o) => {
      if (o.name === name) found = o;
    });
    return found as THREE.Mesh | undefined;
  };
  const drawn = (name: string) => {
    const m = find(name);
    return m && m.visible ? m.geometry.drawRange.count : 0;
  };
  return { anatomy, view, find, drawn };
}

describe('device view', () => {
  it('draws nothing for a fresh case', () => {
    const { view, drawn, find } = setup();
    view.update(createSimulation());
    expect(drawn('guide-catheter')).toBe(0);
    expect(find('guide-tip')!.visible).toBe(false);
    expect(find('wire-LAD')!.visible).toBe(false);
    expect(find('balloon-body')!.visible).toBe(false);
  });

  it('grows the guide along the route as it advances, and its tip follows', () => {
    const { view, drawn, find } = setup();
    const p = new Player().until({ advance: 1 }, (s) => s.guide.s >= 100);
    view.update(p.sim);
    const early = drawn('guide-catheter');
    expect(early).toBeGreaterThan(0);
    p.until({ advance: 1 }, (s) => s.guide.s >= 400);
    view.update(p.sim);
    expect(drawn('guide-catheter')).toBeGreaterThan(early);
    expect(find('guide-tip')!.visible).toBe(true);
  });

  it('extends the guide into the left main once seated, and shows the tip-direction arrow only for the guide', () => {
    const { view, drawn, find } = setup();
    const p = new Player().hold({ rotate: 1 }, 1).until({ advance: 1 }, (s) => s.guide.s >= 829.9);
    view.update(p.sim);
    const atRoot = drawn('guide-catheter');
    expect(find('guide-tip-direction')!.visible).toBe(true);
    p.until({ advance: 1, fine: true }, (s) => s.guide.engaged, 20);
    view.update(p.sim);
    expect(drawn('guide-catheter')).toBeGreaterThan(atRoot);
    p.angiogram().do({ type: 'heparin' }).do({ type: 'select-tool', tool: 'wire' });
    view.update(p.sim);
    expect(find('guide-tip-direction')!.visible).toBe(false);
  });

  it('shows the wire along the route it took, and only that one', () => {
    const { view, drawn, find } = setup();
    const p = playGoodCase({ stopAfterWire: true });
    view.update(p.sim);
    expect(find('wire-LAD')!.visible).toBe(true);
    expect(find('wire-LCx')!.visible).toBe(false);
    expect(find('wire-D1')!.visible).toBe(false);
    expect(find('wire-tip')!.visible).toBe(true);
    const lad = drawn('wire-LAD');
    expect(lad).toBeGreaterThan(0);
    // Pulling the wire back shortens it.
    p.do({ type: 'select-tool', tool: 'wire' }).hold({ advance: -1 }, 3);
    view.update(p.sim);
    expect(drawn('wire-LAD')).toBeLessThan(lad);
  });

  it('draws the balloon swelling with pressure and back down, and hides it once in the guide', () => {
    const { view, find } = setup();
    const p = playGoodCase({ stopAfterWire: true }).do({ type: 'select-tool', tool: 'balloon' });
    p.until({ advance: 1 }, (s) => (s.balloon.centreS ?? 0) > 40, 30);
    view.update(p.sim);
    const balloon = find('balloon-body')!;
    expect(balloon.visible).toBe(true);
    const width = () => {
      balloon.geometry.computeBoundingBox();
      const box = balloon.geometry.boundingBox!;
      return Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    };
    const folded = width();
    p.until({ inflate: true }, (s) => s.balloon.pressure >= 10, 20);
    view.update(p.sim);
    expect(width()).toBeGreaterThan(folded);
    p.until({ deflate: true }, (s) => s.balloon.pressure < 1, 20).until({ advance: -1 }, (s) => s.balloon.inGuide, 60);
    view.update(p.sim);
    expect(balloon.visible).toBe(false);
  });

  it('leaves a stent lattice in the artery after the delivery catheter is withdrawn, and opens the lumen under it', () => {
    const { view, find, anatomy } = setup();
    const p = playGoodCase({ stopAfterWire: true });
    const lesionWidth = () => {
      const position = anatomy.coronaries.LAD.geometry.attributes.position!;
      const perRing = 14;
      const ring = Math.round(48 / 0.75);
      const a = new THREE.Vector3().fromBufferAttribute(position, ring * perRing);
      const b = new THREE.Vector3().fromBufferAttribute(position, ring * perRing + perRing / 2);
      return a.distanceTo(b);
    };
    view.update(p.sim);
    const before = lesionWidth();
    expect(before).toBeLessThan(0.5);
    const done = playGoodCase();
    view.update(done.sim);
    expect(find('deployed-stent-0')!.visible).toBe(true);
    expect(find('stent-stent-lattice')!.visible).toBe(false);
    expect(lesionWidth()).toBeGreaterThan(2.5);
  });

  it('darkens the wall for a dissection and fills with dye during an injection, then clears', () => {
    const { view, anatomy } = setup();
    const colourAt = (ring: number) => anatomy.coronaries.LAD.geometry.attributes.color!.array[ring * 14 * 3 + 2] as number;
    const upstream = Math.round(20 / 0.75);
    const p = playGoodCase({ stopAfterWire: true });
    view.update(p.sim);
    const baseBlue = colourAt(upstream);
    p.hold({ fluoro: true }, 0.1).do({ type: 'inject' }).hold({ fluoro: true }, 2.5);
    view.update(p.sim);
    expect(colourAt(upstream)).toBeGreaterThan(baseBlue + 0.2);
    p.until({}, (s) => s.injection === null, 30);
    view.update(p.sim);
    expect(colourAt(Math.round(20 / 0.75))).toBeLessThan(0.4);
  });

  it('has finite geometry throughout a whole case and disposes cleanly', () => {
    const { view, anatomy } = setup();
    const done = playGoodCase();
    view.update(done.sim);
    anatomy.root.traverse((o) => {
      if (o instanceof THREE.Mesh && o.geometry.attributes.position) {
        expect((o.geometry.attributes.position.array as Float32Array).every((x) => Number.isFinite(x))).toBe(true);
      }
    });
    expect(() => view.dispose()).not.toThrow();
    expect(() => anatomy.dispose()).not.toThrow();
  });
});
