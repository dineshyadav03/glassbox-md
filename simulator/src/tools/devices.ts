/**
 * Balloon and stent catheters: sizing, the pressure-diameter curve, rupture, the
 * inflation log, stent deployment, and how well a device covers the lesion. Pure
 * functions over plain data (each returns a new object), so they can be unit tested
 * with no Three.js or DOM. Units: mm, atm, seconds.
 */
import {
  BALLOON,
  CATHETER,
  INFLATION,
  LESION,
  LESION_END,
  LESION_START,
  STENT,
  VESSELS,
  pathOffsetOf,
  type VesselId,
} from '../config/anatomy';
import type { Treatment } from '../physics/lesion';

export type CatheterKind = 'balloon' | 'stent';

export interface DeviceSpec {
  readonly kind: CatheterKind;
  /** Nominal diameter, mm. */
  readonly diameter: number;
  /** Working length, mm. */
  readonly length: number;
  readonly nominalAtm: number;
  readonly ratedBurstAtm: number;
  readonly compliancePerAtm: number;
  /** Above this the device ruptures. */
  readonly ruptureAtm: number;
}

/** A spec for a listed size, or null if that size does not exist. */
export function makeSpec(kind: CatheterKind, diameter: number, length: number): DeviceSpec | null {
  const table = kind === 'balloon' ? BALLOON : STENT;
  if (!(table.diameters as readonly number[]).includes(diameter)) return null;
  if (!(table.lengths as readonly number[]).includes(length)) return null;
  return {
    kind,
    diameter,
    length,
    nominalAtm: table.nominalAtm,
    ratedBurstAtm: table.ratedBurstAtm,
    compliancePerAtm: table.compliancePerAtm,
    ruptureAtm: table.ratedBurstAtm + table.ruptureMarginAtm,
  };
}

/**
 * Semi-compliant balloon: diameter = nominal * (1 + c * (P - nominalAtm)). Below the
 * unfolding pressure it is smaller, rising linearly from the folded profile.
 */
export function inflatedDiameter(spec: DeviceSpec, pressureAtm: number): number {
  const p = Math.max(0, pressureAtm);
  const curve = (atm: number) => spec.diameter * (1 + spec.compliancePerAtm * (atm - spec.nominalAtm));
  if (p >= INFLATION.unfoldAtm) return curve(p);
  const atUnfold = curve(INFLATION.unfoldAtm);
  return INFLATION.foldedDiameter + (atUnfold - INFLATION.foldedDiameter) * (p / INFLATION.unfoldAtm);
}

// --- catheter state ------------------------------------------------------------------------------

export interface InflationRecord {
  readonly peakAtm: number;
  /** Seconds spent at or above the inflated pressure. */
  readonly durationS: number;
  readonly vessel: VesselId | null;
  readonly centreS: number | null;
  /** Diameter reached at the peak pressure. */
  readonly achievedDiameter: number;
  readonly overRated: boolean;
  readonly ruptured: boolean;
}

interface OngoingInflation {
  readonly peakAtm: number;
  readonly elapsedS: number;
  readonly warnedOverRated: boolean;
}

export interface Catheter {
  readonly spec: DeviceSpec;
  /** In (or withdrawn into) the guide: size can be changed, it cannot be inflated. */
  readonly inGuide: boolean;
  readonly vessel: VesselId | null;
  /** Centre of the working length, arc position on `vessel`. */
  readonly centreS: number | null;
  readonly pressure: number;
  readonly ruptured: boolean;
  /** Stents only: the stent has been expanded in the vessel and is now permanent. */
  readonly deployed: boolean;
  readonly deployedAt: { readonly vessel: VesselId; readonly centreS: number } | null;
  /** Stents only: the largest the stent has been expanded to, mm. */
  readonly deployedDiameter: number | null;
  readonly current: OngoingInflation | null;
  readonly log: readonly InflationRecord[];
}

