import { describe, expect, it } from 'vitest';
import { anatomyPaths } from '../src/anatomy/centrelines';
import { LESION } from '../src/config/anatomy';
import { createSimulation, type Simulation } from '../src/engine/simulation';
import { buildXrayFrame, beatScale, convexHull, dyeAlpha, stainStrength, fieldOfViewMm, xrayCentre, xrayMode, type Line, type Prim } from '../src/xray/frame';
import { makeCamera, project, type CArmAngles } from '../src/xray/projection';
import { Player, playGoodCase } from './helpers/player';

const SIZE = 640;
const lines = (prims: readonly Prim[], shade?: string): Line[] => prims.filter((p): p is Line => p.kind === 'line' && (!shade || p.shade === shade));

function frameOf(sim: Simulation, angles: CArmAngles = sim.carmAngles, fieldMm?: number) {
  return buildXrayFrame(sim, { angles, centre: xrayCentre(sim), fieldMm: fieldMm ?? fieldOfViewMm(sim), size: SIZE, heartRate: 72 });
}

/** The LAD's rail position nearest to an image point, using the same camera. */
function nearestS(sim: Simulation, x: number, y: number, fieldMm: number, angles: CArmAngles): number {
  const camera = makeCamera(angles, xrayCentre(sim), fieldMm, SIZE);
  const path = anatomyPaths().vessels.LAD;
  let best = 0;
  let bestDist = Infinity;
  for (let s = 0; s <= path.length; s += 0.5) {
    const q = project(camera, path.positionAt(s));
    const d = Math.hypot(q.x - x, q.y - y);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}

describe('convexHull', () => {
  it('drops interior points and returns the outline', () => {
    const hull = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [3, 7]]);
    expect(hull).toHaveLength(4);
    expect(hull.some((p) => p[0] === 5 && p[1] === 5)).toBe(false);
  });

  it('copes with fewer than three points', () => {
    expect(convexHull([[1, 1]])).toEqual([[1, 1]]);
    expect(convexHull([])).toEqual([]);
  });
});

describe('what is visible when', () => {
  it('shows nothing live and no dye for a fresh case', () => {
    expect(xrayMode(createSimulation())).toEqual({ live: false, showDye: false });
  });

  it('goes live while the pedal is down', () => {
    const p = new Player().hold({ fluoro: true }, 0.1);
    expect(xrayMode(p.sim)).toEqual({ live: true, showDye: false });
  });

  it('shows dye through a recorded run even after the pedal is released, and goes live for the run', () => {
    const p = playGoodCase({ stopAfterWire: true }).hold({ fluoro: true }, 0.1).do({ type: 'inject' }).hold({}, 1);
    expect(p.sim.injection!.recorded).toBe(true);
    expect(xrayMode(p.sim)).toEqual({ live: true, showDye: true });
  });

  it('shows no dye for a run started without the pedal, unless the pedal is pressed during it', () => {
    const p = playGoodCase({ stopAfterWire: true }).do({ type: 'inject' }).hold({}, 1);
    expect(p.sim.injection!.recorded).toBe(false);
    expect(xrayMode(p.sim)).toEqual({ live: false, showDye: false });
    p.hold({ fluoro: true }, 0.2);
    expect(xrayMode(p.sim)).toEqual({ live: true, showDye: true });
  });
});

