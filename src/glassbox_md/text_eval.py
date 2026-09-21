"""A small text-only evaluation set for the lab/history pipeline.

The imaging eval measures one narrow thing (chest X-ray, pneumonia vs
normal). Most of what this project claims is about the six lab- and
history-driven conditions, so this module holds synthetic cases for those,
each with a known expected answer, plus a scorer and a runner that push every
case through the real six-agent graph exactly as an uploaded PDF would.

What the cases are, and are not:

- Synthetic and invented. No real patient, no real record.
- Written to textbook thresholds (e.g. HbA1c >= 6.5%, TSH well above range
  with matching symptoms) so the expected answer is not in dispute. They were
  written by the project author, not reviewed by a clinician, and they are
  deliberately clean: a model that does well here has cleared an easy bar,
  not shown it can handle messy real charts.
- Four groups: `single` (one condition; top-1 must name it), `comorbid`
  (two conditions; both must appear in the top 3), `control` (normal
  results, no complaint; the top-1 must NOT name a target condition), each
  with its own scoring rule below.

Known effect on these cases: the Privacy agent's date/time recognizer rewrites
ages and durations ("52 year old", "three months") to <DATE_TIME> before the
model sees them, so the model reasons over a history with those details
removed. That is the pipeline as it is, and it is part of what is measured.

Expected values are condition keys from `CONDITIONS`. Matching model text to
a condition is a keyword check (`condition_keys_in`), deliberately strict and
negation-aware like the imaging categorizer: an unrecognised wording counts
as a miss rather than being credited by guesswork.
"""

from __future__ import annotations

import json
import re
import tempfile
import textwrap
import time
from datetime import datetime, timezone
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .imaging_compare import calibration_from_pairs, json_validity, latency
from .imaging_eval import Record, _ci, _fill_record, _is_negated, _rate, append_result, daily_quota_exhausted, new_state

CONDITIONS = (
    "type_2_diabetes",
    "coronary_artery_disease",
    "hyperlipidemia",
    "hypertension",
    "chronic_kidney_disease",
    "hypothyroidism",
)

_PATTERNS: dict[str, re.Pattern[str]] = {
    "type_2_diabetes": re.compile(r"(?<!pre)(?<!pre-)diabet(?:es|ic)|\bt2dm\b|\bniddm\b", re.I),
    "coronary_artery_disease": re.compile(
        r"coronary|ischemic heart|ischaemic heart|\bangina\b|myocardial (?:infarction|ischemia)|\bcad\b", re.I
    ),
    "hyperlipidemia": re.compile(r"hyperlipid|dyslipid|hypercholesterol|hypertriglycerid|lipid disorder", re.I),
    "hypertension": re.compile(r"(?<!pulmonary )(?<!portal )(?<!ocular )hypertension|hypertensive", re.I),
    "chronic_kidney_disease": re.compile(
        r"chronic kidney|chronic renal|\bckd\b|renal (?:insufficiency|failure|impairment)|kidney disease|nephropathy", re.I
    ),
    "hypothyroidism": re.compile(r"hypothyroid|hashimoto|myxed?oedema|myxedema|thyroid (?:hormone )?deficien", re.I),
}
_NORMAL_PATTERN = re.compile(
    r"\bnormal\b|\bunremarkable\b|\bhealthy\b|no (?:acute |significant |apparent |active )*"
    r"(?:abnormalit\w+|disease|condition|pathology|diagnos\w+)|within normal limits",
    re.I,
)


def condition_keys_in(text: str | None) -> set[str]:
    """Which target conditions a piece of model text names (negation-aware)."""
    if not text:
        return set()
    text = text.lower()  # the shared negation cues are lower-case ("no evidence of ...")
    found = set()
    for key, pattern in _PATTERNS.items():
        for match in pattern.finditer(text):
            if not _is_negated(text, match):
                found.add(key)
                break
    return found


def names_no_condition(text: str | None) -> bool:
    return bool(text) and bool(_NORMAL_PATTERN.search(text)) and not condition_keys_in(text)


@dataclass(frozen=True)
class TextCase:
    case_id: str
    group: str  # single | comorbid | control
    history: str
    labs: tuple[tuple[str, float, str], ...]
    expected: tuple[str, ...]  # condition keys; empty for controls
    note: str = ""


