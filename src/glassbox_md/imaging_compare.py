"""Paired comparison of two imaging-evaluation arms run on the same rows.

Each arm is one or more results files written by `scripts/eval_imaging.py`
(one file per repeat pass). This module never calls a model: it reads the
files and reports, for both arms,

- top-1 accuracy, sensitivity and specificity with Wilson intervals, both
  ignoring abstention and counting only committed cases (the two views the
  single-arm report already uses);
- the abstention rate;
- calibration of the stated `overall_confidence` against top-1 correctness
  (Brier score, expected calibration error over fixed bins, and how many
  wrong answers were given at high confidence);
- JSON validity: the share of cases whose model answers were all usable
  first time, and the share that produced any usable answer at all;
- latency, and which model actually served each case;
- for the pairing itself, the discordant counts and an exact McNemar test;
- for a repeated arm, how often the same row's top-1 category changes
  between passes (the run-to-run variance a router or sampling adds).

A paired test on n rows is weak evidence: with 60 rows only a large gap
reaches significance, and the intervals here are wide. The report says so
instead of declaring a winner.
"""

from __future__ import annotations

import math
import statistics
from collections import Counter
from pathlib import Path
from typing import Any

from .imaging_eval import (
    Record,
    _ci,
    _is_correct,
    _rate,
    _top1_block,
    categorize_condition,
    load_results,
)

CALIBRATION_BINS = ((0.0, 0.5), (0.5, 0.8), (0.8, 0.95), (0.95, 1.0000001))
HIGH_CONFIDENCE = 0.8


def load_arm(paths: list[str | Path]) -> list[list[Record]]:
    """One list of records per pass, in the order given."""
    return [load_results(p) for p in paths]


def _completed(records: list[Record]) -> list[Record]:
    return [r for r in records if not r.get("error")]


def is_correct(record: Record) -> bool:
    return _is_correct(record["true_label"], categorize_condition(record.get("top1_condition")))


def mcnemar_exact(only_a: int, only_b: int) -> float:
    """Two-sided exact McNemar p-value from the discordant pair counts
    (rows only A got right, rows only B got right). 1.0 with no discordance."""
    n = only_a + only_b
    if n == 0:
        return 1.0
    tail = sum(math.comb(n, k) for k in range(min(only_a, only_b) + 1)) / 2**n
    return min(1.0, 2 * tail)


def calibration(records: list[Record]) -> dict[str, Any]:
    """Stated overall confidence vs whether the top-1 call was right."""
    rows = [(r["overall_confidence"], is_correct(r)) for r in _completed(records) if r.get("overall_confidence") is not None]
    if not rows:
        return {"n": 0}
    brier = statistics.fmean((conf - float(ok)) ** 2 for conf, ok in rows)
    bins = []
    ece = 0.0
    for low, high in CALIBRATION_BINS:
        members = [(c, ok) for c, ok in rows if low <= c < high]
        if not members:
            continue
        mean_conf = statistics.fmean(c for c, _ in members)
        accuracy = sum(ok for _, ok in members) / len(members)
        ece += len(members) / len(rows) * abs(mean_conf - accuracy)
        bins.append({"range": (low, min(high, 1.0)), "n": len(members), "mean_confidence": mean_conf, "accuracy": accuracy})
    high_conf = [(c, ok) for c, ok in rows if c >= HIGH_CONFIDENCE]
    return {
        "n": len(rows),
        "brier": brier,
        "ece": ece,
        "bins": bins,
        "mean_confidence": statistics.fmean(c for c, _ in rows),
        "accuracy": sum(ok for _, ok in rows) / len(rows),
        "n_high_confidence": len(high_conf),
        "n_high_confidence_wrong": sum(not ok for _, ok in high_conf),
    }


def json_validity(records: list[Record]) -> dict[str, Any]:
    """`clean`: every model answer for the case was usable (needs the call
    stats, so records from before they existed are left out of it).
    `answered`: the case ended with a usable answer after any retries."""
    tracked = [r for r in records if r.get("model_attempts") is not None]
    clean = [r for r in tracked if r.get("invalid_responses") == 0]
    answered = [r for r in records if not r.get("error")]
    return {
        "n_cases": len(records),
        "n_tracked": len(tracked),
        "n_clean_first_time": len(clean),
        "clean_rate": _rate(len(clean), len(tracked)),
        "clean_rate_ci95": _ci(len(clean), len(tracked)),
        "n_answered": len(answered),
        "answered_rate": _rate(len(answered), len(records)),
        "answered_rate_ci95": _ci(len(answered), len(records)),
        "invalid_answers_total": sum(r.get("invalid_responses") or 0 for r in tracked),
    }


def latency(records: list[Record]) -> dict[str, Any]:
    times = sorted(r["wall_seconds"] for r in _completed(records) if r.get("wall_seconds") is not None)
    if not times:
        return {"n": 0}
    quartiles = statistics.quantiles(times, n=4) if len(times) >= 2 else [times[0]] * 3
    return {"n": len(times), "median": statistics.median(times), "q1": quartiles[0], "q3": quartiles[2], "max": times[-1]}