describe('the backdrop', () => {
  it('always shows the heart, spine, ribs and arm bones, and finite coordinates', () => {
    const frame = frameOf(createSimulation());
    expect(frame.backdrop.some((p) => p.kind === 'polygon' && p.shade === 'tissue')).toBe(true);
    expect(frame.backdrop.filter((p) => p.shade === 'bone').length).toBeGreaterThan(30);
    for (const p of frame.backdrop) {
      const numbers = p.kind === 'line' ? [p.x1, p.y1, p.x2, p.y2, p.width, p.alpha] : [...p.points, p.alpha];
      expect(numbers.every(Number.isFinite)).toBe(true);
    }
  });

  it('draws no devices and no dye while the beam is off', () => {
    const p = new Player().until({ advance: 1 }, (s) => s.guide.s >= 200);
    const frame = frameOf(p.sim);
    expect(frame.devices).toEqual([]);
    expect(frame.dye).toEqual([]);
  });

  it('moves with the C-arm: the heart shadow shifts when the projection changes', () => {
    const sim = createSimulation();
    const ap = frameOf(sim, { laoDeg: 0, cranialDeg: 0 }, 220).backdrop.find((p) => p.kind === 'polygon' && p.shade === 'tissue')!;
    const lao = frameOf(sim, { laoDeg: 60, cranialDeg: 0 }, 220).backdrop.find((p) => p.kind === 'polygon' && p.shade === 'tissue')!;
    if (ap.kind !== 'polygon' || lao.kind !== 'polygon') throw new Error('expected polygons');
    expect(ap.points).not.toEqual(lao.points);
  });
});

describe('the heart beats in the picture', () => {
  it('scales between full size and the end-systolic size', () => {
    const sim = createSimulation();
    const seen = new Set<number>();
    for (let t = 0; t < 1; t += 0.05) seen.add(Math.round(beatScale({ ...sim, time: t }, 72) * 1000));
    expect(Math.max(...seen)).toBeLessThanOrEqual(1000);
    expect(Math.min(...seen)).toBeLessThan(960);
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(920);
  });
});

describe('devices', () => {
  it('shows the guide as a catheter line that runs from the arm up to its tip, with a marker band, only on fluoroscopy', () => {
    const p = new Player().until({ advance: 1 }, (s) => s.guide.s >= 400).hold({ fluoro: true }, 0.1);
    const frame = frameOf(p.sim);
    expect(lines(frame.devices, 'catheter').length).toBeGreaterThan(20);
    expect(lines(frame.devices, 'marker')).toHaveLength(1);
    const camera = makeCamera(p.sim.carmAngles, xrayCentre(p.sim), fieldOfViewMm(p.sim), SIZE);
    const tip = project(camera, anatomyPaths().route.positionAt(p.sim.guide.s));
    const marker = lines(frame.devices, 'marker')[0]!;
    expect(Math.hypot(marker.x2 - tip.x, marker.y2 - tip.y)).toBeLessThan(2);
  });

  it('draws a longer guide as more of the route', () => {
    const short = new Player().until({ advance: 1 }, (s) => s.guide.s >= 150).hold({ fluoro: true }, 0.1);
    const long = new Player().until({ advance: 1 }, (s) => s.guide.s >= 600).hold({ fluoro: true }, 0.1);
    expect(lines(frameOf(long.sim).devices, 'catheter').length).toBeGreaterThan(lines(frameOf(short.sim).devices, 'catheter').length);
  });

  it('shows the wire, the balloon markers and a swollen balloon outline in the artery', () => {
    const p = playGoodCase({ stopAfterWire: true }).do({ type: 'select-tool', tool: 'balloon' });
    p.until({ advance: 1 }, (s) => (s.balloon.centreS ?? 0) >= 40, 30).hold({ fluoro: true }, 0.1);
    const folded = frameOf(p.sim);
    expect(lines(folded.devices, 'wire').length).toBeGreaterThan(10);
    expect(lines(folded.devices, 'marker').length).toBeGreaterThanOrEqual(2);
    const widthBefore = Math.max(...lines(folded.devices, 'balloon').map((l) => l.width));
    p.until({ inflate: true, fluoro: true }, (s) => s.balloon.pressure >= 10, 20);
    const widthAfter = Math.max(...lines(frameOf(p.sim).devices, 'balloon').map((l) => l.width));
    expect(widthAfter).toBeGreaterThan(widthBefore * 1.5);
  });

  it('leaves the deployed stent in the picture as struts after the catheter is gone', () => {
    const p = playGoodCase().hold({ fluoro: true }, 0.1);
    expect(p.sim.stent.inGuide).toBe(true);
    expect(lines(frameOf(p.sim).devices, 'stent').length).toBeGreaterThan(20);
  });
});

