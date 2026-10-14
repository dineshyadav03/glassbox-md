/**
 * What a tool is pointing at: from the name of the mesh the pointer hit (and where on it) to a `Target`, and a
 * plain-English name for a target. Pure, so the mapping can be tested without a renderer.
 */
import { ANATOMY } from '../config/anatomy';
import type { Target } from '../procedure/field';
import { aneurysmGeometry } from './aneurysm';
import type { NerveId, VesselId } from './vessels';
import { dot, sub, type Vec3 } from './vec3';

type Config = typeof ANATOMY;

const VESSELS: readonly VesselId[] = ['ica', 'm1', 'm2-upper', 'm2-lower', 'a1', 'pcom', 'achoa'];
const NERVES: readonly NerveId[] = ['optic', 'oculomotor'];

/** The half of the sac nearest the carotid counts as the neck (the camera mostly sees the sac from the side, so a thin neck would be hard to point at). */
export function neckZoneMm(config: Config = ANATOMY): number {
  return config.aneurysm.stalkMm + 0.45 * config.aneurysm.domeDiameterMm;
}

/** Map a hit on a named mesh, at a world point, to what the tools see. Unknown names (blades, backdrop) are nothing. */
export function classifyHit(name: string, point: Vec3, config: Config = ANATOMY): Target {
  if (name === 'frontal-lobe') return { kind: 'lobe', id: 'frontal' };
  if (name === 'temporal-lobe') return { kind: 'lobe', id: 'temporal' };
  if (config.arachnoid.segments.some((s) => s.id === name)) return { kind: 'arachnoid', id: name };
  if ((VESSELS as readonly string[]).includes(name)) return { kind: 'vessel', id: name as VesselId };
  if ((NERVES as readonly string[]).includes(name)) return { kind: 'nerve', id: name as NerveId };
  if (name === 'aneurysm-bleb') return { kind: 'aneurysm', part: 'bleb' };
  if (name === 'aneurysm-sac') {
    const g = aneurysmGeometry(config);
    const along = dot(sub(point, g.neckCentre), g.axis);
    return { kind: 'aneurysm', part: along <= neckZoneMm(config) ? 'neck' : 'dome' };
  }
  if (name.startsWith('ooze:')) return { kind: 'ooze', id: name.slice('ooze:'.length) };
  return { kind: 'none' };
}

const VESSEL_NAMES: Readonly<Record<VesselId, string>> = {
  ica: 'Internal carotid artery',
  m1: 'M1 (middle cerebral artery)',
  'm2-upper': 'M2, upper branch',
  'm2-lower': 'M2, lower branch',
  a1: 'A1 (anterior cerebral artery)',
  pcom: 'Posterior communicating artery',
  achoa: 'Anterior choroidal artery',
};

/** A short name for what is under the pointer, for the status line. */
export function describeTarget(target: Target): string {
  switch (target.kind) {
    case 'none':
      return '';
    case 'lobe':
      return target.id === 'frontal' ? 'Frontal lobe' : 'Temporal lobe';
    case 'arachnoid':
      return 'Arachnoid membrane';
    case 'vessel':
      return VESSEL_NAMES[target.id];
    case 'nerve':
      return target.id === 'optic' ? 'Optic nerve' : 'Oculomotor nerve';
    case 'aneurysm':
      return target.part === 'neck' ? 'Aneurysm neck' : target.part === 'bleb' ? 'Aneurysm bleb' : 'Aneurysm dome';
    case 'ooze':
      return 'Bleeding point';
  }
}

/** Where to draw a small leak: on the vessel's mid-point, or at the neck. */
export function oozeAnchor(on: VesselId | 'neck', config: Config = ANATOMY): Vec3 | null {
  if (on === 'neck') {
    const g = aneurysmGeometry(config);
    return [g.neckCentre[0] + g.axis[0] * 0.6, g.neckCentre[1] + g.axis[1] * 0.6, g.neckCentre[2] + g.axis[2] * 0.6];
  }
  return null; // vessels are positioned from their own path by the scene
}
