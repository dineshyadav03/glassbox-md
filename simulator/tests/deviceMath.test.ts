import { describe, expect, it } from 'vitest';
import {
  FLAP,
  WIRE_ROUTES,
  buildChainPath,
  chainDistance,
  chainTo,
  dyeFill,
  flapWeight,
  focusPoint,
  indexCountFor,
  overlayFor,
  overlayKey,
  ringsToShow,
  routeFor,
} from '../src/scene/deviceMath';
import { anatomyPaths, vesselPosition } from '../src/anatomy/centrelines';
import { VESSELS, pathOffsetOf } from '../src/config/anatomy';
import { distance } from '../src/anatomy/vec3';
import { createSimulation } from '../src/engine/simulation';
import { Player, playGoodCase } from './helpers/player';

describe('wire routes', () => {
  it('lists the vessels from the left main out to each end vessel', () => {
    expect(chainTo('LM')).toEqual(['LM']);
    expect(chainTo('LAD')).toEqual(['LM', 'LAD']);
    expect(chainTo('D2')).toEqual(['LM', 'LAD', 'D2']);
    expect(chainTo('LCx')).toEqual(['LM', 'LCx']);
  });

  it('draws the left main along the LAD route and the others on their own', () => {
    expect(routeFor('LM')).toBe('LAD');
    expect(routeFor('D1')).toBe('D1');
    expect(WIRE_ROUTES).toEqual(['LAD', 'LCx', 'D1', 'D2']);
  });

  it.each(WIRE_ROUTES)('the route to %s is as long as the rail the rules use, and joins smoothly at each branch', (id) => {
    const path = buildChainPath(id);
    expect(path.length).toBeCloseTo(pathOffsetOf(id) + VESSELS[id].length, 4);
    // Every point of the route is a point of some vessel on it: no jumps at the joins.
    let longest = 0;
    for (let i = 1; i < path.points.length; i++) longest = Math.max(longest, distance(path.points[i]!, path.points[i - 1]!));
    expect(longest).toBeLessThan(2);
  });

  it('puts the wire tip, by rail distance, at the same place the vessel centreline says', () => {
    const path = buildChainPath('D1');
    for (const s of [0, 10, 25]) {
      expect(distance(path.positionAt(chainDistance('D1', s)), vesselPosition('D1', s))).toBeLessThan(0.05);
    }
    const lad = buildChainPath('LAD');
    expect(distance(lad.positionAt(chainDistance('LAD', 48)), vesselPosition('LAD', 48))).toBeLessThan(0.05);
    expect(distance(lad.positionAt(chainDistance('LM', 6)), vesselPosition('LM', 6))).toBeLessThan(0.05);
  });
});

describe('showing part of a tube', () => {
  it('counts rings for a length shown, clamped to the tube', () => {
    expect(ringsToShow(0, 1, 10)).toBe(1);
    expect(ringsToShow(5.5, 1, 10)).toBe(6);
    expect(ringsToShow(99, 1, 10)).toBe(11);
    expect(ringsToShow(-4, 1, 10)).toBe(1);
  });

  it('turns rings into an index count, and shows nothing for fewer than two rings', () => {
    expect(indexCountFor(1, 8)).toBe(0);
    expect(indexCountFor(3, 8)).toBe(2 * 8 * 6);
    expect(indexCountFor(0, 8)).toBe(0);
  });
});

describe('contrast fill', () => {
  const arrival = [0, 0.5, 1, 1.5, 2];
  const factor = [1, 1, 1, 1, 1];

  it('is empty before the dye arrives, full soon after, and washes out at the end', () => {
    expect(dyeFill(arrival, factor, 8, 1, 10)).toBe(0); // ring 4 arrives at 2 s
    expect(dyeFill(arrival, factor, 8, 3, 10)).toBeCloseTo(1, 2);
    expect(dyeFill(arrival, factor, 8, 10, 10)).toBeCloseTo(0, 2);
    expect(dyeFill(arrival, factor, 8, 9, 10)).toBeGreaterThan(0);
    expect(dyeFill(arrival, factor, 8, 9, 10)).toBeLessThan(1);
  });

  it('never fills a ring the dye never reaches', () => {
    expect(dyeFill([0, Infinity], [1, 0], 2, 5, 10)).toBe(0);
  });

  it('is fainter where flow is slow', () => {
    const slow = dyeFill(arrival, [1, 1, 1, 1, 0.3], 8, 3, 10);
    expect(slow).toBeLessThan(dyeFill(arrival, factor, 8, 3, 10));
    expect(slow).toBeGreaterThan(0);
  });
});

