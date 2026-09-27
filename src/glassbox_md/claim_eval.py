"""A labelled test set for the evidence check (decision_layer.py), and its scoring.

The decision layer asks a judge model whether a claim is supported by a case's
text. Nothing showed that it can tell a supported claim from a contradicted one,
or from one the source says nothing about. This module builds items whose right
answer is true by construction, from the 32 synthetic cases in `text_eval.py`, so
any judge (BioDecision-4B, MedGemma, another) can be measured the same way.

Each case is put through the real Parser, Privacy and Data Preparation stages
(no model call), so the source the judge reads is exactly what the diagnostic
model sees: the redacted history with its banded age, the raw lab table, and the
normalised lab values. Per case, seven claims:

- supported (3): a lab as written in the table (original units); a lab in the
  normalised units; the patient's age band as it appears in the source.
- contradicted (2): the first lab with a value changed by a large factor; an age
  band 30 years away from the real one.
- not enough information (2): facts a case never states (a medication, a smoking
  history, a blood pressure, a prior surgery ...), chosen only when none of the
  fact's key words appears anywhere in that case's source.

What this does and does not show. It measures reading and bookkeeping over short
synthetic sources: can the judge match a number, an age band, or spot an absent
fact. It says nothing about the harder thing the layer is for -- whether a
diagnostic model's *reasoning* claims ("this pattern is typical of X") are
supported -- and the claims are templated, so a judge can do well here and still
be weak on real evidence bullets. A poor score is informative; a good one is
necessary, not sufficient.
"""

from __future__ import annotations

import json
import re
import statistics
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from . import decision_layer as dl
from .imaging_compare import calibration_from_pairs
from .imaging_eval import _ci, _rate
from .text_eval import CASES, TextCase, make_pdf

GOLDS = (dl.SUPPORTED, dl.CONTRADICTED, dl.NOT_ENOUGH)

_PRETTY = {
    "hemoglobin_a1c": "HbA1c",
    "total_cholesterol": "total cholesterol",
    "ldl_cholesterol": "LDL cholesterol",
    "hdl_cholesterol": "HDL cholesterol",
    "tsh": "TSH",
}

# (claim, words that must not appear in the case's source for the claim to be a fair
# "not enough information" item)
_ABSENT_FACTS = (
    ("The patient takes metformin.", ("metformin",)),
    ("The patient has a history of smoking.", ("smok",)),
    ("The patient's blood pressure is 140/90 mmHg.", ("blood pressure", "mmhg", "bp ")),
    ("The patient has had a previous heart attack.", ("heart attack", "infarction")),
    ("The patient is currently taking a statin.", ("statin",)),
    ("The patient underwent surgery last year.", ("surgery", "operation", "stent", "procedure")),
    ("The patient's body mass index is 31.", ("body mass", "bmi")),
    ("The patient has a family history of kidney disease.", ("kidney", "renal")),
)

_BAND = re.compile(r"\b(\d{2})-(\d{2})\s+year\s+old\b")


@dataclass(frozen=True)
class ClaimItem:
    item_id: str
    case_id: str
    kind: str
    gold: str
    claim: str
    source: str


def _name(key: str) -> str:
    return _PRETTY.get(key, key.replace("_", " "))


def _fmt(value: float) -> str:
    return f"{value:g}"


def _wrong_value(value: float) -> float:
    changed = value * 0.4 if value >= 1 else value * 3
    return round(changed, 1) if changed >= 1 else round(changed, 2)


def _shifted_band(lo: int) -> str:
    new = lo - 30 if lo >= 50 else lo + 30
    return f"{new}-{new + 9}"


def prepare_source(case: TextCase, work_dir: str | Path) -> tuple[str, dict[str, Any]]:
    """Run one case through Parser, Privacy and Data Preparation (no model) and return
    the source text the judge reads plus the structured data."""
    from .agents.data_preparation import data_preparation_agent
    from .agents.document_parser import document_parser_agent
    from .agents.privacy_protection import privacy_protection_agent
    from .imaging_eval import new_state

    state = new_state([str(make_pdf(case, work_dir))])
    for agent in (document_parser_agent, privacy_protection_agent, data_preparation_agent):
        state = {**state, **agent(state)}
    return dl.build_source(state), state["structured_clinical_data"]


