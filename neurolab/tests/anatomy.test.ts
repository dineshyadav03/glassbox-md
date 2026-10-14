import { describe, expect, it } from 'vitest';
import { aneurysmGeometry } from '../src/anatomy/aneurysm';
import { labelAnchors } from '../src/anatomy/labels';
import { buildLobe, gyralHeight, lobeSurfaceY } from '../src/anatomy/lobe';
import { buildNerves, buildVessels, icaPointBack } from '../src/anatomy/vessels';
import { distance, length, sub } from '../src/anatomy/vec3';
import { ANATOMY } from '../src/config/anatomy';

/** A deep copy of the config with the aneurysm edited, to show a config change reaches the geometry. */
function withAneurysm(patch: Partial<typeof ANATOMY.aneurysm>): typeof ANATOMY {
  const copy = structuredClone(ANATOMY) as { aneurysm: Record<string, unknown> } & typeof ANATOMY;
  Object.assign(copy.aneurysm, patch);
  return copy;
}

const maxRadius = (g: ReturnType<typeof aneurysmGeometry>): number => {
  let best = 0;
  for (let s = 0; s <= g.path.length; s += 0.02) best = Math.max(best, g.radiusAt(s));
  return best;
};

describe('the aneurysm', () => {
  it('has the 6.6 mm dome from the config', () => {
    const g = aneurysmGeometry();
    expect(ANATOMY.aneurysm.domeDiameterMm).toBe(6.6);
    expect(maxRadius(g) * 2).toBeCloseTo(6.6, 1);
  });

  it('follows a config edit: a 10 mm dome is wider and taller', () => {
    const small = aneurysmGeometry();
    const big = aneurysmGeometry(withAneurysm({ domeDiameterMm: 10 }));
    expect(maxRadius(big) * 2).toBeCloseTo(10, 1);
    expect(big.heightMm).toBeGreaterThan(small.heightMm + 3);
    expect(distance(big.domeCentre, big.neckCentre)).toBeGreaterThan(distance(small.domeCentre, small.neckCentre));
  });

  it('narrows to the neck at the vessel and closes at the far end of the dome', () => {
    const g = aneurysmGeometry();
    expect(g.radiusAt(g.insideMm)).toBeCloseTo(g.neckRadius, 6);
    expect(g.radiusAt(g.path.length)).toBe(0);
    expect(g.neckRadius * 2).toBeCloseTo(ANATOMY.aneurysm.neckWidthMm, 6);
    expect(g.neckRadius).toBeLessThan(g.domeRadius);
  });

  it('never makes the neck wider than the dome', () => {
    const g = aneurysmGeometry(withAneurysm({ domeDiameterMm: 2, neckWidthMm: 4 }));
    expect(g.neckRadius).toBeLessThanOrEqual(g.domeRadius);
  });

  it('springs from the ICA surface at the junction, pointing the configured way', () => {
    const g = aneurysmGeometry();
    const ica = icaPointBack(ANATOMY, ANATOMY.aneurysm.junctionBackMm);
    expect(distance(g.neckCentre, ica.point)).toBeCloseTo(ica.radius, 5);
    expect(length(g.axis)).toBeCloseTo(1, 6);
    const [dx, dy, dz] = ANATOMY.aneurysm.direction;
    expect(Math.sign(g.axis[0])).toBe(Math.sign(dx));
    expect(Math.sign(g.axis[1])).toBe(Math.sign(dy));
    expect(Math.sign(g.axis[2])).toBe(Math.sign(dz));
  });

  it('has a bleb that sits on the dome surface and is smaller than the dome', () => {
    const g = aneurysmGeometry();
    expect(g.bleb.radius).toBeLessThan(g.domeRadius / 2);
    const fromCentre = distance(g.bleb.centre, g.domeCentre);
    expect(fromCentre).toBeGreaterThan(g.domeRadius - 0.01);
    expect(fromCentre).toBeLessThan(g.domeRadius + g.bleb.radius);
  });
});

describe('the vessels', () => {
  const vessels = buildVessels();
  const start = (id: keyof typeof vessels) => vessels[id].path.positionAt(0);
  const end = (id: keyof typeof vessels) => vessels[id].path.positionAt(vessels[id].path.length);

  it('branch exactly where their parent vessel is', () => {
    expect(distance(start('m1'), end('ica'))).toBeLessThan(1e-6);
    expect(distance(start('a1'), end('ica'))).toBeLessThan(1e-6);
    expect(distance(start('m2-upper'), end('m1'))).toBeLessThan(1e-6);
    expect(distance(start('m2-lower'), end('m1'))).toBeLessThan(1e-6);
  });

  it('start the posterior communicating and anterior choroidal arteries on the ICA', () => {
    for (const id of ['pcom', 'achoa'] as const) {
      let nearest = Infinity;
      for (const p of vessels.ica.path.points) nearest = Math.min(nearest, distance(p, start(id)));
      expect(nearest).toBeLessThan(0.6);
    }
  });

  it('put the anterior choroidal artery beyond the posterior communicating one, as in life', () => {
    const along = (id: 'pcom' | 'achoa'): number => {
      let best = 0;
      let bestDistance = Infinity;
      vessels.ica.path.points.forEach((p, i) => {
        const d = distance(p, start(id));
        if (d < bestDistance) {
          bestDistance = d;
          best = vessels.ica.path.cumulative[i]!;
        }
      });
      return best;
    };
    expect(along('achoa')).toBeGreaterThan(along('pcom'));
  });

  it('have sensible, positive radii that taper or hold along their length', () => {
    for (const tube of [...Object.values(vessels), ...Object.values(buildNerves())]) {
      for (let s = 0; s <= tube.path.length; s += tube.path.length / 10) expect(tube.radiusAt(s)).toBeGreaterThan(0.2);
    }
    expect(vessels.ica.radiusAt(0)).toBeGreaterThan(vessels.m1.radiusAt(0));
    expect(vessels.m1.radiusAt(0)).toBeGreaterThan(vessels.pcom.radiusAt(0));
  });

  it('follow a config edit to the ICA (the branches move with it)', () => {
    const copy = structuredClone(ANATOMY) as typeof ANATOMY & { vessels: { ica: { controls: number[][] } } };
    copy.vessels.ica.controls[3] = [-7, 12, -47];
    const moved = buildVessels(copy);
    expect(distance(moved.m1.path.positionAt(0), [-7, 12, -47])).toBeLessThan(1e-6);
  });
});

