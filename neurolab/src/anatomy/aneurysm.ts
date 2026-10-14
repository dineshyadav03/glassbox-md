/**
 * The aneurysm as geometry: a sac on a short stalk that leaves the ICA at the posterior communicating junction,
 * plus a small bleb on the dome. Sizes come from `config.aneurysm`, so the 6.6 mm dome is one number. Pure maths.
 */
import { ANATOMY } from '../config/anatomy';
import { icaPointBack } from './vessels';
import { Path } from './spline';
import { add, normalize, scale, cross, anyPerpendicular, type Vec3 } from './vec3';

type Config = typeof ANATOMY;

export interface AneurysmGeometry {
  /** Unit direction the sac points in. */
  readonly axis: Vec3;
  /** Where the neck meets the ICA surface. */
  readonly neckCentre: Vec3;
  /** The sac's own path, starting a little inside the vessel wall, and its radius at a distance along it. */
  readonly path: Path;
  radiusAt(s: number): number;
  /** How far inside the vessel wall the path begins, mm. */
  readonly insideMm: number;
  readonly neckRadius: number;
  readonly domeRadius: number;
  /** Centre of the round part of the sac. */
  readonly domeCentre: Vec3;
  /** Distance from the neck to the dome's far side, mm. */
  readonly heightMm: number;
  readonly bleb: { readonly centre: Vec3; readonly radius: number };
}

const INSIDE_MM = 0.8;

export function aneurysmGeometry(config: Config = ANATOMY): AneurysmGeometry {
  const a = config.aneurysm;
  const axis = normalize(a.direction);
  const ica = icaPointBack(config, a.junctionBackMm);
  const neckCentre = add(ica.point, scale(axis, ica.radius));
  const domeRadius = a.domeDiameterMm / 2;
  const neckRadius = Math.min(a.neckWidthMm / 2, domeRadius);
  const stalk = a.stalkMm;
  const height = stalk + a.domeDiameterMm;
  const start = add(neckCentre, scale(axis, -INSIDE_MM));
  const end = add(neckCentre, scale(axis, height));
  const centreU = stalk + domeRadius;

  // u = distance from the neck. Inside the vessel and along the stalk the radius is the neck's; then the sac's
  // sphere, with a cone from the neck up to it so the shoulder is smooth.
  const radiusAtU = (u: number): number => {
    const sphere = Math.sqrt(Math.max(0, domeRadius * domeRadius - (u - centreU) * (u - centreU)));
    const neck = u <= stalk ? neckRadius : Math.max(0, neckRadius * (1 - (u - stalk) / domeRadius));
    return u >= centreU + domeRadius ? 0 : Math.max(sphere, neck);
  };

  const domeCentre = add(neckCentre, scale(axis, centreU));
  const side = normalize(cross(axis, anyPerpendicular(axis)));
  const blebDirection = normalize(add(scale(axis, 0.8), scale(side, a.bleb.offsetFromAxis)));
  const blebRadius = a.bleb.diameterMm / 2;
  return {
    axis,
    neckCentre,
    path: new Path([start, end]),
    radiusAt: (s) => radiusAtU(s - INSIDE_MM),
    insideMm: INSIDE_MM,
    neckRadius,
    domeRadius,
    domeCentre,
    heightMm: height,
    bleb: { centre: add(domeCentre, scale(blebDirection, domeRadius + blebRadius * 0.15)), radius: blebRadius },
  };
}