def _c(case_id, group, history, labs, expected, note=""):
    return TextCase(case_id, group, history, tuple(labs), tuple(expected), note)


_NORMAL_PANEL = [
    ("Glucose", 88, "mg/dL"),
    ("Total Cholesterol", 172, "mg/dL"),
    ("LDL Cholesterol", 96, "mg/dL"),
    ("HDL Cholesterol", 58, "mg/dL"),
    ("Triglycerides", 110, "mg/dL"),
    ("Creatinine", 0.8, "mg/dL"),
    ("Hemoglobin A1c", 5.2, "%"),
    ("TSH", 2.1, "mIU/L"),
]

CASES: tuple[TextCase, ...] = (
    # --- type 2 diabetes ---------------------------------------------------
    _c("t2d-1", "single", "52 year old with three months of increased thirst, frequent urination and unintended weight loss. Father had diabetes.",
       [("Glucose", 182, "mg/dL"), ("Hemoglobin A1c", 8.4, "%")], ["type_2_diabetes"]),
    _c("t2d-2", "single", "47 year old with obesity, darkened skin folds at the neck and gradual fatigue. No prior blood tests.",
       [("Glucose", 141, "mg/dL"), ("Hemoglobin A1c", 7.2, "%")], ["type_2_diabetes"]),
    _c("t2d-3", "single", "60 year old with blurred vision and slow-healing foot sores. Has not seen a doctor in ten years.",
       [("Glucose", 240, "mg/dL"), ("Hemoglobin A1c", 10.1, "%")], ["type_2_diabetes"]),
    _c("t2d-4", "single", "55 year old, sedentary, body mass index 33, screening visit. Two fasting glucose results on separate days were above 126.",
       [("Glucose", 131, "mg/dL"), ("Hemoglobin A1c", 6.8, "%")], ["type_2_diabetes"]),
    # --- coronary artery disease ------------------------------------------
    _c("cad-1", "single", "58 year old smoker with chest pressure on climbing stairs that eases within minutes of resting. Father had a heart attack at 54.",
       [("Total Cholesterol", 245, "mg/dL"), ("LDL Cholesterol", 165, "mg/dL"), ("HDL Cholesterol", 32, "mg/dL")], ["coronary_artery_disease"]),
    _c("cad-2", "single", "66 year old with a stent placed in the left anterior descending artery after a heart attack two years ago, now with returning exertional chest tightness.",
       [("Total Cholesterol", 190, "mg/dL"), ("LDL Cholesterol", 104, "mg/dL"), ("HDL Cholesterol", 41, "mg/dL")], ["coronary_artery_disease"]),
    _c("cad-3", "single", "62 year old with exertional chest pressure. Treadmill stress test showed ST segment depression at moderate workload.",
       [("Total Cholesterol", 228, "mg/dL"), ("LDL Cholesterol", 148, "mg/dL"), ("HDL Cholesterol", 38, "mg/dL")], ["coronary_artery_disease"]),
    _c("cad-4", "single", "64 year old with exertional shortness of breath and chest discomfort. Coronary calcium score on CT was 480.",
       [("Total Cholesterol", 205, "mg/dL"), ("LDL Cholesterol", 122, "mg/dL"), ("HDL Cholesterol", 44, "mg/dL")], ["coronary_artery_disease"]),
    # --- hyperlipidemia ----------------------------------------------------
    _c("lip-1", "single", "35 year old with no symptoms. Yellow fatty deposits on the Achilles tendons and around the eyelids. No chest pain.",
       [("Total Cholesterol", 340, "mg/dL"), ("LDL Cholesterol", 235, "mg/dL"), ("Triglycerides", 150, "mg/dL")], ["hyperlipidemia"]),
    _c("lip-2", "single", "44 year old routine screening visit, feels well, no chest pain or shortness of breath.",
       [("Total Cholesterol", 285, "mg/dL"), ("LDL Cholesterol", 192, "mg/dL"), ("HDL Cholesterol", 48, "mg/dL")], ["hyperlipidemia"]),
    _c("lip-3", "single", "50 year old with no symptoms found to have very high fats on a routine panel. Fasting sample.",
       [("Total Cholesterol", 260, "mg/dL"), ("Triglycerides", 640, "mg/dL"), ("Glucose", 96, "mg/dL")], ["hyperlipidemia"]),
    _c("lip-4", "single", "30 year old, healthy, asymptomatic. A sibling was found to have very high cholesterol at age 28.",
       [("Total Cholesterol", 298, "mg/dL"), ("LDL Cholesterol", 198, "mg/dL"), ("HDL Cholesterol", 52, "mg/dL")], ["hyperlipidemia"]),
    # --- hypertension (blood pressure is free text: no structured lab) -----
    _c("htn-1", "single", "54 year old with morning headaches. Blood pressure 168/102 on three separate visits over two months.",
       [("Glucose", 92, "mg/dL"), ("Creatinine", 0.9, "mg/dL")], ["hypertension"]),
    _c("htn-2", "single", "49 year old with no complaints. Home readings average 152/96 over two weeks, confirmed in clinic at 150/94.",
       [("Glucose", 90, "mg/dL"), ("Total Cholesterol", 188, "mg/dL")], ["hypertension"]),
    _c("htn-3", "single", "61 year old with occasional dizziness. Blood pressure has been persistently 158/98 across four visits.",
       [("Creatinine", 0.9, "mg/dL"), ("Glucose", 95, "mg/dL")], ["hypertension"]),
    _c("htn-4", "single", "45 year old, a routine visit. Blood pressure 146/92 at three visits a month apart. Otherwise well.",
       [("Glucose", 89, "mg/dL"), ("Hemoglobin A1c", 5.3, "%")], ["hypertension"]),
    # --- chronic kidney disease -------------------------------------------
    _c("ckd-1", "single", "68 year old with foamy urine and ankle swelling. Estimated GFR 28 and falling over the past year.",
       [("Creatinine", 2.4, "mg/dL"), ("Glucose", 98, "mg/dL")], ["chronic_kidney_disease"]),
    _c("ckd-2", "single", "59 year old with persistent protein in the urine for more than three months and slowly rising creatinine over six months.",
       [("Creatinine", 1.9, "mg/dL"), ("Glucose", 94, "mg/dL")], ["chronic_kidney_disease"]),
    _c("ckd-3", "single", "72 year old with fatigue, poor appetite and reduced urine output. Estimated GFR 19, stable over eight months.",
       [("Creatinine", 3.1, "mg/dL"), ("Glucose", 101, "mg/dL")], ["chronic_kidney_disease"]),
    _c("ckd-4", "single", "63 year old with persistent albumin in the urine for four months. Estimated GFR 41 on two occasions.",
       [("Creatinine", 1.6, "mg/dL"), ("Glucose", 97, "mg/dL")], ["chronic_kidney_disease"]),
    # --- hypothyroidism ----------------------------------------------------
    _c("thy-1", "single", "41 year old with fatigue, feeling cold all the time, weight gain and constipation over several months.",
       [("TSH", 18.5, "mIU/L"), ("Glucose", 90, "mg/dL")], ["hypothyroidism"]),
    _c("thy-2", "single", "36 year old with dry skin, thinning hair and low energy. Mother takes thyroid medication.",
       [("TSH", 9.8, "mIU/L"), ("Glucose", 87, "mg/dL")], ["hypothyroidism"]),
    _c("thy-3", "single", "70 year old with slow heart rate, puffy face, hoarse voice and marked fatigue.",
       [("TSH", 42.0, "mIU/L"), ("Total Cholesterol", 230, "mg/dL")], ["hypothyroidism"]),
    _c("thy-4", "single", "33 year old with tiredness and a firm, enlarged thyroid gland. Sister has Hashimoto thyroiditis.",
       [("TSH", 7.1, "mIU/L"), ("Glucose", 85, "mg/dL")], ["hypothyroidism"]),
    # --- comorbid: both must appear in the top 3 --------------------------
    _c("com-1", "comorbid", "56 year old with thirst, frequent urination, and headaches. Blood pressure 162/100 at three visits.",
       [("Glucose", 210, "mg/dL"), ("Hemoglobin A1c", 9.1, "%")], ["type_2_diabetes", "hypertension"]),
    _c("com-2", "comorbid", "64 year old, diabetic for twelve years, now with persistent protein in the urine and estimated GFR 32.",
       [("Glucose", 172, "mg/dL"), ("Hemoglobin A1c", 8.0, "%"), ("Creatinine", 2.1, "mg/dL")], ["type_2_diabetes", "chronic_kidney_disease"]),
    _c("com-3", "comorbid", "57 year old with exertional chest pressure that eases with rest, and a very high cholesterol found last year.",
       [("Total Cholesterol", 310, "mg/dL"), ("LDL Cholesterol", 212, "mg/dL"), ("HDL Cholesterol", 34, "mg/dL")], ["coronary_artery_disease", "hyperlipidemia"]),
    _c("com-4", "comorbid", "48 year old with fatigue, cold intolerance and weight gain. Cholesterol was normal two years ago.",
       [("TSH", 15.0, "mIU/L"), ("Total Cholesterol", 265, "mg/dL"), ("LDL Cholesterol", 190, "mg/dL")], ["hypothyroidism", "hyperlipidemia"]),
    # --- controls: normal results, nothing wrong --------------------------
    _c("ctl-1", "control", "34 year old attending a routine annual physical. No complaints.", _NORMAL_PANEL, []),
    _c("ctl-2", "control", "27 year old with a mild ankle sprain from a fall while running. Otherwise healthy.", _NORMAL_PANEL, []),
    _c("ctl-3", "control", "41 year old with seasonal allergies and a runny nose in spring. No other problems.", _NORMAL_PANEL, []),
    _c("ctl-4", "control", "38 year old attending an employer wellness check. No symptoms, no medical history.", _NORMAL_PANEL, []),
)


