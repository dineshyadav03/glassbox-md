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

  /** Aneurysm clip limits. */
  clipAngleLimitDeg: 90,
  clipAngleStepDeg: 10,
  clipDepthStep: 0.1,
};
