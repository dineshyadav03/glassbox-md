"""Data Preparation Agent.

Third in pipeline order (Parser -> Privacy -> Prep -> RAG -> Prediction ->
Explainability) but built first, per the roadmap: it's fully deterministic,
touches no external API or model, and was rated the lowest-risk agent in
the whole pipeline -- a good place to prove the state-schema and node
conventions from Phase 0 actually work before tackling anything harder.

Scope for the MVP: unit conversion and terminology normalization for two
cardiometabolic conditions -- type 2 diabetes and coronary artery disease
-- chosen to match the public datasets already planned for the RAG and
SHAP-demo phases, rather than trying to cover every condition and lab
panel that might eventually show up.

Expected shape of `anonymized_patient_data` (the Privacy Protection
Agent's output, which doesn't exist yet as of Phase 1 -- this is the
contract Phase 3 needs to produce):

    {
        "labs": {
            "glucose": {"value": 126, "unit": "mg/dL"},
            "hemoglobin_a1c": {"value": 7.2, "unit": "%"},
            ...
        },
        "history_text": "Pt has T2DM and HTN, presents with...",
    }

Lab test names are matched case-insensitively with spaces treated as
underscores, so "Total Cholesterol" and "total_cholesterol" are the same
key.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, TypedDict

from ..audit import audit_entry
from ..state import MedicalPipelineState, update_stage_status

STAGE_NAME = "data_preparation"


class UnknownLabTestError(ValueError):
    """Raised when a lab test name isn't in LAB_CONVERSIONS -- this MVP's
    scope is two conditions' worth of labs, not every test that exists."""


class UnsupportedUnitError(ValueError):
    """Raised when a lab value's unit is neither the canonical unit nor the
    one conventional (US) alternative this module knows how to convert."""


class LabValue(TypedDict):
    value: float
    unit: str
    original_value: float
    original_unit: str
    plausible: bool


@dataclass(frozen=True)
class LabConversion:
    canonical_unit: str
    us_unit: str
    us_to_canonical: Callable[[float], float]
    # A wide sanity range in the canonical unit, for catching corrupted
    # data or a unit mix-up (e.g. an mmol/L number recorded as mg/dL) --
    # NOT a clinical reference range. This agent flags plausibility, it
    # doesn't interpret results.
    plausible_range: tuple[float, float]


# Conversion factors are standard clinical-chemistry constants (mg/dL ->
# mmol/L for glucose divides by the molar mass of glucose, 18.0182 g/mol;
# cholesterol and triglycerides similarly by their molar masses; HbA1c's
# NGSP-%-to-IFCC-mmol/mol formula is the one published by the NGSP).
LAB_CONVERSIONS: dict[str, LabConversion] = {
    "glucose": LabConversion("mmol/L", "mg/dL", lambda v: v / 18.0182, (1.0, 60.0)),
    "total_cholesterol": LabConversion("mmol/L", "mg/dL", lambda v: v / 38.67, (1.0, 20.0)),
    "ldl_cholesterol": LabConversion("mmol/L", "mg/dL", lambda v: v / 38.67, (0.5, 15.0)),
    "hdl_cholesterol": LabConversion("mmol/L", "mg/dL", lambda v: v / 38.67, (0.2, 5.0)),
    "triglycerides": LabConversion("mmol/L", "mg/dL", lambda v: v / 88.57, (0.2, 40.0)),
    "creatinine": LabConversion("µmol/L", "mg/dL", lambda v: v * 88.4, (20.0, 2000.0)),
    "hemoglobin_a1c": LabConversion(
        "mmol/mol", "%", lambda v: (v - 2.15) * 10.929, (20.0, 200.0)
    ),
}

# Abbreviations and synonyms -> the one canonical term this project uses.
# Longer phrases are matched before their substrings (see normalize_
# terminology), so "type 2 diabetes mellitus" doesn't get half-replaced by
# a shorter entry first.
TERMINOLOGY_MAP: dict[str, str] = {
    "t2dm": "type 2 diabetes",
    "type 2 diabetes mellitus": "type 2 diabetes",
    "diabetes mellitus type 2": "type 2 diabetes",
    "niddm": "type 2 diabetes",
    "cad": "coronary artery disease",
    "ischemic heart disease": "coronary artery disease",
    "ihd": "coronary artery disease",
    "mi": "myocardial infarction",
    "heart attack": "myocardial infarction",
    "htn": "hypertension",
    "hld": "hyperlipidemia",
    "dyslipidemia": "hyperlipidemia",
    "a1c": "hemoglobin a1c",
    "hba1c": "hemoglobin a1c",
    "glycated hemoglobin": "hemoglobin a1c",
    "glycosylated hemoglobin": "hemoglobin a1c",
}

