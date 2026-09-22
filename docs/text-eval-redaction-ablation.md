# DATE_TIME redaction ablation: does the text set improve with redaction off?

> Educational project, not clinical validation. One local model, one prompt, 32 synthetic cases; read the caveats first.

## Runs

| Run | Redaction | n correct / 32 |
|---|---|---|
| Baseline (committed interim) | on | 21 |
| Noise-floor rerun (same redacted set, resampled) | on | 23 |
| Ablation | **off** | 25 |

## Pre-registered decision rule (fixed before these results)

Material = the unredacted run answers at least 4 more of 32 cases correctly than the committed baseline (net, >=12.5 percentage points), **and** the discordant cases favour it.

## Baseline (redacted) vs ablation (unredacted)

n = 32 paired cases. Both correct: 19. Only baseline correct: 2. Only ablation correct: 6. Neither correct: 5.

Net gain, unredacted vs baseline: **+4 cases** (12.5 points). Exact McNemar p = 0.289 on 8 discordant cases.

## Noise floor: baseline vs a second redacted run (same prompts, same redaction, resampled)

n = 32. Both correct: 21. Only baseline: 0. Only rerun: 2. Neither: 9. Net movement from resampling alone: **+2 cases** (6.2 points). McNemar p = 0.500.

## Verdict against the pre-registered rule

By the letter of the rule set in advance, this **meets** the bar: net +4 cases (threshold +4) and discordant cases favour the unredacted run 6-2.

That verdict needs a caveat the rule didn't anticipate: resampling the SAME redacted prompts a second time, with nothing else changed, already produced +2 cases on its own -- about half the size of the effect being attributed to redaction. With one run per arm (2 redacted samples, 1 unredacted sample) and n = 32, this design cannot separate 'redaction hurts accuracy' from 'this model's answers are noisy at temperature 0.2 and 32 cases is too few to tell the two apart.' The result sits exactly at the pre-registered threshold, not clearly past it.

## Discordant cases (baseline vs ablation)

- `cad-4` (single, expects ['coronary_artery_disease']): correct in **ablation** only
- `ckd-1` (single, expects ['chronic_kidney_disease']): correct in **ablation** only
- `com-1` (comorbid, expects ['type_2_diabetes', 'hypertension']): correct in **baseline** only
- `ctl-1` (control, expects []): correct in **ablation** only
- `ctl-2` (control, expects []): correct in **ablation** only
- `ctl-3` (control, expects []): correct in **ablation** only
- `ctl-4` (control, expects []): correct in **baseline** only
- `htn-1` (single, expects ['hypertension']): correct in **ablation** only

## What the ablation confirms qualitatively (from the earlier redaction mapping)

- Every one of the 32 histories loses at least one DATE_TIME span under current redaction (ages under 90, most durations, relative times). The ablation run's prompts confirmed this text survives intact when the patch is applied.
- Two histories (`htn-1`, `cad-3`) also lose a non-date span under current redaction (`168/102` -> `<PHONE_NUMBER>`; `ST segment` -> `<LOCATION>`) -- unaffected by this ablation's scope (it only disables text redaction generally, both were part of the same disabled call).

## Caveats

- 32 cases, synthetic, written by the project author to textbook thresholds; not clinician-reviewed.
- One run per condition (this ablation is not itself repeated), against a model that is not run at temperature 0.
- The redaction toggle is a monkeypatch in a throwaway script (`redact_text` replaced with the identity function for the process's lifetime), not a code path in the app; it disables ALL text redaction, not just DATE_TIME, so this measures the ceiling if nothing were redacted, not option A or B specifically.
- Strict keyword-based scoring as elsewhere in this project's evals; see `text_eval.py`.

---

## Addendum: powered rerun, planned (2026-09-22)

The single-run ablation above sits right at its own decision threshold, with
a same-condition resample moving nearly as much as the effect being
attributed to redaction. Decision: neither implement A+B nor backlog on that
evidence. Instead, run **5 repeats of both arms** (redacted, unredacted;
same 32 cases; local MedGemma 1.5; alternating order), and decide from the
distribution of per-repeat accuracy, not one run per arm.

**Rule, fixed before running:**

- **Non-overlap:** every one of the 5 unredacted repeat accuracies exceeds
  every one of the 5 redacted repeat accuracies (`min(unredacted) >
  max(redacted)`).
- **And** an exact permutation test over all 252 ways to split the 10
  repeat accuracies into two groups of 5 gives a two-sided p < 0.05 on the
  difference in means.

Both together is "unredacted wins consistently beyond the run-to-run
spread": implement A+B immediately after (Safe Harbor-only date filtering +
age bucketing with a real age recognizer so ages 90+ stop leaking, typed
placeholders for whatever is still redacted, the blood-pressure-as-
`PHONE_NUMBER` and clinical-term-as-`LOCATION`/`PERSON` recognizer fixes,
redaction tests updated). Either condition failing means the distributions
overlap: redaction stays, and this question is closed with evidence.

**Mechanism hypothesis to watch, not part of the primary rule:** the single
run showed normal-panel controls scoring 1/4 correct redacted vs 3/4
unredacted -- consistent with garbled `<DATE_TIME> with <DATE_TIME>` text
prompting the model to invent a condition on a clean panel. The rerun will
report each of the 4 control cases' correct-rate out of 5 per arm. If this
pattern holds up across repeats, it is the strongest argument for A+B
specifically (typed placeholders fixing garbled-token hallucination),
independent of whether the primary accuracy rule is met -- reported
alongside the primary verdict, not substituted for it.
