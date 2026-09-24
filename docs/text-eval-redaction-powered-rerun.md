# DATE_TIME redaction: powered rerun (5 repeats per arm)

> Educational project, not clinical validation. Local MedGemma 1.5 (`medgemma1.5:4b`), the same 32 synthetic text cases in every run, redaction on (the app as it is) vs off (a process-local monkeypatch in a throwaway script; no repo code changed). Repeats alternated redacted / unredacted. Rule fixed before running: commit `c566333`.

## Accuracy per repeat (correct out of 32)

| Repeat | Redacted | Unredacted |
|---|---|---|
| 1 | 22 | 24 |
| 2 | 20 | 26 |
| 3 | 20 | 26 |
| 4 | 22 | 26 |
| 5 | 20 | 27 |

| | Redacted | Unredacted |
|---|---|---|
| Mean | 20.8 (65.0%) | 25.8 (80.6%) |
| SD across repeats | 1.10 | 1.10 |
| Range | 20-22 | 24-27 |
| Errored / unanswered cases (counted as wrong) | 0 | 0 |
| Invalid model answers (retried) | 1 | 0 |

## Verdict against the pre-registered rule

Rule: implement A+B only if **(1)** every unredacted repeat beats every redacted repeat (`min(unredacted) > max(redacted)`) **and (2)** an exact permutation test over all 252 splits of the 10 repeat accuracies gives two-sided p < 0.05 on the difference in means.

- (1) Non-overlap: min(unredacted) = 24, max(redacted) = 22 -> **met**.
- (2) Difference in means (unredacted - redacted) = +5.00 cases (+15.6 points); exact permutation p = 0.008 two-sided (0.004 one-sided) -> **met**.

**Result: the rule is MET: unredacted wins consistently beyond the run-to-run spread.**

## Per group (correct per repeat, mean)

| Group | Cases | Redacted per repeat | mean | Unredacted per repeat | mean |
|---|---|---|---|---|---|
| single | 24 | [17, 16, 16, 18, 15] | 16.40 | [18, 20, 19, 19, 20] | 19.20 |
| comorbid | 4 | [4, 3, 3, 3, 4] | 3.40 | [3, 3, 4, 4, 4] | 3.60 |
| control | 4 | [1, 1, 1, 1, 1] | 1.00 | [3, 3, 3, 3, 3] | 3.00 |

## Mechanism watch: the normal-panel controls

Hypothesis from the single-run ablation (1/4 correct redacted vs 3/4 unredacted): garbled `<DATE_TIME> with <DATE_TIME>` text prompts the model to name a condition on a clean panel. Correct = top-1 names no target condition. Times right out of 5 repeats:

| Control case | Redacted | Unredacted |
|---|---|---|
| ctl-1 | 0/5 | 5/5 |
| ctl-2 | 1/5 | 5/5 |
| ctl-3 | 0/5 | 0/5 |
| ctl-4 | 4/5 | 5/5 |
| **all controls** | **5/20** | **15/20** |

## Per case, correct out of 5 repeats

| Case | Group | Expected | Redacted | Unredacted |
|---|---|---|---|---|
| t2d-1 | single | type_2_diabetes | 5/5 | 5/5 |
| t2d-2 | single | type_2_diabetes | 5/5 | 5/5 |
| t2d-3 | single | type_2_diabetes | 5/5 | 5/5 |
| t2d-4 | single | type_2_diabetes | 5/5 | 5/5 |
| cad-1 | single | coronary_artery_disease | 2/5 | 1/5 |
| cad-2 | single | coronary_artery_disease | 3/5 | 5/5 |
| cad-3 | single | coronary_artery_disease | 0/5 | 1/5 |
| cad-4 | single | coronary_artery_disease | 2/5 | 4/5 |
| lip-1 | single | hyperlipidemia | 5/5 | 5/5 |
| lip-2 | single | hyperlipidemia | 3/5 | 5/5 |
| lip-3 | single | hyperlipidemia | 5/5 | 5/5 |
| lip-4 | single | hyperlipidemia | 5/5 | 5/5 |
| htn-1 | single | hypertension | 0/5 | 5/5 |
| htn-2 | single | hypertension | 0/5 | 0/5 |
| htn-3 | single | hypertension | 5/5 | 5/5 |
| htn-4 | single | hypertension | 1/5 | 0/5 |
| ckd-1 | single | chronic_kidney_disease | 1/5 | 5/5 |
| ckd-2 | single | chronic_kidney_disease | 0/5 | 1/5 |
| ckd-3 | single | chronic_kidney_disease | 5/5 | 5/5 |
| ckd-4 | single | chronic_kidney_disease | 5/5 | 4/5 |
| thy-1 | single | hypothyroidism | 5/5 | 5/5 |
| thy-2 | single | hypothyroidism | 5/5 | 5/5 |
| thy-3 | single | hypothyroidism | 5/5 | 5/5 |
| thy-4 | single | hypothyroidism | 5/5 | 5/5 |
| com-1 | comorbid | type_2_diabetes, hypertension | 2/5 | 4/5 |
| com-2 | comorbid | type_2_diabetes, chronic_kidney_disease | 5/5 | 4/5 |
| com-3 | comorbid | coronary_artery_disease, hyperlipidemia | 5/5 | 5/5 |
| com-4 | comorbid | hypothyroidism, hyperlipidemia | 5/5 | 5/5 |
| ctl-1 | control | - | 0/5 | 5/5 |
| ctl-2 | control | - | 1/5 | 5/5 |
| ctl-3 | control | - | 0/5 | 0/5 |
| ctl-4 | control | - | 4/5 | 5/5 |

## Reading the result

- **The pre-registered rule is met, and it is not close to the threshold.** The two arms do not overlap (redacted 20-22, unredacted 24-27 of 32) and 5 vs 5 perfectly separated is the smallest p an exact permutation test can give (2/252 = 0.008). Run-to-run spread is about 1 case (SD 1.1) in both arms, so the earlier single-run gap of +4 was not just noise: the real gap is about +5.
- **Where the gain is.** Single-condition cases went from ~16.4 to ~19.2 of 24; comorbid stayed at ~3.4 to ~3.6 of 4; controls went from 1 to 3 of 4 in every repeat.
- **Controls: the mechanism hypothesis holds, in part.** ctl-1 and ctl-2 went from 0/5 and 1/5 correct to 5/5 and 5/5 unredacted; ctl-4 was already 4/5. **ctl-3 stayed 0/5 in both arms** (the model calls a seasonal-allergies case "Hyperlipidemia" whether or not the text is redacted), so redaction does not explain every false alarm.
- **Not all of the gap is DATE_TIME.** The switch turns off *all* text redaction, so it cannot say which entity type carries the effect. The single largest swing is `htn-1` (0/5 -> 5/5), whose history contains a blood pressure of 168/102 that the redactor rewrites to `<PHONE_NUMBER>`; that is the phone-number false positive, not the date one. `ckd-1` (1/5 -> 5/5), `cad-2`, `cad-4` and `lip-2` are the other large movers.
- **What this does not show:** that an option-A/B redactor recovers the unredacted score. That needs its own run after the change.
- **Limits:** one local model, 32 synthetic cases written by the author and not clinician-reviewed, strict keyword scoring, and the unredacted arm exists only in a throwaway script; it is not something the app can do.