export function createCatheter(spec: DeviceSpec): Catheter {
  return {
    spec,
    inGuide: true,
    vessel: null,
    centreS: null,
    pressure: 0,
    ruptured: false,
    deployed: false,
    deployedAt: null,
    deployedDiameter: null,
    current: null,
    log: [],
  };
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

/** Change size. Only possible while the catheter is in the guide, and not once it is spent. */
export function chooseSize(catheter: Catheter, diameter: number, length: number): Result<Catheter> {
  if (!catheter.inGuide) return { ok: false, reason: 'Withdraw the catheter into the guide before changing its size.' };
  if (catheter.ruptured) return { ok: false, reason: 'This balloon has ruptured. Load a fresh one.' };
  if (catheter.deployed) return { ok: false, reason: 'This stent has been deployed. Load a fresh one.' };
  const spec = makeSpec(catheter.spec.kind, diameter, length);
  if (!spec) return { ok: false, reason: `No ${catheter.spec.kind} of ${diameter} x ${length} mm is stocked.` };
  return { ok: true, value: { ...catheter, spec } };
}

/** A fresh, unused catheter of the same size, back in the guide (after a rupture or a deployment). */
export function loadFresh(catheter: Catheter): Catheter {
  return createCatheter(catheter.spec);
}

export function isInflated(catheter: Catheter): boolean {
  return catheter.pressure >= INFLATION.inflatedAtm;
}

/** Why the catheter cannot move right now, or null if it can. */
export function moveBlockReason(catheter: Catheter): string | null {
  if (isInflated(catheter)) return 'Deflate it before moving it.';
  return null;
}

/** Put the catheter in the coronary at a position (it has left the guide). */
export function placeInPatient(catheter: Catheter, vessel: VesselId, centreS: number): Catheter {
  return { ...catheter, inGuide: false, vessel, centreS };
}

export function withdrawToGuide(catheter: Catheter): Result<Catheter> {
  if (isInflated(catheter)) return { ok: false, reason: 'Deflate it before withdrawing it.' };
  return { ok: true, value: { ...catheter, inGuide: true, vessel: null, centreS: null } };
}

export interface MoveOutcome {
  readonly catheter: Catheter;
  /** Set when the move was refused or cut short. */
  readonly blocked: string | null;
}

/**
 * Slide along the vessel by `deltaS`. It cannot move while inflated, and it must stay
 * behind the wire tip: pass the tip's position along the rail as `wireTipPathS`.
 */
export function moveCatheter(catheter: Catheter, deltaS: number, wireTipPathS?: number): MoveOutcome {
  const blocked = moveBlockReason(catheter);
  if (blocked) return { catheter, blocked };
  if (catheter.inGuide || catheter.vessel === null || catheter.centreS === null) {
    return { catheter, blocked: 'Advance it out of the guide first.' };
  }
  const half = catheter.spec.length / 2;
  let next = Math.min(VESSELS[catheter.vessel].length - half, Math.max(half, catheter.centreS + deltaS));
  let note: string | null = null;
  if (wireTipPathS !== undefined) {
    const furthestCentre = wireTipPathS - CATHETER.clearanceBehindWireMm - half - pathOffsetOf(catheter.vessel);
    if (next > furthestCentre) {
      next = Math.max(half, Math.min(next, furthestCentre));
      note = 'It must stay behind the wire tip.';
    }
  }
  return { catheter: { ...catheter, centreS: next }, blocked: note };
}

// --- inflation ----------------------------------------------------------------------------------

export interface InflationInput {
  readonly inflate: boolean;
  readonly deflate: boolean;
  readonly fine: boolean;
}

export type InflationEvent =
  | { readonly type: 'inflate-in-guide' }
  | { readonly type: 'over-rated'; readonly pressureAtm: number }
  | { readonly type: 'rupture'; readonly pressureAtm: number }
  | { readonly type: 'deployed' }
  | { readonly type: 'spent' };

function finishInflation(catheter: Catheter, ruptured: boolean): Catheter {
  const run = catheter.current;
  if (!run) return catheter;
  const record: InflationRecord = {
    peakAtm: run.peakAtm,
    durationS: run.elapsedS,
    vessel: catheter.vessel,
    centreS: catheter.centreS,
    achievedDiameter: inflatedDiameter(catheter.spec, run.peakAtm),
    overRated: run.peakAtm > catheter.spec.ratedBurstAtm,
    ruptured,
  };
  return { ...catheter, current: null, log: [...catheter.log, record] };
}

/** Advance the inflation by `dt` seconds. Returns the new catheter and what happened. */
export function stepInflation(
  catheter: Catheter,
  input: InflationInput,
  dt: number,
): { catheter: Catheter; events: InflationEvent[] } {
  const events: InflationEvent[] = [];
  if (catheter.ruptured) {
    if (input.inflate) events.push({ type: 'spent' });
    return { catheter, events };
  }
  if (input.inflate && catheter.inGuide && !input.deflate) {
    events.push({ type: 'inflate-in-guide' });
    return { catheter, events };
  }

  let pressure = catheter.pressure;
  if (input.deflate) {
    pressure = Math.max(0, pressure - INFLATION.deflateRateAtmPerS * dt);
  } else if (input.inflate) {
    const rate = input.fine ? INFLATION.fineInflateRateAtmPerS : INFLATION.inflateRateAtmPerS;
    pressure += rate * dt;
  }

  let next: Catheter = { ...catheter, pressure };

  if (pressure > catheter.spec.ruptureAtm) {
    // Record the run as it was at the moment it burst, then the balloon is spent.
    const burst: Catheter = {
      ...next,
      current: { peakAtm: pressure, elapsedS: (catheter.current?.elapsedS ?? 0) + dt, warnedOverRated: true },
    };
    events.push({ type: 'rupture', pressureAtm: pressure });
    return { catheter: { ...finishInflation(burst, true), pressure: 0, ruptured: true }, events };
  }

  if (pressure >= INFLATION.inflatedAtm) {
    const run = next.current ?? { peakAtm: pressure, elapsedS: 0, warnedOverRated: false };
    let warned = run.warnedOverRated;
    if (!warned && pressure > catheter.spec.ratedBurstAtm) {
      events.push({ type: 'over-rated', pressureAtm: pressure });
      warned = true;
    }
    next = { ...next, current: { peakAtm: Math.max(run.peakAtm, pressure), elapsedS: run.elapsedS + dt, warnedOverRated: warned } };
  } else if (next.current) {
    next = finishInflation(next, false);
  }

  if (
    next.spec.kind === 'stent' &&
    pressure >= STENT.deployAtm &&
    next.vessel !== null &&
    next.centreS !== null &&
    !next.inGuide
  ) {
    const diameter = inflatedDiameter(next.spec, pressure);
    if (!next.deployed) {
      events.push({ type: 'deployed' });
      next = {
        ...next,
        deployed: true,
        deployedAt: { vessel: next.vessel, centreS: next.centreS },
        deployedDiameter: diameter,
      };
    } else {
      next = { ...next, deployedDiameter: Math.max(next.deployedDiameter ?? 0, diameter) };
    }
  }

  return { catheter: next, events };
}

/** The longest single inflation so far, seconds (including one in progress). */
export function longestInflationS(catheter: Catheter): number {
  const finished = catheter.log.map((r) => r.durationS);
  return Math.max(0, catheter.current?.elapsedS ?? 0, ...finished);
}

// --- what the catheter does to the vessel ----------------------------------------------------------

/**
 * The treated segments this catheter has produced: every finished balloon inflation (the vessel
 * keeps what was achieved, less recoil), the inflation in progress, and a deployed stent.
 */
export function treatmentsFor(catheter: Catheter): Treatment[] {
  const out: Treatment[] = [];
  const { spec } = catheter;
  if (catheter.deployed && catheter.deployedAt && catheter.deployedDiameter !== null) {
    out.push({
      kind: 'stent',
      vessel: catheter.deployedAt.vessel,
      centreS: catheter.deployedAt.centreS,
      length: spec.length,
      diameter: catheter.deployedDiameter,
    });
    return out;
  }
  for (const record of catheter.log) {
    if (record.vessel === null || record.centreS === null) continue;
    out.push({ kind: 'balloon-done', vessel: record.vessel, centreS: record.centreS, length: spec.length, diameter: record.achievedDiameter });
  }
  if (isInflated(catheter) && !catheter.inGuide && catheter.vessel !== null && catheter.centreS !== null) {
    out.push({
      kind: 'balloon-live',
      vessel: catheter.vessel,
      centreS: catheter.centreS,
      length: spec.length,
      diameter: inflatedDiameter(spec, catheter.pressure),
    });
  }
  return out;
}

/** The live balloon, if this catheter is inflated in the vessel (used to post-dilate stents under it). */
export function liveBalloonOf(catheter: Catheter): Treatment | null {
  return treatmentsFor(catheter).find((t) => t.kind === 'balloon-live') ?? null;
}

/** Any inflation inside a deployed stent post-dilates it: a stent only ever grows to the larger diameter. */
export function postDilateStents(stents: readonly Treatment[], balloon: Treatment | null): Treatment[] {
  if (!balloon) return [...stents];
  return stents.map((stent) => {
    const overlaps =
      stent.kind === 'stent' &&
      stent.vessel === balloon.vessel &&
      Math.abs(stent.centreS - balloon.centreS) < (stent.length + balloon.length) / 2;
    return overlaps ? { ...stent, diameter: Math.max(stent.diameter, balloon.diameter) } : stent;
  });
}

// --- coverage of the lesion --------------------------------------------------------------------------

export interface Coverage {
  /** Lesion start minus device start: positive means the device reaches this far past the lesion's proximal end. */
  readonly proximalMarginMm: number;
  readonly distalMarginMm: number;
  /** Both ends of the lesion are inside the device. */
  readonly coversLesion: boolean;
  /** Fraction of the lesion length that overlaps the device. */
  readonly overlapFraction: number;
}

export function lesionCoverage(centreS: number, length: number): Coverage {
  const start = centreS - length / 2;
  const end = centreS + length / 2;
  const proximal = LESION_START - start;
  const distal = end - LESION_END;
  const overlap = Math.max(0, Math.min(end, LESION_END) - Math.max(start, LESION_START));
  return {
    proximalMarginMm: proximal,
    distalMarginMm: distal,
    coversLesion: proximal >= 0 && distal >= 0,
    overlapFraction: overlap / LESION.length,
  };
}

/** A balloon counts as across the lesion if it overlaps most of it and spans its middle. */
export function acrossLesion(centreS: number, length: number): boolean {
  const start = centreS - length / 2;
  const end = centreS + length / 2;
  return (
    lesionCoverage(centreS, length).overlapFraction >= CATHETER.acrossLesionFraction &&
    start <= LESION.centreS &&
    end >= LESION.centreS
  );
}