def arm_summary(records: list[Record]) -> dict[str, Any]:
    completed = _completed(records)
    abstained = [r for r in completed if r.get("abstained")]
    return {
        "n": len(records),
        "n_errors": len(records) - len(completed),
        "top1_all_answered": _top1_block(completed),
        "top1_committed": _top1_block([r for r in completed if not r.get("abstained")]),
        "n_abstained": len(abstained),
        "abstention_rate": _rate(len(abstained), len(completed)),
        "abstention_rate_ci95": _ci(len(abstained), len(completed)),
        "calibration": calibration(records),
        "json": json_validity(records),
        "latency": latency(records),
        "models": dict(Counter(r.get("model_name") or "unrecorded" for r in completed)),
    }


def pair(a: list[Record], b: list[Record]) -> dict[str, Any]:
    """Compare two record lists row by row. Only rows where BOTH arms
    produced an answer are paired; the rest are counted, not dropped quietly."""
    by_a = {r["row_idx"]: r for r in a}
    by_b = {r["row_idx"]: r for r in b}
    shared = sorted(set(by_a) & set(by_b))
    usable = [i for i in shared if not by_a[i].get("error") and not by_b[i].get("error")]
    only_a = sum(is_correct(by_a[i]) and not is_correct(by_b[i]) for i in usable)
    only_b = sum(is_correct(by_b[i]) and not is_correct(by_a[i]) for i in usable)
    both = sum(is_correct(by_a[i]) and is_correct(by_b[i]) for i in usable)
    neither = len(usable) - only_a - only_b - both
    return {
        "n_shared_rows": len(shared),
        "n_paired": len(usable),
        "n_unpaired_errors": len(shared) - len(usable),
        "both_correct": both,
        "only_a_correct": only_a,
        "only_b_correct": only_b,
        "neither_correct": neither,
        "mcnemar_p": mcnemar_exact(only_a, only_b),
        "same_top1_category": sum(
            categorize_condition(by_a[i].get("top1_condition")) == categorize_condition(by_b[i].get("top1_condition"))
            for i in usable
        ),
    }


def repeat_stability(passes: list[list[Record]]) -> dict[str, Any] | None:
    """For an arm run more than once: among rows answered in every pass, how
    many kept the same top-1 category, and how many had a different served model."""
    if len(passes) < 2:
        return None
    maps = [{r["row_idx"]: r for r in _completed(p)} for p in passes]
    rows = sorted(set.intersection(*(set(m) for m in maps)))
    stable = 0
    correctness_changed = 0
    models_changed = 0
    for i in rows:
        cats = {categorize_condition(m[i].get("top1_condition")) for m in maps}
        stable += len(cats) == 1
        correctness_changed += len({is_correct(m[i]) for m in maps}) > 1
        models_changed += len({m[i].get("model_name") for m in maps}) > 1
    return {
        "n_passes": len(passes),
        "n_rows_in_all_passes": len(rows),
        "n_same_top1_category": stable,
        "same_category_rate": _rate(stable, len(rows)),
        "same_category_rate_ci95": _ci(stable, len(rows)),
        "n_correctness_changed": correctness_changed,
        "n_served_model_changed": models_changed,
    }


def compare(arm_a: list[list[Record]], arm_b: list[list[Record]]) -> dict[str, Any]:
    """Arms are lists of passes. Arm summaries pool every pass's records
    that share row indices by taking the FIRST pass; repeats feed only the
    stability figures, so no row is double-counted in the headline."""
    first_a, first_b = arm_a[0], arm_b[0]
    return {
        "a": arm_summary(first_a),
        "b": arm_summary(first_b),
        "pairing": pair(first_a, first_b),
        "stability_a": repeat_stability(arm_a),
        "stability_b": repeat_stability(arm_b),
    }


# --- report ------------------------------------------------------------------

def _pct(value: float | None) -> str:
    return "n/a" if value is None else f"{value * 100:.1f}%"


def _ci_text(interval: list[float] | None) -> str:
    return "n/a" if not interval else f"{interval[0] * 100:.0f}-{interval[1] * 100:.0f}%"


def _cell(rate: float | None, interval: list[float] | None, k: int, n: int) -> str:
    return f"{_pct(rate)} ({k}/{n}; CI {_ci_text(interval)})"