def items_for_case(case: TextCase, case_index: int, source: str, structured: dict[str, Any]) -> list[ClaimItem]:
    labs = list((structured.get("labs") or {}).items())
    items: list[ClaimItem] = []

    def add(kind: str, gold: str, claim: str) -> None:
        n = sum(1 for i in items if i.kind == kind)
        items.append(ClaimItem(f"{case.case_id}:{kind}:{n}", case.case_id, kind, gold, claim, source))

    if labs:
        key, lab = labs[0]
        add("lab_original", dl.SUPPORTED, f"The patient's {_name(key)} is {_fmt(lab['original_value'])} {lab['original_unit']}.")
        add("lab_wrong_value", dl.CONTRADICTED,
            f"The patient's {_name(key)} is {_fmt(_wrong_value(lab['original_value']))} {lab['original_unit']}.")
    if len(labs) > 1:
        key, lab = labs[1]
        add("lab_canonical", dl.SUPPORTED, f"The patient's {_name(key)} is {lab['value']:.1f} {lab['unit']}.")

    band = _BAND.search(source)
    if band:
        lo = int(band.group(1))
        add("age", dl.SUPPORTED, f"The patient is {band.group(1)}-{band.group(2)} years old.")
        add("age_wrong", dl.CONTRADICTED, f"The patient is {_shifted_band(lo)} years old.")

    lowered = source.lower()
    taken = 0
    for offset in range(len(_ABSENT_FACTS)):
        claim, needles = _ABSENT_FACTS[(case_index + offset) % len(_ABSENT_FACTS)]
        if taken < 2 and not any(n in lowered for n in needles):
            add("absent_fact", dl.NOT_ENOUGH, claim)
            taken += 1
    return items


def build_items(cases: tuple[TextCase, ...] = CASES) -> list[ClaimItem]:
    items: list[ClaimItem] = []
    with tempfile.TemporaryDirectory(prefix="glassbox-claim-eval-") as work_dir:
        for index, case in enumerate(cases):
            source, structured = prepare_source(case, work_dir)
            items.extend(items_for_case(case, index, source, structured))
    return items


def write_items(path: str | Path, items: list[ClaimItem]) -> None:
    Path(path).write_text("".join(json.dumps(asdict(i), ensure_ascii=False) + "\n" for i in items), encoding="utf-8")


def load_items(path: str | Path) -> list[ClaimItem]:
    out = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.strip():
            out.append(ClaimItem(**json.loads(line)))
    return out


def sample(items: list[ClaimItem], per_class: int, seed: int = 0) -> list[ClaimItem]:
    """A class-balanced subset, deterministic, spread across cases (for a slow judge)."""
    import random

    rng = random.Random(seed)
    chosen: list[ClaimItem] = []
    for gold in GOLDS:
        pool = [i for i in items if i.gold == gold]
        rng.shuffle(pool)
        chosen.extend(pool[:per_class])
    return sorted(chosen, key=lambda i: i.item_id)


# --- running a backend and scoring ---------------------------------------------------------

def run_backend(items: list[ClaimItem], backend: dl.DecisionBackend, log=print) -> list[dict[str, Any]]:
    """One record per item. A failed call is recorded with its error, never raised."""
    import time

    records = []
    for n, item in enumerate(items, start=1):
        started = time.perf_counter()
        record: dict[str, Any] = {"item_id": item.item_id}
        try:
            record["probabilities"] = backend.decide(item.source, dl.build_question(item.claim), dl.CLAIM_OPTIONS)
        except Exception as exc:  # noqa: BLE001
            record["error"] = f"{type(exc).__name__}: {exc}"
        record["seconds"] = round(time.perf_counter() - started, 3)
        records.append(record)
        log(f"[{n}/{len(items)}] {item.item_id} {record['seconds']}s {record.get('error') or dl.verdict_of(record['probabilities'])}")
    return records


def load_scores(path: str | Path) -> dict[str, dict[str, Any]]:
    out = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.strip():
            rec = json.loads(line)
            out[rec["item_id"]] = rec
    return out


