/**
 * The numbers the tool rules use. Every one is a teaching choice (listed in DESIGN-NOTES.md), not a clinical standard:
 * changing one here changes the rules, and the tests read these names rather than repeating the values.
 */
export const RULES = {
  /** Membrane segments must be cut in this order: the outer one first, because the deeper ones are reached through it. */
  arachnoidOrder: ['arach-lateral', 'arach-mid', 'arach-deep', 'arach-ica'] as readonly string[],
  /** How many of those open the fissure itself (the rest cover the carotid cistern). */
  fissureSegmentCount: 3,

  /** Blood the suction removes per second, in arbitrary "pool units". */
  suctionRate: 4,
  /** Seconds of bipolar on a bleeding point to seal it. */
  coagulateSeconds: 1,
  /** Seconds of bipolar on a vessel or nerve before it is injured. */
  thermalLimitSeconds: 2.5,

  /** How much one dissector stroke frees the aneurysm neck (0 to 1). */
  dissectorStep: 0.25,
  /** The fissure must be at least this open before the neck can be reached. */
  retractionNeededForNeck: 0.6,
  /** The neck must be at least this free before a clip can be applied. */
  neckFreedForClip: 0.75,

  /** Strain on the dome, 0 to 1; reaching 1 ruptures it. */
  domeStressRoughStroke: 0.3,
  domeStressSuctionPerSecond: 0.1,
  domeStressBipolarPerSecond: 0.5,
  ruptureStress: 1,

  /** Seconds a leak from an injured vessel takes to be sealed with bipolar if it is brisk (needs longer). */
  briskCoagulateSeconds: 3,

  /** Temporary occlusion: warn after this, and call it long after that (seconds). Used by the debrief later. */
  tempClipWarnSeconds: 180,
  tempClipLongSeconds: 300,
  /** Brain retraction: warn after this many seconds. */
  retractionWarnSeconds: 600,

  /** Bleeding, in millilitres per second. A rupture is fast; a temporary clip on the carotid slows every leak. */
  bleedOozeMlPerSecond: 0.03,
  bleedBriskMlPerSecond: 0.4,
  bleedRuptureMlPerSecond: 10,
  tempClipBleedFactor: 0.2,
  /** Pool units added per millilitre, the most the pool can hold, and the level at which it hides the field. */
  poolPerMl: 0.5,
  poolMax: 20,
  obstructedAtPool: 8,

  /** Vital signs: baseline, how far blood loss moves them, and the lines that raise an alarm. */
  vitals: {
    hr: 72,
    sbp: 118,
    dbp: 74,
    spo2: 99,
    hrRise: 60,
    sbpFall: 65,
    dbpFall: 35,
    spo2Fall: 9,
    /** Blood loss at which compensation fails (the fraction is loss divided by this). */
    hypovolaemiaMl: 1500,
    tauSeconds: 20,
    /** The MEP starts to fall after this long on the temporary clip, then falls and recovers at these rates (% per second). */
    mepGraceSeconds: 90,
    mepDropPerSecond: 0.25,
    mepRecoverPerSecond: 0.4,
    lowSbp: 90,
    lowSpo2: 92,
    lowMep: 80,
    highHr: 120,
  },

  /** Aneurysm clip limits. */
  clipAngleLimitDeg: 90,
  clipAngleStepDeg: 10,
  clipDepthStep: 0.1,
};
