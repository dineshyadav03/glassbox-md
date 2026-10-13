/**
 * C-arm geometry. The X-ray beam travels from the tube through the patient to the detector; the image
 * is a flat (orthographic) shadow of everything along that line. Pure maths, no DOM.
 *
 * World frame: x = patient's left, y = superior, z = anterior (as in the 3D scene), 1 unit = 1 mm.
 * The detector sits in front of the patient for AP (laoDeg 0, cranialDeg 0). Left anterior oblique
 * (LAO, positive) swings it toward the patient's left; cranial (positive) tilts the beam toward the head.
 * Images follow the usual display: the patient's left is on the right of the image, head at the top.
 */
import { CARM_PRESETS } from '../config/anatomy';
import { cross, dot, normalize, type Vec3 } from '../anatomy/vec3';

export interface CArmAngles {
  /** Positive = left anterior oblique (LAO), negative = right anterior oblique (RAO), degrees. */
  readonly laoDeg: number;
  /** Positive = cranial, negative = caudal, degrees. */
  readonly cranialDeg: number;
}

export interface ViewBasis {
  /** Unit direction of the beam, from the tube toward the detector. */
  readonly beam: Vec3;
  /** Unit vector along the image's horizontal axis (to the right of the picture). */
  readonly right: Vec3;
  /** Unit vector along the image's vertical axis (up in the picture). */
  readonly up: Vec3;
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Unit beam direction for a C-arm position. */
export function beamDirection(angles: CArmAngles): Vec3 {
  const lao = rad(angles.laoDeg);
  const cra = rad(angles.cranialDeg);
  return normalize([Math.sin(lao) * Math.cos(cra), Math.sin(cra), Math.cos(lao) * Math.cos(cra)]);
}

export function viewBasis(angles: CArmAngles): ViewBasis {
  const beam = beamDirection(angles);
  const right = normalize(cross([0, 1, 0], beam));
  const up = cross(beam, right);
  return { beam, right, up };
}

export interface ImagePoint {
  /** Pixels from the left of the image. */
  readonly x: number;
  /** Pixels from the top of the image. */
  readonly y: number;
  /** Distance along the beam from the image centre, mm (positive = nearer the detector). */
  readonly depth: number;
}

export interface Camera {
  readonly basis: ViewBasis;
  /** The point in the patient that lands in the middle of the image. */
  readonly centre: Vec3;
  /** Image scale, pixels per mm. */
  readonly pxPerMm: number;
  /** Image width and height in pixels. */
  readonly size: number;
}

export function makeCamera(angles: CArmAngles, centre: Vec3, fieldOfViewMm: number, size: number): Camera {
  return { basis: viewBasis(angles), centre, pxPerMm: size / Math.max(1, fieldOfViewMm), size };
}

export function project(camera: Camera, p: Vec3): ImagePoint {
  const d: Vec3 = [p[0] - camera.centre[0], p[1] - camera.centre[1], p[2] - camera.centre[2]];
  return {
    x: camera.size / 2 + dot(d, camera.basis.right) * camera.pxPerMm,
    y: camera.size / 2 - dot(d, camera.basis.up) * camera.pxPerMm,
    depth: dot(d, camera.basis.beam),
  };
}

/** The angle in degrees between two C-arm positions' beams (0 for the same view, 180 for opposite). */
export function viewSeparationDeg(a: CArmAngles, b: CArmAngles): number {
  const cosine = Math.min(1, Math.max(-1, dot(beamDirection(a), beamDirection(b))));
  return (Math.acos(cosine) * 180) / Math.PI;
}

/** "LAO 45 CRA 30", "RAO 30 CAU 25", "AP", using the named preset's own wording if the angles match one. */
export function carmLabel(angles: CArmAngles): string {
  const preset = CARM_PRESETS.find((p) => p.laoDeg === angles.laoDeg && p.cranialDeg === angles.cranialDeg);
  if (preset) return preset.label;
  const lao = Math.round(angles.laoDeg);
  const cra = Math.round(angles.cranialDeg);
  if (lao === 0 && cra === 0) return 'AP';
  const parts: string[] = [];
  if (lao !== 0) parts.push(`${lao > 0 ? 'LAO' : 'RAO'} ${Math.abs(lao)}`);
  else parts.push('AP');
  if (cra !== 0) parts.push(`${cra > 0 ? 'CRA' : 'CAU'} ${Math.abs(cra)}`);
  return parts.join(' ');
}