def score(items: list[ClaimItem], scores: dict[str, dict[str, Any]]) -> dict[str, Any]:
    rows = []
    for item in items:
        rec = scores.get(item.item_id)
        if not rec or rec.get("error") or not rec.get("probabilities"):
            continue
        probs = rec["probabilities"]
        pred = max(probs, key=probs.get)
        rows.append((item, pred, probs[pred], rec.get("seconds")))
    n_missing = len(items) - len(rows)

    confusion = {g: {p: 0 for p in GOLDS} for g in GOLDS}
    for item, pred, _, _ in rows:
        confusion[item.gold][pred] += 1

    def rate_block(hits: int, total: int) -> dict[str, Any]:
        return {"n": total, "hits": hits, "rate": _rate(hits, total), "ci95": _ci(hits, total)}

    correct = sum(pred == item.gold for item, pred, _, _ in rows)
    per_class = {g: rate_block(confusion[g][g], sum(confusion[g].values())) for g in GOLDS}
    wrong_gold = [g for g in GOLDS if g != dl.SUPPORTED]
    passed = sum(confusion[g][dl.SUPPORTED] for g in wrong_gold)
    wrong_total = sum(sum(confusion[g].values()) for g in wrong_gold)
    contradicted_wrongly = confusion[dl.SUPPORTED][dl.CONTRADICTED]
    confident = [(i, p) for i, p, mp, _ in rows if mp >= dl.CONFIDENT]
    by_kind: dict[str, dict[str, Any]] = {}
    for kind in sorted({i.kind for i, *_ in rows}):
        members = [(i, p) for i, p, _, _ in rows if i.kind == kind]
        by_kind[kind] = rate_block(sum(p == i.gold for i, p in members), len(members))
    seconds = [s for *_, s in rows if s is not None]
    return {
        "n_items": len(items),
        "n_scored": len(rows),
        "n_errors_or_missing": n_missing,
        "accuracy": rate_block(correct, len(rows)),
        "per_class": per_class,
        "confusion": confusion,
        "false_pass": rate_block(passed, wrong_total),  # a wrong or unsupported claim judged "supported"
        "false_alarm": rate_block(contradicted_wrongly, sum(confusion[dl.SUPPORTED].values())),
        "coverage_at_threshold": rate_block(len(confident), len(rows)),
        "accuracy_when_confident": rate_block(sum(p == i.gold for i, p in confident), len(confident)),
        "by_kind": by_kind,
        "calibration": calibration_from_pairs([(mp, pred == item.gold) for item, pred, mp, _ in rows]),
        "median_seconds": statistics.median(seconds) if seconds else None,
    }


def _pct(v: float | None) -> str:
    return "n/a" if v is None else f"{v * 100:.1f}%"


def _cell(b: dict[str, Any]) -> str:
    ci = b["ci95"]
    return f"{_pct(b['rate'])} ({b['hits']}/{b['n']}; CI {'n/a' if not ci else f'{ci[0] * 100:.0f}-{ci[1] * 100:.0f}%'})"


def render_markdown(result: dict[str, Any], judge: str, meta: dict[str, Any] | None = None) -> str:
    r = result
    lines = [
        f"# Evidence-check test set: {judge}",
        "",
        "> Educational project. Templated claims over 32 synthetic cases; a measure of reading and bookkeeping, not of whether a diagnostic model's reasoning is supported. Read the caveats.",
        "",
        f"Items scored: {r['n_scored']} of {r['n_items']} ({r['n_errors_or_missing']} errored or missing). "
        + (f"Run: {', '.join(f'{k}={v}' for k, v in (meta or {}).items())}." if meta else ""),
        "",
        "| Measure | Result |",
        "|---|---|",
        f"| Accuracy (3-way, argmax) | {_cell(r['accuracy'])} |",
        f"| Right on supported claims | {_cell(r['per_class'][dl.SUPPORTED])} |",
        f"| Right on contradicted claims | {_cell(r['per_class'][dl.CONTRADICTED])} |",
        f"| Right on claims the source is silent about | {_cell(r['per_class'][dl.NOT_ENOUGH])} |",
        f"| **False pass**: a contradicted or unsupported claim judged supported | {_cell(r['false_pass'])} |",
        f"| False alarm: a supported claim judged contradicted | {_cell(r['false_alarm'])} |",
        f"| Confident verdicts (p >= {dl.CONFIDENT}) | {_cell(r['coverage_at_threshold'])} |",
        f"| Accuracy when confident | {_cell(r['accuracy_when_confident'])} |",
        f"| Median seconds per item | {r['median_seconds']} |",
        "",
        "## Confusion (rows = truth, columns = judge)",
        "",
        "| Truth | supported | contradicted | not enough info |",
        "|---|---|---|---|",
    ]
    for gold in GOLDS:
        row = r["confusion"][gold]
        lines.append(f"| {gold} | {row[dl.SUPPORTED]} | {row[dl.CONTRADICTED]} | {row[dl.NOT_ENOUGH]} |")
    lines += ["", "## By claim kind", "", "| Kind | Correct |", "|---|---|"]
    for kind, block in r["by_kind"].items():
        lines.append(f"| {kind} | {_cell(block)} |")
    cal = r["calibration"]
    if cal.get("n"):
        lines += ["", f"Calibration of the top probability: Brier {cal['brier']:.3f}, ECE {cal['ece']:.3f}; mean top probability {cal['mean_confidence']:.2f} vs accuracy {cal['accuracy']:.2f}."]
    lines += [
        "",
        "## Caveats",
        "",
        "- Claims are generated from templates over short synthetic sources, and right answers are true by construction; real evidence bullets are messier.",
        "- Contradicted claims are number and age-band mismatches, which test reading more than clinical judgement.",
        "- 'Not enough information' facts were chosen to be absent from each source by keyword; an unlisted paraphrase could still be present.",
        "- One judge, one prompt format; scores can change with the phrasing of the question and the option order.",
        "",
    ]
    return "\n".join(lines)
