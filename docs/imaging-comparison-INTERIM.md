# Imaging comparison: OpenRouter free (partial) vs MedGemma 1.5 local

> **INTERIM / PARTIAL. The free-route arm is incomplete (40 of 60 cases) and will be superseded by a completed comparison once the daily quota resets. Do not quote these numbers as final.**

> Educational project, not clinical validation. Same sampled rows through both arms; read the caveats first.

| Metric | OpenRouter free (partial) | MedGemma 1.5 local |
|---|---|---|
| Cases / errored (no answer) | 40 / 3 | 60 / 0 |
| Accuracy, all answered cases | 62.2% (23/37; CI 46-76%) | 61.7% (37/60; CI 49-73%) |
| Sensitivity (pneumonia rows) | 38.9% (7/18; CI 20-61%) | 36.7% (11/30; CI 22-54%) |
| Specificity (normal rows) | 84.2% (16/19; CI 62-94%) | 86.7% (26/30; CI 70-95%) |
| Abstention rate | 16.2% (6/37; CI 8-31%) | 5.0% (3/60; CI 2-14%) |
| Accuracy, committed cases only | 64.5% (20/31; CI 47-79%) | 59.6% (34/57; CI 47-71%) |
| Median latency per case | 49.4 s (IQR 37.5-69.7) | 69.0 s (IQR 57.2-78.8) |
| JSON schema validity | first-try clean 77.5% (31/40); answered 92.5% (37/40); 11 invalid answers | first-try clean 100.0% (60/60); answered 100.0% (60/60); 0 invalid answers |
| Calibration (stated confidence vs top-1 correct) | Brier 0.256, ECE 0.104; mean confidence 0.55 vs accuracy 0.62; 1 wrong of 5 at confidence >= 0.8 | Brier 0.223, ECE 0.237; mean confidence 0.76 vs accuracy 0.62; 3 wrong of 29 at confidence >= 0.8 |
| Served by | `dots-studio/dots-3-note-preview:free` x13; `nex-agi/nex-n2.5-pro:free` x14; `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` x10 | `medgemma1.5:4b` x60 |

## Paired result

37 rows answered by both arms (3 of 40 shared rows excluded because an arm errored).

| | MedGemma 1.5 local correct | MedGemma 1.5 local wrong |
|---|---|---|
| **OpenRouter free (partial) correct** | 17 | 6 |
| **OpenRouter free (partial) wrong** | 4 | 10 |

Exact McNemar p = 0.754 on the 10 discordant rows. Same top-1 category on 25 of 37 rows.

## Notes on this run

- INTERIM: the OpenRouter arm stopped at 40 of 60 cases when the free tier's daily request quota (about 50) ran out; one of its 3 errored records is that quota failure. Only the 37 rows both arms answered are paired.
- The OpenRouter arm was served by three different free models (see 'Served by'), so it measures the free router, not one model.
- No repeat pass yet, so run-to-run stability is not reported. A resume and a second pass are scheduled for after the quota resets.
- Latencies overlap other jobs on the same machine (the text-only run, the pipeline tests); treat them as ranges.

## Caveats

- One dataset of pediatric chest X-rays, one prompt, a small sample. Intervals are wide; a difference smaller than they are is not evidence.
- Top-1 correctness uses a strict keyword categorizer (`categorize_condition`); an unrecognized wording counts as "other", i.e. wrong.
- Calibration is over the model's own stated `overall_confidence`, which no model here was trained to make meaningful.
- A free-router arm can be served by a different model on every case, so it measures the router, not one model.
- "First-try clean" counts empty or schema-invalid answers; ordinary network retries are not counted as invalid.
