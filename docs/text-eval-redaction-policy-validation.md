# Redaction policy validation: does the implemented redactor recover the accuracy?

> Educational project, not clinical validation. Local MedGemma 1.5 (`medgemma1.5:4b`), the same 32 synthetic text cases, 5 repeats of the **implemented** redaction policy (`agents/redaction_policy.py`, commit `c79ad78`), compared with the 5 old-redactor and 5 unredacted repeats from [the powered rerun](text-eval-redaction-powered-rerun.md). Criteria fixed in commit `8b13d7e` before measuring.

## Accuracy per repeat (correct out of 32)

| Repeat | Old redactor | Unredacted | **New policy** |
|---|---|---|---|
| 1 | 22 | 24 | 27 |
| 2 | 20 | 26 | 27 |
| 3 | 20 | 26 | 27 |
| 4 | 22 | 26 | 27 |
| 5 | 20 | 27 | 26 |

| | Old redactor | Unredacted | New policy |
|---|---|---|---|
| Mean | 20.8 | 25.8 | 26.8 |
| SD across repeats | 1.10 | 1.10 | 0.45 |
| Range | 20-22 | 24-27 | 26-27 |
| Unanswered cases (counted wrong) | 0 | 0 | 1 |

## Verdict against the pre-registered criteria

- **Recovers** (every new repeat above the best old-redactor repeat, and exact permutation p < 0.05 vs the old redactor): min(new) = 26, max(old) = 22; mean difference +6.0 cases; p = 0.0079 -> **MET**.
- **Versus unredacted:** mean difference +1.0 cases; permutation p = 0.1667; ranges overlap (new 26-27, unredacted 24-27) -> **indistinguishable from unredacted**.

Sensitivity: one new-policy case (repeat 3, `ctl-3`) is a model-level failure counted as wrong (see below). Counting it as right would give [27, 27, 28, 27, 26]; the 'recovers' verdict would be **MET** either way.

## Per group (correct per repeat, mean)

| Group | Cases | Old redactor | Unredacted | New policy |
|---|---|---|---|---|
| single | 24 | 16.4 | 19.2 | 19.4 |
| comorbid | 4 | 3.4 | 3.6 | 4.0 |
| control | 4 | 1.0 | 3.0 | 3.4 |

## Mechanism watch: the normal-panel controls (times right out of 5)

| Control | Old redactor | Unredacted | New policy |
|---|---|---|---|
| ctl-1 | 0/5 | 5/5 | 5/5 |
| ctl-2 | 1/5 | 5/5 | 4/5 |
| ctl-3 | 0/5 | 0/5 | 3/5 |
| ctl-4 | 4/5 | 5/5 | 5/5 |
| **all controls** | **5/20** | **15/20** | **17/20** |

## Per case, correct out of 5 repeats

| Case | Group | Old redactor | Unredacted | New policy |
|---|---|---|---|---|
| t2d-1 | single | 5/5 | 5/5 | 5/5 |
| t2d-2 | single | 5/5 | 5/5 | 4/5 |
| t2d-3 | single | 5/5 | 5/5 | 5/5 |
| t2d-4 | single | 5/5 | 5/5 | 5/5 |
| cad-1 | single | 2/5 | 1/5 | 2/5 |
| cad-2 | single | 3/5 | 5/5 | 5/5 |
| cad-3 | single | 0/5 | 1/5 | 5/5 |
| cad-4 | single | 2/5 | 4/5 | 2/5 |
| lip-1 | single | 5/5 | 5/5 | 5/5 |
| lip-2 | single | 3/5 | 5/5 | 5/5 |
| lip-3 | single | 5/5 | 5/5 | 5/5 |
| lip-4 | single | 5/5 | 5/5 | 5/5 |
| htn-1 | single | 0/5 | 5/5 | 5/5 |
| htn-2 | single | 0/5 | 0/5 | 0/5 |
| htn-3 | single | 5/5 | 5/5 | 5/5 |
| htn-4 | single | 1/5 | 0/5 | 0/5 |
| ckd-1 | single | 1/5 | 5/5 | 5/5 |
| ckd-2 | single | 0/5 | 1/5 | 0/5 |
| ckd-3 | single | 5/5 | 5/5 | 5/5 |
| ckd-4 | single | 5/5 | 4/5 | 4/5 |
| thy-1 | single | 5/5 | 5/5 | 5/5 |
| thy-2 | single | 5/5 | 5/5 | 5/5 |
| thy-3 | single | 5/5 | 5/5 | 5/5 |
| thy-4 | single | 5/5 | 5/5 | 5/5 |
| com-1 | comorbid | 2/5 | 4/5 | 5/5 |
| com-2 | comorbid | 5/5 | 4/5 | 5/5 |
| com-3 | comorbid | 5/5 | 5/5 | 5/5 |
| com-4 | comorbid | 5/5 | 5/5 | 5/5 |
| ctl-1 | control | 0/5 | 5/5 | 5/5 |
| ctl-2 | control | 1/5 | 5/5 | 4/5 |
| ctl-3 | control | 0/5 | 0/5 | 3/5 |
| ctl-4 | control | 4/5 | 5/5 | 5/5 |

