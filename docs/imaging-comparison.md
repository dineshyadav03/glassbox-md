# Imaging comparison: OpenRouter free vs MedGemma 1.5 local

> Educational project, not clinical validation. Same sampled rows through both arms; read the caveats first.

| Metric | OpenRouter free | MedGemma 1.5 local |
|---|---|---|
| Cases / errored (no answer) | 60 / 0 | 60 / 0 |
| Accuracy, all answered cases | 58.3% (35/60; CI 46-70%) | 61.7% (37/60; CI 49-73%) |
| Sensitivity (pneumonia rows) | 33.3% (10/30; CI 19-51%) | 36.7% (11/30; CI 22-54%) |
| Specificity (normal rows) | 83.3% (25/30; CI 66-93%) | 86.7% (26/30; CI 70-95%) |
| Abstention rate | 16.7% (10/60; CI 9-28%) | 5.0% (3/60; CI 2-14%) |
| Accuracy, committed cases only | 62.0% (31/50; CI 48-74%) | 59.6% (34/57; CI 47-71%) |
| Median latency per case | 49.0 s (IQR 36.4-67.4) | 69.0 s (IQR 57.2-78.8) |
| JSON schema validity | first-try clean 81.7% (49/60); answered 100.0% (60/60); 11 invalid answers | first-try clean 100.0% (60/60); answered 100.0% (60/60); 0 invalid answers |
| Calibration (stated confidence vs top-1 correct) | Brier 0.239, ECE 0.044; mean confidence 0.54 vs accuracy 0.58; 1 wrong of 8 at confidence >= 0.8 | Brier 0.223, ECE 0.237; mean confidence 0.76 vs accuracy 0.62; 3 wrong of 29 at confidence >= 0.8 |
| Served by | `dots-studio/dots-3-note-preview:free` x26; `nex-agi/nex-n2.5-pro:free` x20; `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` x14 | `medgemma1.5:4b` x60 |

## Paired result

60 rows answered by both arms (0 of 60 shared rows excluded because an arm errored).

| | MedGemma 1.5 local correct | MedGemma 1.5 local wrong |
|---|---|---|
| **OpenRouter free correct** | 27 | 8 |
| **OpenRouter free wrong** | 10 | 15 |

Exact McNemar p = 0.815 on the 18 discordant rows. Same top-1 category on 40 of 60 rows.

**Run-to-run stability, OpenRouter free** (2 passes, 18 rows in all of them): same top-1 category on 12 (66.7%, CI 44-84%); correctness changed on 5; served model changed on 11.

## Notes on this run

- OpenRouter pass 1 completed across two quota days (40 cases on day 1, 20 more on day 2 after the daily reset) and is the headline pass, 60/60 cases, no errors.
- OpenRouter pass 2 (run-to-run stability) reached only 20 of 60 rows before the same day's quota ran out again (2 of those 20 errored -- one a content-safety string instead of JSON, one a 429); it is not a second complete sample, only a partial check.
- The free arm was served by more than one underlying model across the two passes, so it measures the router, not one fixed model.

## Caveats

- One dataset of pediatric chest X-rays, one prompt, a small sample. Intervals are wide; a difference smaller than they are is not evidence.
- Top-1 correctness uses a strict keyword categorizer (`categorize_condition`); an unrecognized wording counts as "other", i.e. wrong.
- Calibration is over the model's own stated `overall_confidence`, which no model here was trained to make meaningful.
- A free-router arm can be served by a different model on every case, so it measures the router, not one model.
- "First-try clean" counts empty or schema-invalid answers; ordinary network retries are not counted as invalid.
