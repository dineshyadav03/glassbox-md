import { describe, expect, it } from 'vitest';
import {
  AORTIC_ROOT,
  CORONARY_LIFT,
  ROUTE_LENGTH,
  anatomyPaths,
  aortaRadiusAt,
  routeDiameterAt,
  routePosition,
  vesselDirection,
  vesselPosition,
} from '../src/anatomy/centrelines';
import { heartField } from '../src/anatomy/heartShape';
import { AORTA_ENTRY_S, ELBOW_S, LESION_END, LESION_START, ROUTE_SEGMENTS, VESSELS, VESSEL_ORDER } from '../src/config/anatomy';
import { distance, length } from '../src/anatomy/vec3';

const { vessels, naturalLengths, route, routeNaturalLength, aorta } = anatomyPaths();

describe('coronary centrelines', () => {
  it.each(VESSEL_ORDER)('%s is exactly as long as its configured length', (id) => {
    expect(vessels[id].length).toBeCloseTo(VESSELS[id].length, 6);
  });

  it.each(VESSEL_ORDER)('%s needs no more than a modest stretch or trim to reach its length', (id) => {
    // If the hand-placed course were far off the configured length, the cut or straight extension would show.
    const ratio = naturalLengths[id] / VESSELS[id].length;
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.4);
  });

  it('starts a branch exactly where its parent is at the branch point', () => {
    for (const id of VESSEL_ORDER) {
      const spec = VESSELS[id];
      if (spec.parent === null) continue;
      const parentPoint = vessels[spec.parent].positionAt(spec.branchS);
      expect(distance(vessels[id].positionAt(0), parentPoint)).toBeLessThan(1e-9);
    }
  });

  it('keeps the left main and right coronary starting at the aortic root, not floating away from it', () => {
    expect(distance(vesselPosition('LM', 0), AORTIC_ROOT)).toBeLessThan(25);
    expect(distance(vesselPosition('RCA', 0), AORTIC_ROOT)).toBeLessThan(25);
  });

  it('lies on the heart surface once past the ostium (within a mm or so of the lift)', () => {
    for (const id of ['LAD', 'LCx', 'D1', 'D2'] as const) {
      const path = vessels[id];
      // Compare with the surface by its implicit field: on the surface it is 1, so near-1 means close to it.
      for (let s = 2; s < path.length - 2; s += 3) {
        const field = heartField(path.positionAt(s));
        expect(field).toBeGreaterThan(0.9);
        expect(field).toBeLessThan(1.25);
      }
    }
    expect(CORONARY_LIFT).toBeGreaterThan(0);
  });

  it('puts the lesion on the front of the heart, in the left anterior descending artery', () => {
    const middle = vesselPosition('LAD', (LESION_START + LESION_END) / 2);
    expect(middle[2]).toBeGreaterThan(15);
  });

  it('runs the LAD from the base toward the apex (downward) and the diagonals off it to the left', () => {
    expect(vesselPosition('LAD', 100)[1]).toBeLessThan(vesselPosition('LAD', 5)[1] - 40);
    expect(vesselPosition('D1', 50)[0]).toBeGreaterThan(vesselPosition('LAD', 30)[0]);
  });

  it('does not double back on itself: positions along each vessel keep moving', () => {
    for (const id of VESSEL_ORDER) {
      const path = vessels[id];
      for (let s = 0; s + 5 <= path.length; s += 5) {
        expect(distance(path.positionAt(s), path.positionAt(s + 5))).toBeGreaterThan(2.5);
      }
    }
  });

  it('gives a unit direction of travel', () => {
    for (const id of VESSEL_ORDER) expect(length(vesselDirection(id, VESSELS[id].length / 2))).toBeCloseTo(1, 6);
  });

  it('keeps the two diagonals apart on the LAD', () => {
    expect(distance(vesselPosition('D1', 0), vesselPosition('D2', 0))).toBeGreaterThan(20);
  });
});

describe('access route', () => {
  it('is exactly the configured wrist-to-root length', () => {
    expect(route.length).toBeCloseTo(ROUTE_LENGTH, 6);
    expect(ROUTE_LENGTH).toBe(830);
  });

  it('needs only a small trim or extension to reach that length', () => {
    const ratio = routeNaturalLength / ROUTE_LENGTH;
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.25);
  });

  it('ends at the aortic root and starts at the right wrist, below and to the patient right', () => {
    expect(distance(routePosition(ROUTE_LENGTH), AORTIC_ROOT)).toBeLessThan(1e-6);
    const wrist = routePosition(0);
    expect(wrist[0]).toBeLessThan(-150);
    expect(wrist[1]).toBeLessThan(-250);
  });

  it('climbs from the wrist toward the heart', () => {
    expect(routePosition(ELBOW_S)[1]).toBeGreaterThan(routePosition(0)[1]);
    expect(routePosition(AORTA_ENTRY_S)[1]).toBeGreaterThan(routePosition(ELBOW_S)[1]);
  });

  it('has a true diameter that grows from wrist to aorta', () => {
    const radial = routeDiameterAt(100);
    const brachial = routeDiameterAt(400);
    const subclavian = routeDiameterAt(AORTA_ENTRY_S - 60);
    const aortaD = routeDiameterAt(AORTA_ENTRY_S + 50);
    expect(radial).toBeGreaterThan(2);
    expect(radial).toBeLessThan(3.5);
    expect(brachial).toBeGreaterThan(radial);
    expect(subclavian).toBeGreaterThan(brachial);
    expect(aortaD).toBeGreaterThan(subclavian);
  });

  it('changes diameter smoothly across segment boundaries', () => {
    let previous = routeDiameterAt(0);
    for (let s = 0.5; s <= ROUTE_LENGTH; s += 0.5) {
      const d = routeDiameterAt(s);
      expect(Math.abs(d - previous)).toBeLessThan(1.5);
      previous = d;
    }
  });

  it('has one diameter entry per access segment', () => {
    expect(ROUTE_SEGMENTS.length).toBe(6);
    for (const seg of ROUTE_SEGMENTS) {
      expect(routeDiameterAt(0) > 0).toBe(true);
      expect(seg.length).toBeGreaterThan(0);
    }
  });
});

describe('aorta', () => {
  it('starts at the root and is wider than any access artery', () => {
    expect(distance(aorta.positionAt(0), AORTIC_ROOT)).toBeLessThan(1e-9);
    expect(aortaRadiusAt(0, aorta.length) * 2).toBeGreaterThan(routeDiameterAt(AORTA_ENTRY_S - 50));
  });

  it('is widest at the sinuses and narrows downstream', () => {
    expect(aortaRadiusAt(0, aorta.length)).toBeGreaterThan(aortaRadiusAt(60, aorta.length));
    expect(aortaRadiusAt(60, aorta.length)).toBeGreaterThan(aortaRadiusAt(aorta.length, aorta.length));
    expect(aortaRadiusAt(aorta.length, aorta.length)).toBeGreaterThan(8);
  });

  it('rises to an arch, then descends behind the heart', () => {
    const top = Math.max(...aorta.points.map((p) => p[1]));
    expect(top).toBeGreaterThan(110);
    const end = aorta.positionAt(aorta.length);
    expect(end[1]).toBeLessThan(0);
    expect(end[2]).toBeLessThan(-40);
  });
});
