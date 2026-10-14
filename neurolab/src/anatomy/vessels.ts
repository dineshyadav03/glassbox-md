/**
 * The arteries and nerves of the field as smooth paths with radii, built from the config. Pure maths (no Three.js),
 * so connections and sizes can be tested. Branches start exactly on the vessel they leave: the code replaces each
 * branch's first control point with the parent point, so a config edit to the ICA moves everything attached to it.
 */
import { ANATOMY, type VesselConfig } from '../config/anatomy';
import { Path, smoothPath } from './spline';
import type { Vec3 } from './vec3';

export type VesselId = 'ica' | 'm1' | 'm2-upper' | 'm2-lower' | 'a1' | 'pcom' | 'achoa';
export type NerveId = 'optic' | 'oculomotor';

export interface Tube {
  readonly id: string;
  readonly path: Path;
  /** Radius in mm at a distance s along the path. */
  radiusAt(s: number): number;
}

type Config = typeof ANATOMY;

function tube(config: VesselConfig, controls: readonly Vec3[]): Tube {
  const path = smoothPath(controls, 22);
  const { radiusStartMm: a, radiusEndMm: b } = config;
  return { id: config.id, path, radiusAt: (s) => a + (b - a) * Math.min(1, Math.max(0, s / path.length)) };
}

/** The ICA's centreline point `back` mm before its end (the bifurcation), and the ICA's radius there. */
export function icaPointBack(config: Config, back: number): { point: Vec3; radius: number; tangent: Vec3 } {
  const ica = tube(config.vessels.ica, config.vessels.ica.controls);
  const s = Math.max(0, ica.path.length - back);
  return { point: ica.path.positionAt(s), radius: ica.radiusAt(s), tangent: ica.path.tangentAt(s) };
}

export function buildVessels(config: Config = ANATOMY): Readonly<Record<VesselId, Tube>> {
  const v = config.vessels;
  const ica = tube(v.ica, v.ica.controls);
  const end = (t: Tube): Vec3 => t.path.positionAt(t.path.length);
  const from = (cfg: VesselConfig, start: Vec3): Tube => tube(cfg, [start, ...cfg.controls.slice(1)]);

  const m1 = from(v.m1, end(ica));
  const m1End = end(m1);
  return {
    ica,
    m1,
    'm2-upper': from(v.m2Upper, m1End),
    'm2-lower': from(v.m2Lower, m1End),
    a1: from(v.a1, end(ica)),
    pcom: from(v.pcom, icaPointBack(config, config.aneurysm.junctionBackMm).point),
    // Distal to the posterior communicating artery, as it is in life.
    achoa: from(v.anteriorChoroidal, icaPointBack(config, Math.max(0.5, config.aneurysm.junctionBackMm - 3.5)).point),
  };
}

export function buildNerves(config: Config = ANATOMY): Readonly<Record<NerveId, Tube>> {
  return { optic: tube(config.nerves.optic, config.nerves.optic.controls), oculomotor: tube(config.nerves.oculomotor, config.nerves.oculomotor.controls) };
}