describe('contrast', () => {
  const fov = 80;

  it('is empty at the instant of injection and fills in as the dye arrives', () => {
    const p = playGoodCase({ stopAfterWire: true }).hold({ fluoro: true }, 0.1).do({ type: 'inject' });
    const first = frameOf(p.sim, p.sim.carmAngles, fov).dye.length;
    p.hold({ fluoro: true }, 1.2);
    const later = frameOf(p.sim, p.sim.carmAngles, fov).dye.length;
    expect(first).toBeLessThan(5);
    expect(later).toBeGreaterThan(first + 20);
  });

  it('draws the lesion as a pinch: the dye column is far thinner there than just upstream', () => {
    const p = playGoodCase({ stopAfterWire: true }).hold({ fluoro: true }, 0.1).do({ type: 'inject' }).hold({ fluoro: true }, 3);
    const dye = lines(frameOf(p.sim, p.sim.carmAngles, fov).dye, 'dye');
    const atS = (target: number): Line => {
      let best = dye[0]!;
      let bestGap = Infinity;
      for (const l of dye) {
        const s = nearestS(p.sim, (l.x1 + l.x2) / 2, (l.y1 + l.y2) / 2, fov, p.sim.carmAngles);
        const gap = Math.abs(s - target);
        if (gap < bestGap) {
          bestGap = gap;
          best = l;
        }
      }
      return best;
    };
    const upstream = atS(25);
    const lesion = atS(LESION.centreS);
    expect(upstream.width).toBeGreaterThan(lesion.width * 4);
  });

  it('opens the pinch after the stent, in the final angiogram', () => {
    const p = playGoodCase();
    // Replay one more injection after the case ended is not possible; use the state just before it ended.
    expect(p.sim.ended).toBe(true);
    const stented = createSimulationWithStent();
    const dye = lines(frameOf(stented, stented.carmAngles, fov).dye, 'dye');
    const widths = dye.map((l) => l.width);
    expect(Math.max(...widths)).toBeGreaterThan(10);
    // No segment of the LAD is near-threadlike where the lesion was.
    const lesionLines = dye.filter((l) => Math.abs(nearestS(stented, (l.x1 + l.x2) / 2, (l.y1 + l.y2) / 2, fov, stented.carmAngles) - LESION.centreS) < 5);
    expect(Math.min(...lesionLines.map((l) => l.width))).toBeGreaterThan(8);
  });

  it('shows an aortic flush as a wide fading column in the aorta, not the coronary tree', () => {
    const p = new Player().hold({ rotate: 1 }, 1).until({ advance: 1 }, (s) => s.guide.s >= 725).hold({ fluoro: true }, 0.1).do({ type: 'inject' }).hold({ fluoro: true }, 0.5);
    expect(p.sim.injection!.selective).toBe(false);
    const dye = lines(frameOf(p.sim, p.sim.carmAngles, 160).dye, 'dye');
    expect(dye.length).toBeGreaterThan(5);
    expect(Math.max(...dye.map((l) => l.width))).toBeGreaterThan(20);
  });

  it('is washed out once the run is over', () => {
    const p = playGoodCase({ stopAfterWire: true }).hold({ fluoro: true }, 0.1).do({ type: 'inject' });
    p.until({ fluoro: true }, (s) => s.injection === null, 30);
    expect(frameOf(p.sim, p.sim.carmAngles, fov).dye).toEqual([]);
  });

  it('shows a filling defect where an unsealed dissection tears the wall', () => {
    const p = new Player(() => 0);
    p.hold({ rotate: 1 }, 1).until({ advance: 1 }, (s) => s.guide.s >= 829.9);
    p.until({ advance: 1, fine: true }, (s) => s.guide.engaged, 20).angiogram().do({ type: 'heparin' });
    p.do({ type: 'select-tool', tool: 'wire' }).hold({ rotate: -1 }, 0.5);
    p.until({ advance: 1, fine: true }, (s) => s.wire.vessel === 'LAD', 30).hold({ rotate: 1 }, 0.5);
    p.until({ advance: 1 }, (s) => s.wire.s >= 78, 30);
    expect(p.sim.dissections).toHaveLength(1);
    p.hold({ fluoro: true }, 0.1).do({ type: 'inject' }).hold({ fluoro: true }, 4);
    // The same moment, with and without the tear recorded: only the wall's filling defect differs.
    const intact = { ...p.sim, dissections: [] };
    const tornAlpha = dyeAlpha(p.sim, 'LAD', LESION.centreS);
    expect(tornAlpha).toBeGreaterThan(0.1);
    expect(tornAlpha).toBeLessThan(dyeAlpha(intact, 'LAD', LESION.centreS) * 0.6);
    // Away from the tear nothing changes.
    expect(dyeAlpha(p.sim, 'LAD', 62)).toBeCloseTo(dyeAlpha(intact, 'LAD', 62), 9);
    expect(dyeAlpha(p.sim, 'LCx', 30)).toBeCloseTo(dyeAlpha(intact, 'LCx', 30), 9);
  });
});

