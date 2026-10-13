/**
 * Pure helpers for drawing the devices: which route a wire follows through the branches, how much of a
 * tube to show, how contrast fills the vessels over time, how a dissection tints the wall, and where the
 * camera should look. No Three.js, so all of it is unit tested.
 */
import { AORTIC_ROOT_S, FLOW, LESION, VESSELS, pathOffsetOf, type VesselId } from '../config/anatomy';
import { anatomyPaths, routePosition, vesselPosition } from '../anatomy/centrelines';
import { Path } from '../anatomy/spline';
import type { Colour } from '../anatomy/tubeGeometry';
import type { Vec3 } from '../anatomy/vec3';
import type { Dissection } from '../physics/dissection';
import type { Simulation } from '../engine/simulation';

/** The vessels from the left main out to `vessel`, in order. */
export function chainTo(vessel: VesselId): VesselId[] {
  const chain: VesselId[] = [];
  let at: VesselId | null = vessel;
  while (at !== null) {
    chain.unshift(at);
    at = VESSELS[at].parent;
  }
  return chain;
}

/** The end vessels a wire can follow. The left main is drawn as part of the LAD route. */
export const WIRE_ROUTES: readonly VesselId[] = ['LAD', 'LCx', 'D1', 'D2'];

/** Which prebuilt route a wire in `vessel` is drawn along. */
export function routeFor(vessel: VesselId): VesselId {
  return vessel === 'LM' ? 'LAD' : vessel;
}

/** One continuous path from the left main ostium to the end of `vessel`, through each branch point. */
export function buildChainPath(vessel: VesselId): Path {
  const chain = chainTo(vessel);
  const points: Vec3[] = [];
  chain.forEach((id, i) => {
    const next = chain[i + 1];
    const path = anatomyPaths().vessels[id];
    const part = next === undefined ? path : path.slice(0, VESSELS[next].branchS);
    part.points.forEach((p, j) => {
      if (i > 0 && j === 0) return; // this point is where the previous vessel ended
      points.push(p);
    });
  });
  return new Path(points);
}

/** Distance along the route to `vessel`'s end that the wire tip has reached, mm. */
export function chainDistance(vessel: VesselId, s: number): number {
  return pathOffsetOf(vessel) + s;
}

/** How many rings of a tube (spaced `step` apart along `total` mm) are needed to show the first `shown` mm. */
export function ringsToShow(shown: number, step: number, total: number): number {
  const clamped = Math.min(total, Math.max(0, shown));
  const count = Math.floor(total / step) + 1;
  return Math.max(0, Math.min(count, Math.floor(clamped / step) + 1));
}

/** Index count to draw for that many rings of a tube with `radial` vertices per ring. */
export function indexCountFor(rings: number, radial: number): number {
  return Math.max(0, rings - 1) * radial * 6;
}

// --- contrast fill ----------------------------------------------------------------------------------

const smooth = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/**
 * How full of dye (0 to 1) a point of a vessel is `elapsed` seconds into a cine run: dark until the dye
 * arrives, full soon after, and washing out over the last seconds. Slow flow gives a fainter, later fill.
 */
export function dyeFill(
  arrival: readonly number[],
  factor: readonly number[],
  s: number,
  elapsed: number,
  duration: number,
): number {
  const index = Math.min(arrival.length - 1, Math.max(0, Math.round(s / FLOW.ringSpacing)));
  const reaches = arrival[index];
  if (reaches === undefined || !Number.isFinite(reaches)) return 0;
  const strength = Math.min(1, 0.35 + 0.65 * (factor[index] ?? 0));
  const ramp = smooth((elapsed - reaches) / 0.6);
  const wash = 1 - smooth((elapsed - (duration - FLOW.washoutSeconds)) / FLOW.washoutSeconds);
  return strength * ramp * wash;
}

export const DYE: Colour = [0.55, 0.85, 1.0];
export const FLAP: Colour = [0.25, 0.04, 0.12];

const mix = (a: Colour, b: Colour, t: number): Colour => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** How much a dissection at `at` darkens the wall at `s`: full within 1.5 mm, easing to nothing by 4 mm. */
export function flapWeight(at: number, s: number): number {
  return 1 - smooth((Math.abs(s - at) - 1.5) / 2.5);
}

/** The wall-colour function for the current state: dissections and any contrast run, over a vessel's base colour. */
export function overlayFor(
  sim: Simulation,
): ((id: VesselId, s: number, base: Colour) => Colour) | null {
  const dissections: readonly Dissection[] = sim.dissections;
  const injection = sim.injection;
  const result = injection && injection.selective ? injection.result : null;
  if (dissections.length === 0 && !result) return null;
  const elapsed = injection ? sim.time - injection.start : 0;
  return (id, s, base) => {
    let colour = base;
    for (const d of dissections) {
      if (d.vessel !== id) continue;
      const w = flapWeight(d.s, s);
      if (w > 0) colour = mix(colour, FLAP, (d.sealed ? 0.35 : 0.85) * w);
    }
    if (result && injection) {
      const fill = dyeFill(result.arrival[id] ?? [], result.factor[id] ?? [], s, elapsed, injection.duration);
      if (fill > 0) colour = mix(colour, DYE, 0.85 * fill);
    }
    return colour;
  };
}

/** A value that changes whenever `overlayFor`'s output would, so colours are refilled only when needed. */
export function overlayKey(sim: Simulation): string {
  const d = sim.dissections.map((x) => `${x.vessel}${x.s.toFixed(1)}${x.sealed ? 's' : 'u'}`).join(',');
  const i = sim.injection && sim.injection.selective ? `${sim.injection.start.toFixed(2)}@${Math.floor((sim.time - sim.injection.start) * 15)}` : '';
  return `${d}|${i}`;
}

// --- where to look -----------------------------------------------------------------------------------

/** The point the camera should follow: the tip of whatever the learner is moving. */
export function focusPoint(sim: Simulation): Vec3 {
  const tool = sim.tool;
  if (tool === 'wire' && sim.wire.outOfGuide && sim.wire.vessel !== null) return vesselPosition(sim.wire.vessel, sim.wire.s);
  if ((tool === 'balloon' || tool === 'stent') && sim.tool === tool) {
    const catheter = tool === 'balloon' ? sim.balloon : sim.stent;
    if (!catheter.inGuide && catheter.centreS !== null) return vesselPosition(LESION.vessel, catheter.centreS);
  }
  if (sim.guide.engaged) return vesselPosition('LM', 0);
  return routePosition(Math.min(sim.guide.s, AORTIC_ROOT_S));
}

/**
 * How far the camera should sit from what it follows, mm: far enough to see the arm while the guide
 * travels, close once it is in the heart, closest for the wire and the catheters in the artery.
 */
export function suggestedDistance(sim: Simulation): number {
  if (sim.tool === 'balloon' || sim.tool === 'stent') return 55;
  if (sim.tool === 'wire') return 65;
  if (sim.guide.engaged) return 120;
  if (sim.guide.s < 520) return 240;
  return 150;
}