## Reading the result

- **The new redactor recovers the loss.** All five repeats (26-27 of 32) are above every old-redactor repeat (20-22); a perfect 5-vs-5 split, so the exact permutation p of 0.008 is the smallest possible. The single-condition and comorbid groups are at or near their ceiling (19-20 of 24, 4 of 4).
- **It is indistinguishable from redaction off**, and not below it: mean 26.8 vs 25.8, p = 0.17, ranges overlap. Read that as "no detectable cost from the parts of the redaction that remain (absolute dates, typed placeholders, age bands)", not as "better than unredacted": one repeat per arm-slot, five repeats, one small model.
- **Controls:** 17 of 20 correct vs 15 of 20 unredacted and 5 of 20 with the old redactor. The mechanism hypothesis (garbled `<DATE_TIME>` text prompting a condition on a clean panel) is supported for ctl-1 and ctl-2. `ctl-3` (seasonal allergies) is 3/5 now, against 0/5 in both earlier arms; that is unexplained and should not be over-read.
- **Individual cases moved in ways this design cannot explain.** `cad-3` (ST segment) went 0/5 old, 1/5 unredacted, 5/5 new, although the unredacted arm also kept "ST segment"; `cad-4` is 2/5 new vs 4/5 unredacted. With 5 repeats per case these are noted, not interpreted.

## What went wrong in this run, disclosed

- **Four legs were lost and redone.** The Ollama server crashed at 23:32 IST on Sep 24 (`llama-server ... 0xc0000142 DLL Initialization Failed`), and repeats 2-5 were written as all "Connection error" records that the runner counted as complete. They were set aside (not part of this data) and rerun after the runner was changed to re-run only infrastructure failures. An earlier note in this project attributed that to an Ollama auto-update; the logs show the upgrade to 0.34.4 was on Sep 24 at 18:48, before the run, and the failure was the crash.
- **Repeat 3, `ctl-3` is a model-level failure counted as wrong.** The model ran away on that case (4,500+ tokens at ~8 tokens/s, against a normal 300-500) and the request timed out. It reproduced under the correct server configuration, so it is not only a setup artifact, but the recorded failure was produced while a manually restarted server (4096-token context, not the 131072 used elsewhere) was serving. Counting it as right would not change any verdict (26-27 -> 27,27,28,27,26; same p).
- **Ollama version changed mid-experiment.** The old-arm repeats 1-3 ran on 0.34.2 and repeats 4-5 (and everything in the new arm) on 0.34.4. Within each old arm the two halves do not differ (redacted 22,20,20 vs 22,20; unredacted 24,26,26 vs 26,27), so there is no visible version effect, but it cannot be excluded.
- **Shared machine.** Another tool was using the same Ollama (`qwen2.5:3b`, `nomic-embed-text`) and the machine entered Modern Standby overnight. That affects latency and can stall a run; it should not change accuracy.
- **The new arm was not interleaved with the other two.** It ran two days later, so any drift in the machine or server between the runs is confounded with the redactor.
- **Superseded attempts were removed from the committed files** (one line per case, last write kept), including 3 infrastructure-failure lines in repeat 1 and the repeated timeouts in repeat 3.

## Limits

One small local model, 32 author-written cases not reviewed by a clinician, strict keyword scoring, and 5 repeats. It says nothing about other models or real charts.
