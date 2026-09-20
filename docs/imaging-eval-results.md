# Imaging evaluation: chest X-ray, pneumonia vs normal

> Educational project, not clinical validation. Read the caveats at the bottom before quoting any number here.

## Setup

- Dataset: `hf-vision/chest-xray-pneumonia`, `test` split (624 pediatric chest X-rays), from Kermany, Zhang & Goldbaum (2018), *Labeled Optical Coherence Tomography (OCT) and Chest X-Ray Images for Classification*, Mendeley Data V2, doi:10.17632/rscbjbr9sj.2, licensed CC BY 4.0. Labels were graded by two physicians.
- Cases in this file: 24 (sample seed 0; requested per class: 12).
- Model(s) recorded: `dots-studio/dots-3-note-preview:free`, `google/gemma-4-26b-a4b-it:free`, `nex-agi/nex-n2.5-pro:free`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` (the model the provider reports as having served each request; the configured router alias is used only where the provider reported none).
- Run window: 2026-09-20T06:58:43.248994+00:00 to 2026-09-20T07:58:46.428832+00:00.

## Headline: what the model's top-1 says, regardless of abstention

Every case that produced an answer (n = 24). The app still shows an abstained case's ranked differential, flagged as inconclusive, so this is the model's own top-1 call.

| Metric | Value | 95% CI (Wilson) | Count |
|---|---|---|---|
| Accuracy | 33.3% | 18.0% to 53.3% | 8 / 24 |
| Sensitivity (PNEUMONIA rows, top-1 pneumonia) | 50.0% | 25.4% to 74.6% | 6 / 12 |
| Specificity (NORMAL rows, top-1 normal) | 16.7% | 4.7% to 44.8% | 2 / 12 |
| Top-3 sensitivity (pneumonia anywhere in top 3) | 83.3% | 55.2% to 95.3% | 10 / 12 |

The pipeline abstained (overall confidence below its threshold) on 17 of 24 answered cases: 70.8%, 95% CI 50.8% to 85.1%.

## If abstention is respected: committed cases only (n = 7)

| Metric | Value | 95% CI (Wilson) | Count |
|---|---|---|---|
| Accuracy | 14.3% | 2.6% to 51.3% | 1 / 7 |
| Sensitivity (PNEUMONIA rows, top-1 pneumonia) | 25.0% | 4.6% to 69.9% | 1 / 4 |
| Specificity (NORMAL rows, top-1 normal) | 0.0% | 0.0% to 56.2% | 0 / 3 |
| Top-3 sensitivity (pneumonia anywhere in top 3) | 75.0% | 30.1% to 95.4% | 3 / 4 |

Neither view alone is the honest picture: abstaining on most cases can flatter this one, while ignoring the model's own low confidence flatters the headline.

Counting every errored or abstained case as wrong, accuracy is 4.2% over all 24 cases.

## Case accounting

| | NORMAL | PNEUMONIA | Total |
|---|---|---|---|
| Total cases | 12 | 12 | 24 |
| Scored | 3 | 4 | 7 |
| Abstained (model confidence below threshold) | 9 | 8 | 17 |
| Errored (image, network or pipeline failure) | 0 | 0 | 0 |

Coverage (scored / total): 29.2%.

## Confusion (scored cases; rows are the truth, columns the model's top-1)

| Truth | Top-1 pneumonia | Top-1 normal | Top-1 other |
|---|---|---|---|
| NORMAL | 0 | 0 | 3 |
| PNEUMONIA | 1 | 0 | 3 |

## Confidence and review flags

- Mean overall confidence: 0.55 on correct cases, 0.48 on incorrect ones.
- Flagged for review (close differential or low confidence): 14.3% of scored cases; 16.7% of incorrect cases vs 0.0% of correct ones (abstained cases are excluded from all three).
- Median pipeline time per case: 55.02 s.

## Caveats

- Single dataset: one set of pediatric chest X-rays (ages 1-5, one hospital). Nothing here says how the pipeline behaves on adults, other scanners, or any other condition.
- Small, class-balanced sample, not the split's natural mix. Accuracy is not a deployment-prevalence estimate, and at this size the intervals above are wide, so small differences between runs or models should not be read as real.
- Free-tier model identity varies run to run. The default `openrouter/free` is a router that can pick a different model on every call (the model that actually served each case is recorded above), so this is a measurement of a moving mix of models, and a re-run can legitimately give a different result.
- The pipeline sends the image alone: these cases have no labs, history or retrieved literature, so the model is judging the picture with an empty text prompt.
- The PNEUMONIA label pools bacterial and viral cases. Scoring is binary against the dataset label; a top-1 that is neither pneumonia nor normal counts as a miss for both classes.
- Free-text condition names are mapped to categories by a keyword heuristic (`categorize_condition`). The raw strings are kept in the results file so anything it misjudges can be audited.
- Images are re-encoded JPEGs wrapped as synthetic DICOM, not real scanner exports.
- Not clinical validation. This measures one educational pipeline on one public dataset.