def _num(value: float | None, digits: int = 2) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def render_markdown(result: dict[str, Any], label_a: str, label_b: str, notes: list[str] | None = None) -> str:
    a, b, pr = result["a"], result["b"], result["pairing"]
    rows = ["| Metric | " + label_a + " | " + label_b + " |", "|---|---|---|"]

    def row(name: str, fa: str, fb: str) -> None:
        rows.append(f"| {name} | {fa} | {fb} |")

    def block_cells(key: str, metric: str, ci: str, hit: str, total: str) -> tuple[str, str]:
        out = []
        for s in (a, b):
            blk = s[key]
            out.append(_cell(blk[metric], blk[ci], blk[hit], blk[total]))
        return out[0], out[1]

    row("Cases / errored (no answer)", f"{a['n']} / {a['n_errors']}", f"{b['n']} / {b['n_errors']}")
    row("Accuracy, all answered cases", *block_cells("top1_all_answered", "accuracy", "accuracy_ci95", "n_correct", "n"))
    row("Sensitivity (pneumonia rows)", *block_cells("top1_all_answered", "sensitivity", "sensitivity_ci95", "n_pneumonia_hit", "n_pneumonia"))
    row("Specificity (normal rows)", *block_cells("top1_all_answered", "specificity", "specificity_ci95", "n_normal_hit", "n_normal"))
    row("Abstention rate", *(_cell(s["abstention_rate"], s["abstention_rate_ci95"], s["n_abstained"], s["top1_all_answered"]["n"]) for s in (a, b)))
    row("Accuracy, committed cases only", *block_cells("top1_committed", "accuracy", "accuracy_ci95", "n_correct", "n"))
    row("Median latency per case", *(f"{_num(s['latency'].get('median'), 1)} s (IQR {_num(s['latency'].get('q1'), 1)}-{_num(s['latency'].get('q3'), 1)})" if s["latency"]["n"] else "n/a" for s in (a, b)))

    def json_cell(s: dict[str, Any]) -> str:
        j = s["json"]
        if j["n_tracked"] == 0:
            return f"answered {_pct(j['answered_rate'])} ({j['n_answered']}/{j['n_cases']}); first-try validity not recorded"
        return (
            f"first-try clean {_pct(j['clean_rate'])} ({j['n_clean_first_time']}/{j['n_tracked']}); "
            f"answered {_pct(j['answered_rate'])} ({j['n_answered']}/{j['n_cases']}); "
            f"{j['invalid_answers_total']} invalid answers"
        )

    row("JSON schema validity", json_cell(a), json_cell(b))

    def cal_cell(s: dict[str, Any]) -> str:
        c = s["calibration"]
        if not c["n"]:
            return "n/a"
        return (
            f"Brier {_num(c['brier'], 3)}, ECE {_num(c['ece'], 3)}; mean confidence {_num(c['mean_confidence'])} "
            f"vs accuracy {_num(c['accuracy'])}; {c['n_high_confidence_wrong']} wrong of {c['n_high_confidence']} at confidence >= {HIGH_CONFIDENCE}"
        )

    row("Calibration (stated confidence vs top-1 correct)", cal_cell(a), cal_cell(b))
    row("Served by", "; ".join(f"`{m}` x{n}" for m, n in sorted(a["models"].items())) or "n/a", "; ".join(f"`{m}` x{n}" for m, n in sorted(b["models"].items())) or "n/a")

    lines = [
        f"# Imaging comparison: {label_a} vs {label_b}",
        "",
        "> Educational project, not clinical validation. Same sampled rows through both arms; read the caveats first.",
        "",
        *rows,
        "",
        "## Paired result",
        "",
        f"{pr['n_paired']} rows answered by both arms ({pr['n_unpaired_errors']} of {pr['n_shared_rows']} shared rows excluded because an arm errored).",
        "",
        "| | " + label_b + " correct | " + label_b + " wrong |",
        "|---|---|---|",
        f"| **{label_a} correct** | {pr['both_correct']} | {pr['only_a_correct']} |",
        f"| **{label_a} wrong** | {pr['only_b_correct']} | {pr['neither_correct']} |",
        "",
        f"Exact McNemar p = {_num(pr['mcnemar_p'], 3)} on the {pr['only_a_correct'] + pr['only_b_correct']} discordant rows. "
        f"Same top-1 category on {pr['same_top1_category']} of {pr['n_paired']} rows.",
        "",
    ]
    for label, key in ((label_a, "stability_a"), (label_b, "stability_b")):
        st = result[key]
        if st:
            lines += [
                f"**Run-to-run stability, {label}** ({st['n_passes']} passes, {st['n_rows_in_all_passes']} rows in all of them): "
                f"same top-1 category on {st['n_same_top1_category']} ({_pct(st['same_category_rate'])}, CI {_ci_text(st['same_category_rate_ci95'])}); "
                f"correctness changed on {st['n_correctness_changed']}; served model changed on {st['n_served_model_changed']}.",
                "",
            ]
    if notes:
        lines += ["## Notes on this run", "", *[f"- {n}" for n in notes], ""]
    lines += [
        "## Caveats",
        "",
        "- One dataset of pediatric chest X-rays, one prompt, a small sample. Intervals are wide; a difference smaller than they are is not evidence.",
        "- Top-1 correctness uses a strict keyword categorizer (`categorize_condition`); an unrecognized wording counts as \"other\", i.e. wrong.",
        "- Calibration is over the model's own stated `overall_confidence`, which no model here was trained to make meaningful.",
        "- A free-router arm can be served by a different model on every case, so it measures the router, not one model.",
        "- \"First-try clean\" counts empty or schema-invalid answers; ordinary network retries are not counted as invalid.",
        "",
    ]
    return "\n".join(lines)