describe('dissection tint', () => {
  it('is full at the tear and gone a few mm away', () => {
    expect(flapWeight(48, 48)).toBe(1);
    expect(flapWeight(48, 49.5)).toBe(1);
    expect(flapWeight(48, 60)).toBe(0);
    expect(flapWeight(48, 51)).toBeGreaterThan(0);
    expect(flapWeight(48, 51)).toBeLessThan(1);
  });
});

describe('the wall overlay', () => {
  it('is absent for a fresh case, and key-stable', () => {
    const sim = createSimulation();
    expect(overlayFor(sim)).toBeNull();
    expect(overlayKey(sim)).toBe(overlayKey(createSimulation()));
  });

  it('darkens the wall at a wire dissection and leaves other vessels alone', () => {
    const p = new Player(() => 0);
    p.hold({ rotate: 1 }, 1).until({ advance: 1 }, (s) => s.guide.s >= 829.9);
    p.until({ advance: 1, fine: true }, (s) => s.guide.engaged, 20).angiogram().do({ type: 'heparin' });
    p.do({ type: 'select-tool', tool: 'wire' }).hold({ rotate: -1 }, 0.5);
    p.until({ advance: 1, fine: true }, (s) => s.wire.vessel === 'LAD', 30).hold({ rotate: 1 }, 0.5);
    p.until({ advance: 1 }, (s) => s.wire.s >= 78, 30);
    const overlay = overlayFor(p.sim)!;
    const base = [0.8, 0.1, 0.1] as const;
    const at = overlay('LAD', 48, base);
    expect(at[0]).toBeLessThan(base[0]);
    expect(overlay('LAD', 90, base)).toEqual(base);
    expect(overlay('RCA', 48, base)).toEqual(base);
    expect(FLAP[0]).toBeLessThan(base[0]);
    expect(overlayKey(p.sim)).toMatch(/LAD/);
  });

  it('colours the filled vessels bluish during a selective injection', () => {
    const p = playGoodCase({ stopAfterWire: true });
    p.hold({ fluoro: true }, 0.1).do({ type: 'inject' }).hold({}, 3);
    const overlay = overlayFor(p.sim)!;
    const base = [0.8, 0.1, 0.1] as const;
    const filled = overlay('LM', 3, base);
    expect(filled[2]).toBeGreaterThan(base[2]);
  });
});

describe('where the camera looks', () => {
  it('follows the guide along the route, then the left main once seated', () => {
    const p = new Player().until({ advance: 1 }, (s) => s.guide.s >= 100);
    expect(distance(focusPoint(p.sim), anatomyPaths().route.positionAt(p.sim.guide.s))).toBeLessThan(1e-6);
    const seated = playGoodCase({ stopAfterWire: true });
    seated.do({ type: 'select-tool', tool: 'guide' });
    expect(distance(focusPoint(seated.sim), vesselPosition('LM', 0))).toBeLessThan(1e-6);
  });

  it('follows the wire tip and the catheter once they are the selected tool', () => {
    const p = playGoodCase({ stopAfterWire: true });
    p.do({ type: 'select-tool', tool: 'wire' });
    expect(distance(focusPoint(p.sim), vesselPosition('LAD', p.sim.wire.s))).toBeLessThan(1e-6);
    p.do({ type: 'select-tool', tool: 'balloon' }).hold({ advance: 1 }, 1);
    expect(distance(focusPoint(p.sim), vesselPosition('LAD', p.sim.balloon.centreS!))).toBeLessThan(1e-6);
  });
});
