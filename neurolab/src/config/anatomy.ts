/**
 * Every size, position and colour of the operative field, in one file. Change a number here and the scene,
 * the labels and the tests follow it (making the aneurysm 10 mm instead of 6.6 mm is a one-line edit).
 *
 * These are teaching choices: a simplified, schematic right-sided pterional, transsylvian view, not an atlas
 * and not measurements of any patient.
 *
 * World frame, 1 unit = 1 mm: the surgeon looks along -z into the field from z > 0.
 *   +x = screen right (lateral, toward the sylvian fissure's outer end), medial structures are at -x
 *   +y = up (superior), the frontal lobe is above the fissure and the temporal lobe below
 *   +z = toward the surgeon, so deeper structures have more negative z
 */
import type { Vec3 } from '../anatomy/vec3';

export interface LobeConfig {
  readonly centre: Vec3;
  readonly radii: Vec3;
  /** How far a lobe moves away from the fissure when it is fully opened (and retracted), mm. */
  readonly retractionMm: number;
}

export interface VesselConfig {
  readonly id: string;
  /** Hand-placed control points; the curve is smoothed through them. Listed in the direction of flow. */
  readonly controls: readonly Vec3[];
  /** Radius at the start and at the end of the vessel, mm (linear between). */
  readonly radiusStartMm: number;
  readonly radiusEndMm: number;
}

export const ANATOMY = {
  lobes: {
    frontal: { centre: [0, 46, -22], radii: [88, 42, 76], retractionMm: 12 } as LobeConfig,
    temporal: { centre: [4, -46, -22], radii: [88, 40, 76], retractionMm: 12 } as LobeConfig,
    /** Height and spacing of the gyri (folds), mm and mm. Purely visual. */
    gyriAmplitudeMm: 2.6,
    gyriWavelengthMm: 15,
  },

  /** The brain surface is covered by arachnoid membrane spanning the sylvian fissure, as separate cuttable segments. */
  arachnoid: {
    /** Segments across the fissure, front to back along z. Each is cut or intact. */
    segments: [
      { id: 'arach-lateral', position: [10, 0, -6], size: [38, 14] },
      { id: 'arach-mid', position: [2, 0, -22], size: [36, 14] },
      { id: 'arach-deep', position: [-6, 0, -36], size: [30, 14] },
      { id: 'arach-ica', position: [-8, -3, -50], size: [16, 12] },
    ] as readonly { id: string; position: Vec3; size: readonly [number, number] }[],
  },

  vessels: {
    ica: {
      id: 'ica',
      controls: [
        [-3, -36, -66],
        [-4, -22, -61],
        [-6, -10, -54],
        [-7, 2, -47],
      ],
      radiusStartMm: 2.4,
      radiusEndMm: 2.1,
    } as VesselConfig,
    m1: {
      id: 'm1',
      controls: [
        [-7, 2, -47],
        [2, 4, -44],
        [12, 6, -40],
        [24, 9, -35],
        [34, 12, -30],
      ],
      radiusStartMm: 1.6,
      radiusEndMm: 1.25,
    } as VesselConfig,
    m2Upper: {
      id: 'm2-upper',
      controls: [
        [34, 12, -30],
        [42, 19, -27],
        [51, 26, -26],
      ],
      radiusStartMm: 1.05,
      radiusEndMm: 0.9,
    } as VesselConfig,
    m2Lower: {
      id: 'm2-lower',
      controls: [
        [34, 12, -30],
        [42, 6, -26],
        [51, 0, -25],
      ],
      radiusStartMm: 1.05,
      radiusEndMm: 0.9,
    } as VesselConfig,
    a1: {
      id: 'a1',
      controls: [
        [-7, 2, -47],
        [-14, 6, -44],
        [-22, 9, -42],
        [-30, 12, -41],
      ],
      radiusStartMm: 1.3,
      radiusEndMm: 1.1,
    } as VesselConfig,
    /** Leaves the ICA at the aneurysm's junction and runs back; its first point is placed on the ICA by the code. */
    pcom: {
      id: 'pcom',
      controls: [
        [-6, -6, -51],
        [-10, -7, -58],
        [-13, -8, -67],
      ],
      radiusStartMm: 0.75,
      radiusEndMm: 0.65,
    } as VesselConfig,
    anteriorChoroidal: {
      id: 'achoa',
      controls: [
        [-6.2, -1, -50],
        [-2, -1.5, -56],
        [3, -2.5, -63],
      ],
      radiusStartMm: 0.5,
      radiusEndMm: 0.4,
    } as VesselConfig,
  },

  nerves: {
    optic: {
      id: 'optic',
      controls: [
        [-16, -3, -38],
        [-20, -5, -50],
        [-25, -6, -61],
      ],
      radiusStartMm: 2.3,
      radiusEndMm: 2.3,
    } as VesselConfig,
    oculomotor: {
      id: 'oculomotor',
      controls: [
        [-12, -17, -80],
        [-5, -18, -68],
        [2, -20, -57],
        [11, -22, -47],
      ],
      radiusStartMm: 0.8,
      radiusEndMm: 0.8,
    } as VesselConfig,
  },

  /** The aneurysm: arises on the ICA at the posterior communicating junction and points posterolaterally and down. */
  aneurysm: {
    domeDiameterMm: 6.6,
    neckWidthMm: 3.2,
    /** Short straight stalk between the vessel wall and the sac, mm. */
    stalkMm: 1.0,
    /** Unit-ish direction the sac points in (normalised by the code). */
    direction: [0.6, -0.5, -0.6] as Vec3,
    /** How far back along the ICA from its end (the bifurcation) the junction is, mm. */
    junctionBackMm: 8.5,
    bleb: { diameterMm: 1.9, offsetFromAxis: 0.55 },
  },

  spatulas: {
    widthMm: 7,
    lengthMm: 46,
    thicknessMm: 1,
  },

  /** Microscope: a narrow field of view, and limits so the learner cannot leave the field. */
  camera: {
    fovDeg: 22,
    position: [6, 4, 150] as Vec3,
    target: [-4, 0, -44] as Vec3,
    minDistanceMm: 60,
    maxDistanceMm: 230,
    /** Largest swing away from the straight-on view, degrees. */
    maxSwingDeg: 38,
  },
};

/** Colours (linear-ish RGB 0..1). */
export const COLOURS = {
  gyrus: [0.82, 0.55, 0.5],
  sulcus: [0.42, 0.2, 0.2],
  artery: [0.86, 0.22, 0.18],
  arteryWall: [0.9, 0.5, 0.42],
  aneurysm: [0.78, 0.2, 0.2],
  nerve: [0.93, 0.86, 0.66],
  backdrop: 0x14070a,
} as const;