describe('contrast staining from a tear', () => {
  function tornCase(): Player {
    const p = new Player(() => 0);
    p.hold({ rotate: 1 }, 1).until({ advance: 1 }, (s) => s.guide.s >= 829.9);
    p.until({ advance: 1, fine: true }, (s) => s.guide.engaged, 20).angiogram().do({ type: 'heparin' });
    p.do({ type: 'select-tool', tool: 'wire' }).hold({ rotate: -1 }, 0.5);
    p.until({ advance: 1, fine: true }, (s) => s.wire.vessel === 'LAD', 30).hold({ rotate: 1 }, 0.5);
    p.until({ advance: 1 }, (s) => s.wire.s >= 78, 30);
    return p;
  }
  const smudges = (sim: Simulation): Line[] =>
    lines(frameOf(sim, sim.carmAngles, 80).dye, 'dye').filter((l) => l.width > 0 && l.alpha > 0 && l.alpha <= 0.6 + 1e-9 && Math.hypot(l.x2 - l.x1, l.y2 - l.y1) > 8 && Math.hypot(l.x2 - l.x1, l.y2 - l.y1) < 40);

  it('has no staining before the dye arrives, a smudge beside the tear once it has, and none for an intact vessel', () => {
    const p = tornCase();
    expect(p.sim.dissections).toHaveLength(1);
    expect(stainStrength(p.sim, 'LAD', LESION.centreS)).toBe(0);
    p.hold({ fluoro: true }, 0.1).do({ type: 'inject' }).hold({ fluoro: true }, 4);
    expect(stainStrength(p.sim, 'LAD', LESION.centreS)).toBeGreaterThan(0.3);
    expect(stainStrength(p.sim, 'LAD', 10)).toBeGreaterThan(0.3); // dye has reached there too, but only the tear gets a smudge
    const withTear = smudges(p.sim).length;
    const without = smudges({ ...p.sim, dissections: [] }).length;
    expect(withTear).toBeGreaterThan(without);
  });

  it('lingers while the dye in the lumen washes out', () => {
    const p = tornCase();
    p.hold({ fluoro: true }, 0.1).do({ type: 'inject' });
    const duration = p.sim.injection!.duration;
    p.until({ fluoro: true }, (s) => s.time - s.injection!.start > duration - 0.3, 30);
    expect(dyeAlpha(p.sim, 'LAD', 62)).toBeLessThan(0.2);
    expect(stainStrength(p.sim, 'LAD', LESION.centreS)).toBeGreaterThan(0.3);
  });

  it('is not drawn once a stent covers the tear', () => {
    const p = tornCase();
    expect(p.sim.dissections[0]!.sealed).toBe(false);
    expect(frameOf({ ...p.sim, dissections: [{ ...p.sim.dissections[0]!, sealed: true }] }, p.sim.carmAngles, 80).dye).toEqual([]);
  });
});

/** A case with the stent in and the guide still seated, ready for the final angiogram. */
function createSimulationWithStent(): Simulation {
  const p = playGoodCase({ oneFinalView: true });
  p.do({ type: 'select-tool', tool: 'guide' }).hold({ fluoro: true }, 0.1).do({ type: 'adjust-carm', laoDeg: 0, cranialDeg: 0 }).do({ type: 'inject' }).hold({ fluoro: true }, 3);
  return p.sim;
}