describe('the lobes', () => {
  const frontal = ANATOMY.lobes.frontal;
  const temporal = ANATOMY.lobes.temporal;

  it('lie over the vessels when the fissure is closed, and leave them in a clear gap when it is opened', () => {
    const closedTop = lobeSurfaceY(temporal, 0, -48, 'top')!;
    const closedBottom = lobeSurfaceY(frontal, 0, -48, 'bottom')!;
    expect(closedBottom - closedTop).toBeGreaterThan(8);
    const mid = buildVessels().m1.path.positionAt(buildVessels().m1.path.length / 2);
    expect(mid[1]).toBeGreaterThan(closedBottom - ANATOMY.lobes.gyriAmplitudeMm);

    const top = closedTop - temporal.retractionMm;
    const bottom = closedBottom + frontal.retractionMm;
    const m1Mid = buildVessels().m1.path.positionAt(buildVessels().m1.path.length / 2);
    expect(m1Mid[1]).toBeLessThan(bottom - ANATOMY.lobes.gyriAmplitudeMm);
    expect(m1Mid[1]).toBeGreaterThan(top + ANATOMY.lobes.gyriAmplitudeMm);
  });

  it('open further when the retraction is applied', () => {
    const closed = lobeSurfaceY(frontal, 0, -48, 'bottom')! - lobeSurfaceY(temporal, 0, -48, 'top')!;
    const open = closed + frontal.retractionMm + temporal.retractionMm;
    expect(open).toBeGreaterThan(closed + 20);
  });

  it('has folds that stay within -1 and 1 and the same answer every time', () => {
    for (let i = 0; i < 200; i++) {
      const p: [number, number, number] = [(i * 7.3) % 90, (i * 3.1) % 60, (i * 5.9) % 80];
      const h = gyralHeight(p, 15);
      expect(h).toBeGreaterThanOrEqual(-1);
      expect(h).toBeLessThanOrEqual(1);
      expect(gyralHeight(p, 15)).toBe(h);
    }
  });

  it('builds a closed-index mesh with finite coordinates and the surface within the fold height of the ellipsoid', () => {
    const mesh = buildLobe(frontal);
    expect(Math.max(...mesh.indices)).toBeLessThan(mesh.positions.length / 3);
    expect(mesh.positions.every(Number.isFinite)).toBe(true);
    const bound = ANATOMY.lobes.gyriAmplitudeMm + 1e-3;
    for (let i = 0; i < mesh.positions.length; i += 300) {
      const q = [mesh.positions[i]! - frontal.centre[0], mesh.positions[i + 1]! - frontal.centre[1], mesh.positions[i + 2]! - frontal.centre[2]];
      const k = Math.hypot(q[0]! / frontal.radii[0], q[1]! / frontal.radii[1], q[2]! / frontal.radii[2]);
      expect(Math.abs(k - 1) * Math.min(...frontal.radii)).toBeLessThan(bound * 1.2);
    }
  });
});

describe('the labels', () => {
  const labels = labelAnchors();

  it('name each structure once, with a hover explanation', () => {
    const ids = labels.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['ica', 'm1', 'a1', 'pcom', 'achoa', 'optic', 'oculomotor', 'aneurysm', 'frontal', 'temporal']) expect(ids).toContain(id);
    for (const l of labels) expect(l.detail.length).toBeGreaterThan(20);
  });

  it('marks only the aneurysm as the emphasised one', () => {
    expect(labels.filter((l) => l.emphasis).map((l) => l.id)).toEqual(['aneurysm']);
  });

  it('sit near the structures they name, and move with a config edit', () => {
    const vessels = buildVessels();
    const m1 = labels.find((l) => l.id === 'm1')!;
    let nearest = Infinity;
    for (const p of vessels.m1.path.points) nearest = Math.min(nearest, length(sub(p, m1.position)));
    expect(nearest).toBeLessThan(8);

    const near = labelAnchors().find((l) => l.id === 'aneurysm')!.position;
    const far = labelAnchors(withAneurysm({ domeDiameterMm: 12 })).find((l) => l.id === 'aneurysm')!.position;
    expect(distance(near, far)).toBeGreaterThan(1);
  });
});
