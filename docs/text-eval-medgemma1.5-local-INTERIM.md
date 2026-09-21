# Text-only evaluation: six lab/history conditions

> **INTERIM / PARTIAL. Local MedGemma 1.5 only. The same cases have not been run on the free OpenRouter route (daily quota), so there is no comparison arm yet.**

> Educational project, not clinical validation. Synthetic cases written to textbook thresholds by the project author, not reviewed by a clinician; deliberately clean.

Cases scored: 32 of 32 (0 errored, not counted as right or wrong). Model(s): `medgemma1.5:4b`.

| Group (rule) | Correct | 95% CI (Wilson) |
|---|---|---|
| All cases | 65.6% (21/32) | 48-80% |
| Single condition (top-1 names it) | 66.7% (16/24) | 47-82% |
| Comorbid (both in top 3) | 100.0% (4/4) | 51-100% |
| Control, normal (top-1 names no condition) | 25.0% (1/4) | 5-70% |

Control false alarms: 3 of 4. Abstained: 1 (3.1%, CI 1-16%).

Per condition (single cases): type 2 diabetes 4/4; coronary artery disease 1/4; hyperlipidemia 4/4; hypertension 1/4; chronic kidney disease 2/4; hypothyroidism 4/4

Calibration: Brier 0.194, ECE 0.095; mean confidence 0.72 vs accuracy 0.66; 2 wrong of 13 at confidence >= 0.8.

JSON validity: first-try clean 100.0% (32/32); answered 100.0% (32/32).

Latency: median 78.9s (IQR 69.7-101.5s, max 144.0s).

## Caveats

- Keyword matching of model text to conditions is strict and negation-aware; an unfamiliar wording counts as a miss.
- Small clean synthetic set: intervals are wide and a good score here says nothing about messy real charts.
- The Privacy agent replaces ages and durations with <DATE_TIME> before the model sees the history; that loss is part of the pipeline being measured.
- Hypertension has no structured lab; its cases carry blood pressure in the history text only.