_TERMINOLOGY_PATTERN = re.compile(
    r"\b(?:" + "|".join(re.escape(k) for k in sorted(TERMINOLOGY_MAP, key=len, reverse=True)) + r")\b",
    re.IGNORECASE,
)


def convert_lab_value(test_name: str, value: float | None, unit: str) -> LabValue | None:
    """Convert one lab value to its canonical unit. Returns None for a
    missing value (nothing to convert, not an error) instead of raising."""
    if value is None:
        return None

    key = test_name.strip().lower().replace(" ", "_")
    conversion = LAB_CONVERSIONS.get(key)
    if conversion is None:
        raise UnknownLabTestError(
            f"no conversion registered for lab test {test_name!r} -- "
            f"known tests: {sorted(LAB_CONVERSIONS)}"
        )

    unit_normalized = unit.strip()
    if unit_normalized == conversion.canonical_unit:
        canonical_value = float(value)  # already normalized -- idempotent
    elif unit_normalized == conversion.us_unit:
        canonical_value = conversion.us_to_canonical(value)
    else:
        raise UnsupportedUnitError(
            f"{test_name!r} given in {unit!r}, expected "
            f"{conversion.canonical_unit!r} or {conversion.us_unit!r}"
        )

    lo, hi = conversion.plausible_range
    return LabValue(
        value=round(canonical_value, 3),
        unit=conversion.canonical_unit,
        original_value=float(value),
        original_unit=unit_normalized,
        plausible=lo <= canonical_value <= hi,
    )


def normalize_lab_panel(labs: dict[str, dict[str, Any]]) -> dict[str, LabValue]:
    """Convert every lab in `labs` to its canonical unit. Missing values
    (value is None, or absent) are skipped rather than raising -- a
    partial panel is normal clinical input, not an error condition."""
    normalized: dict[str, LabValue] = {}
    for test_name, entry in labs.items():
        value = entry.get("value")
        unit = entry.get("unit", "")
        lab_value = convert_lab_value(test_name, value, unit)
        if lab_value is not None:
            normalized[test_name] = lab_value
    return normalized


def normalize_terminology(text: str) -> str:
    """Replace known abbreviations/synonyms in free text with the one
    canonical term this project uses for each condition. Case-insensitive;
    leaves anything it doesn't recognize untouched."""
    if not text:
        return text
    return _TERMINOLOGY_PATTERN.sub(lambda m: TERMINOLOGY_MAP[m.group(0).lower()], text)


def data_preparation_agent(state: MedicalPipelineState) -> dict[str, Any]:
    """The LangGraph node. Reads `anonymized_patient_data`, writes
    `structured_clinical_data`, and always returns a `stage_status` and
    `audit_log` update -- on the failure path too, so a bad upstream
    contract (an unknown lab test, an unsupported unit) is a recorded,
    routable `failed` status instead of an uncaught exception that kills
    the graph.
    """
    patient_data = state.get("anonymized_patient_data") or {}
    raw_labs = patient_data.get("labs", {})
    raw_history_text = patient_data.get("history_text", "")

    try:
        normalized_labs = normalize_lab_panel(raw_labs)
    except (UnknownLabTestError, UnsupportedUnitError) as exc:
        return {
            "stage_status": update_stage_status(
                state, STAGE_NAME, {"status": "failed", "message": str(exc)}
            ),
            "audit_log": [audit_entry(STAGE_NAME, f"failed: {exc}")],
        }

    implausible = [name for name, lab in normalized_labs.items() if not lab["plausible"]]
    normalized_history = normalize_terminology(raw_history_text)

    structured_clinical_data = {
        "labs": normalized_labs,
        "history_text": normalized_history,
    }

    if implausible:
        status = {
            "status": "needs_review",
            "message": f"implausible value(s) for: {', '.join(sorted(implausible))}",
        }
        summary = (
            f"normalized {len(normalized_labs)} lab value(s); "
            f"flagged {len(implausible)} as implausible"
        )
    else:
        status = {"status": "ok", "message": None}
        summary = f"normalized {len(normalized_labs)} lab value(s)"

    return {
        "structured_clinical_data": structured_clinical_data,
        "stage_status": update_stage_status(state, STAGE_NAME, status),
        "audit_log": [audit_entry(STAGE_NAME, summary)],
    }
