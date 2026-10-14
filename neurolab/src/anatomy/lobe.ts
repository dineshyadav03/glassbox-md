/**
 * A cerebral lobe as a folded ellipsoid: smooth, deterministic gyri and sulci from a few sine waves (no random
 * numbers, so the same config always gives the same brain). Returns plain arrays for Three.js. Pure maths.
 */
import { ANATOMY, COLOURS, type LobeConfig } from '../config/anatomy';
import type { Vec3 } from './vec3';

export interface LobeMesh {
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  readonly indices: Uint32Array;
}

/** Fold height at a point, -1 (deep in a sulcus) to 1 (crown of a gyrus). */
export function gyralHeight(p: Vec3, wavelengthMm: number): number {
  const k = (2 * Math.PI) / wavelengthMm;
  const [x, y, z] = p;
  const a = Math.sin(k * x + 1.3 * Math.sin(k * 0.7 * z + 0.4)) * Math.sin(k * 1.1 * y + 0.7);
  const b = 0.6 * Math.sin(k * 0.9 * z + 2 * Math.sin(k * 0.5 * x + 1.1));
  const raw = Math.max(-1, Math.min(1, (a + b) / 1.4));
  // Flatter crowns and narrower, deeper sulci than a plain sine.
  return Math.sign(raw) * Math.pow(Math.abs(raw), 0.75);
}

const RINGS = 72;
const AROUND = 108;

export function buildLobe(lobe: LobeConfig, amplitudeMm: number = ANATOMY.lobes.gyriAmplitudeMm, wavelengthMm: number = ANATOMY.lobes.gyriWavelengthMm): LobeMesh {
  const positions: number[] = [];
  const colors: number[] = [];
  const [cx, cy, cz] = lobe.centre;
  const [rx, ry, rz] = lobe.radii;
  for (let i = 0; i <= RINGS; i++) {
    const polar = (Math.PI * i) / RINGS;
    for (let j = 0; j <= AROUND; j++) {
      // The seam of the wrap-around sits at the back (-z), where the camera never looks.
      const azimuth = (2 * Math.PI * j) / AROUND - Math.PI / 2;
      const d: Vec3 = [Math.sin(polar) * Math.cos(azimuth), Math.cos(polar), Math.sin(polar) * Math.sin(azimuth)];
      const base: Vec3 = [cx + rx * d[0], cy + ry * d[1], cz + rz * d[2]];
      const h = gyralHeight(base, wavelengthMm);
      // Push along the ellipsoid's own normal direction (the unit direction is close enough and stays smooth).
      positions.push(base[0] + d[0] * amplitudeMm * h, base[1] + d[1] * amplitudeMm * h, base[2] + d[2] * amplitudeMm * h);
      const t = (h + 1) / 2;
      colors.push(
        COLOURS.sulcus[0] + (COLOURS.gyrus[0] - COLOURS.sulcus[0]) * t,
        COLOURS.sulcus[1] + (COLOURS.gyrus[1] - COLOURS.sulcus[1]) * t,
        COLOURS.sulcus[2] + (COLOURS.gyrus[2] - COLOURS.sulcus[2]) * t,
      );
    }
  }
  const indices: number[] = [];
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < AROUND; j++) {
      const a = i * (AROUND + 1) + j;
      const b = a + 1;
      const c = a + AROUND + 1;
      const e = c + 1;
      indices.push(a, b, c, b, e, c);
    }
  }
  return { positions: new Float32Array(positions), colors: new Float32Array(colors), indices: new Uint32Array(indices) };
}

/** Height of a lobe's surface along y at a given x, z (for tests and for placing things on it). Ignores the folds. */
export function lobeSurfaceY(lobe: LobeConfig, x: number, z: number, side: 'bottom' | 'top'): number | null {
  const nx = (x - lobe.centre[0]) / lobe.radii[0];
  const nz = (z - lobe.centre[2]) / lobe.radii[2];
  const inside = 1 - nx * nx - nz * nz;
  if (inside < 0) return null;
  const half = lobe.radii[1] * Math.sqrt(inside);
  return lobe.centre[1] + (side === 'top' ? half : -half);
}