def case_ids() -> list[str]:
    return [c.case_id for c in CASES]


# --- turning a case into an uploaded PDF ------------------------------------

def make_pdf(case: TextCase, dest_dir: str | Path) -> Path:
    """Render the case as the kind of PDF a user would upload: a history
    paragraph and a `Test | Result | Units` lab table."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas
    from reportlab.platypus import Table, TableStyle

    path = Path(dest_dir) / f"{case.case_id}.pdf"
    pdf = canvas.Canvas(str(path), pagesize=letter)
    y = 750
    for line in textwrap.wrap("History: " + case.history, width=88):
        pdf.drawString(72, y, line)
        y -= 18
    rows = [["Test", "Result", "Units"]] + [[name, str(value), unit] for name, value, unit in case.labs]
    table = Table(rows)
    table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)]))
    _, height = table.wrapOn(pdf, 400, 400)
    table.drawOn(pdf, 72, max(y - 24 - height, 40))
    pdf.save()
    return path


# --- scoring -----------------------------------------------------------------

def score_record(case: TextCase, record: Record) -> dict[str, Any]:
    """How one finished record fares against its case. Errored records score
    as not answered (never as wrong or right)."""
    if record.get("error"):
        return {"answered": False}
    top1_keys = condition_keys_in(record.get("top1_condition"))
    top3_keys = set()
    for text in record.get("top3") or []:
        top3_keys |= condition_keys_in(text)
    expected = set(case.expected)

    if case.group == "control":
        alarm = bool(top1_keys)
        return {"answered": True, "correct": not alarm, "false_alarm": alarm, "top3_hit": None}
    if case.group == "comorbid":
        return {
            "answered": True,
            "correct": expected <= top3_keys,  # both conditions somewhere in the top 3
            "top1_in_expected": bool(top1_keys & expected),
            "top3_hit": expected <= top3_keys,
        }
    return {
        "answered": True,
        "correct": expected <= top1_keys,  # naming an extra condition alongside is not a miss
        "top3_hit": expected <= top3_keys,
    }


# --- running -----------------------------------------------------------------

def _blank(case: TextCase) -> Record:
    return {
        "case_id": case.case_id,
        "group": case.group,
        "expected": list(case.expected),
        "top1_condition": None,
        "top1_likelihood": None,
        "overall_confidence": None,
        "top3": [],
        "abstained": None,
        "disagreement_flagged": None,
        "stage_status": {},
        "error": None,
        "wall_seconds": None,
        "model_name": None,
        "model_attempts": None,
        "invalid_responses": None,
    }


def run_case(graph: Any, case: TextCase, work_dir: str | Path) -> Record:
    """Run one case through the compiled pipeline. Never raises."""
    from .agents import diagnostic_prediction as dp

    record = _blank(case)
    started = time.perf_counter()
    try:
        pdf = make_pdf(case, work_dir)
    except Exception as exc:  # noqa: BLE001
        record["error"] = f"could not build the case PDF: {type(exc).__name__}: {exc}"
        record["wall_seconds"] = round(time.perf_counter() - started, 2)
        return record
    dp.reset_call_stats()
    try:
        final_state = graph.invoke(new_state([str(pdf)]))
    except Exception as exc:  # noqa: BLE001
        record["error"] = f"{type(exc).__name__}: {exc}"
    else:
        _fill_record(record, final_state)
    if dp.LAST_CALL_STATS["attempts"]:
        record["model_attempts"] = dp.LAST_CALL_STATS["attempts"]
        record["invalid_responses"] = dp.LAST_CALL_STATS["invalid_responses"]
    record["wall_seconds"] = round(time.perf_counter() - started, 2)
    pdf.unlink(missing_ok=True)
    return record


def load_records(path: str | Path) -> list[Record]:
    """One record per case_id, the last written winning (so a re-run of an
    errored case supersedes it). Unreadable lines are skipped."""
    latest: dict[str, Record] = {}
    for raw in Path(path).read_bytes().split(b"\n"):
        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        try:
            record = json.loads(line)
            latest[record["case_id"]] = record
        except (json.JSONDecodeError, KeyError, TypeError):
            continue
    return list(latest.values())


def completed_ids(path: str | Path, retry_errors: bool = False) -> set[str]:
    path = Path(path)
    if not path.exists():
        return set()
    return {r["case_id"] for r in load_records(path) if not (retry_errors and r.get("error"))}


def run_eval(
    out_path: str | Path,
    *,
    graph: Any,
    skip=(),
    tags=None,
    sleep_seconds: float = 2.0,
    log=print,
    cases: tuple[TextCase, ...] = CASES,
) -> int:
    skipped = set(skip)
    pending = [c for c in cases if c.case_id not in skipped]
    with tempfile.TemporaryDirectory(prefix="glassbox-text-eval-") as work_dir:
        for position, case in enumerate(pending, start=1):
            record = run_case(graph, case, work_dir)
            record.update(tags or {})
            record["run_at"] = datetime.now(timezone.utc).isoformat()
            append_result(out_path, record)
            if daily_quota_exhausted(record.get("error")):
                log("Provider daily quota exhausted -- stopping. Re-run with --retry-errors once it resets.")
                return position
            try:
                log(f"[{position}/{len(pending)}] {case.case_id} {record['wall_seconds']}s -- {record['error'] or record['top1_condition']!r}")
            except Exception:  # noqa: BLE001 -- logging must never abort a long run
                log(f"[{position}/{len(pending)}] {case.case_id} finished")
            if position < len(pending):
                time.sleep(sleep_seconds)
    return len(pending)


def summarize(records: list[Record], cases: tuple[TextCase, ...] = CASES) -> dict[str, Any]:
    by_id = {c.case_id: c for c in cases}
    rows = [(by_id[r["case_id"]], r, score_record(by_id[r["case_id"]], r)) for r in records if r.get("case_id") in by_id]
    answered = [(c, r, sc) for c, r, sc in rows if sc["answered"]]

    def block(group: str | None) -> dict[str, Any]:
        members = [(c, r, sc) for c, r, sc in answered if group is None or c.group == group]
        correct = sum(sc["correct"] for _, _, sc in members)
        top3 = [sc["top3_hit"] for _, _, sc in members if sc.get("top3_hit") is not None]
        return {
            "n": len(members),
            "n_correct": correct,
            "accuracy": _rate(correct, len(members)),
            "accuracy_ci95": _ci(correct, len(members)),
            "n_top3_hit": sum(top3),
            "n_top3_total": len(top3),
        }

    per_condition = {}
    for key in CONDITIONS:
        members = [(c, sc) for c, _, sc in answered if c.group == "single" and c.expected == (key,)]
        per_condition[key] = {"n": len(members), "n_correct": sum(sc["correct"] for _, sc in members)}

    abstained = [r for _, r, _ in answered if r.get("abstained")]
    pairs = [(r["overall_confidence"], sc["correct"]) for _, r, sc in answered if r.get("overall_confidence") is not None]
    controls = [(c, sc) for c, _, sc in answered if c.group == "control"]
    return {
        "n_cases": len(rows),
        "n_errors": len(rows) - len(answered),
        "overall": block(None),
        "single": block("single"),
        "comorbid": block("comorbid"),
        "control": block("control"),
        "n_control_false_alarms": sum(sc["false_alarm"] for _, sc in controls),
        "per_condition": per_condition,
        "n_abstained": len(abstained),
        "abstention_rate": _rate(len(abstained), len(answered)),
        "abstention_rate_ci95": _ci(len(abstained), len(answered)),
        "calibration": calibration_from_pairs(pairs),
        "json": json_validity([r for _, r, _ in rows]),
        "latency": latency([r for _, r, _ in rows]),
        "models": sorted({r.get("model_name") for _, r, _ in answered if r.get("model_name")}),
    }


def _pct(v: float | None) -> str:
    return "n/a" if v is None else f"{v * 100:.1f}%"


def _ci_text(ci: list[float] | None) -> str:
    return "n/a" if not ci else f"{ci[0] * 100:.0f}-{ci[1] * 100:.0f}%"


def render_markdown(summary: dict[str, Any]) -> str:
    s = summary

    def line(name: str, b: dict[str, Any]) -> str:
        return f"| {name} | {_pct(b['accuracy'])} ({b['n_correct']}/{b['n']}) | {_ci_text(b['accuracy_ci95'])} |"

    cal = s["calibration"]
    j = s["json"]
    lat = s["latency"]
    models = ", ".join(f"`{m}`" for m in s["models"]) or "not recorded"
    lines = [
        "# Text-only evaluation: six lab/history conditions",
        "",
        "> Educational project, not clinical validation. Synthetic cases written to textbook thresholds by the project author, not reviewed by a clinician; deliberately clean.",
        "",
        f"Cases scored: {s['n_cases'] - s['n_errors']} of {s['n_cases']} ({s['n_errors']} errored, not counted as right or wrong). Model(s): {models}.",
        "",
        "| Group (rule) | Correct | 95% CI (Wilson) |",
        "|---|---|---|",
        line("All cases", s["overall"]),
        line("Single condition (top-1 names it)", s["single"]),
        line("Comorbid (both in top 3)", s["comorbid"]),
        line("Control, normal (top-1 names no condition)", s["control"]),
        "",
        f"Control false alarms: {s['n_control_false_alarms']} of {s['control']['n']}. "
        f"Abstained: {s['n_abstained']} ({_pct(s['abstention_rate'])}, CI {_ci_text(s['abstention_rate_ci95'])}).",
        "",
        "Per condition (single cases): "
        + "; ".join(f"{k.replace('_', ' ')} {v['n_correct']}/{v['n']}" for k, v in s["per_condition"].items()),
        "",
    ]
    if cal.get("n"):
        lines += [
            f"Calibration: Brier {cal['brier']:.3f}, ECE {cal['ece']:.3f}; mean confidence {cal['mean_confidence']:.2f} "
            f"vs accuracy {cal['accuracy']:.2f}; {cal['n_high_confidence_wrong']} wrong of {cal['n_high_confidence']} at confidence >= 0.8.",
            "",
        ]
    lines += [
        f"JSON validity: first-try clean {_pct(j['clean_rate'])} ({j['n_clean_first_time']}/{j['n_tracked']}); "
        f"answered {_pct(j['answered_rate'])} ({j['n_answered']}/{j['n_cases']}).",
        "",
    ]
    if lat["n"]:
        lines += [f"Latency: median {lat['median']:.1f}s (IQR {lat['q1']:.1f}-{lat['q3']:.1f}s, max {lat['max']:.1f}s).", ""]
    lines += [
        "## Caveats",
        "",
        "- Keyword matching of model text to conditions is strict and negation-aware; an unfamiliar wording counts as a miss.",
        "- Small clean synthetic set: intervals are wide and a good score here says nothing about messy real charts.",
        "- The Privacy agent replaces ages and durations with <DATE_TIME> before the model sees the history; that loss is part of the pipeline being measured.",
        "- Hypertension has no structured lab; its cases carry blood pressure in the history text only.",
        "",
    ]
    return "\n".join(lines)
