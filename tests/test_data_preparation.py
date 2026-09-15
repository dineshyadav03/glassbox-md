"""Tests for the Data Preparation Agent: unit conversion, terminology
normalization, and the three edge cases called out for this phase --
missing values, out-of-range values, and already-normalized input.
"""

import pytest

from glassbox_md.agents.data_preparation import (
    UnknownLabTestError,
    UnsupportedUnitError,
    convert_lab_value,
    data_preparation_agent,
    normalize_lab_panel,
    normalize_terminology,
)
from glassbox_md.state import new_stage_status


# --- convert_lab_value -------------------------------------------------

def test_converts_conventional_us_units_to_canonical():
    result = convert_lab_value("glucose", 126, "mg/dL")
    assert result["unit"] == "mmol/L"
    assert result["value"] == pytest.approx(6.994, abs=0.01)
    assert result["plausible"] is True


def test_already_canonical_input_is_idempotent():
    """Already-normalized input: a value already in mmol/L should pass
    through unchanged, not get converted a second time."""
    result = convert_lab_value("glucose", 7.0, "mmol/L")
    assert result["value"] == 7.0
    assert result["unit"] == "mmol/L"
    assert result["original_unit"] == "mmol/L"


def test_missing_value_returns_none_not_an_error():
    assert convert_lab_value("glucose", None, "mg/dL") is None


def test_unit_mixup_is_flagged_implausible():
    """A realistic data-entry error: an mmol/L-scale number recorded under
    the mg/dL unit. The conversion still runs, but the result should be
    flagged, not silently accepted as a valid value."""
    result = convert_lab_value("glucose", 7, "mg/dL")
    assert result["plausible"] is False


def test_unknown_lab_test_raises():
    with pytest.raises(UnknownLabTestError):
        convert_lab_value("vitamin_d", 30, "ng/mL")


def test_unsupported_unit_raises():
    with pytest.raises(UnsupportedUnitError):
        convert_lab_value("glucose", 7, "g/L")


def test_test_name_matching_is_case_and_space_insensitive():
    result = convert_lab_value("Total Cholesterol", 200, "mg/dL")
    assert result["unit"] == "mmol/L"


def test_tsh_canonical_and_us_unit_are_numerically_identical():
    """Unlike glucose/cholesterol's real molar-mass conversions, mIU/L and
    µIU/mL are numerically identical by unit definition (micro per mL =
    milli per L) -- both spellings of the same reading should produce
    the identical canonical value, not just a converted one."""
    canonical = convert_lab_value("tsh", 2.5, "mIU/L")
    us = convert_lab_value("tsh", 2.5, "µIU/mL")
    assert canonical["value"] == us["value"] == 2.5
    assert canonical["unit"] == us["unit"] == "mIU/L"


def test_tsh_suppressed_value_flagged_implausible():
    result = convert_lab_value("tsh", 0.001, "mIU/L")
    assert result["plausible"] is False


# --- normalize_lab_panel ------------------------------------------------

def test_panel_skips_missing_values_without_raising():
    panel = {
        "glucose": {"value": 126, "unit": "mg/dL"},
        "creatinine": {"value": None, "unit": "mg/dL"},
    }
    normalized = normalize_lab_panel(panel)
    assert "glucose" in normalized
    assert "creatinine" not in normalized


# --- normalize_terminology ----------------------------------------------

def test_replaces_known_abbreviations():
    text = "Pt has T2DM and HTN, hx of MI."
    result = normalize_terminology(text)
    assert "type 2 diabetes" in result
    assert "hypertension" in result
    assert "myocardial infarction" in result


def test_terminology_is_case_insensitive():
    assert normalize_terminology("history of cad") == "history of coronary artery disease"


def test_empty_text_returned_unchanged():
    assert normalize_terminology("") == ""


def test_unrecognized_terms_left_alone():
    text = "Patient reports mild headache."
    assert normalize_terminology(text) == text


def test_replaces_ckd_and_hypothyroid_synonyms():
    text = "Pt has CKD, hypothyroid on levothyroxine."
    result = normalize_terminology(text)
    assert "chronic kidney disease" in result
    assert "hypothyroidism" in result


# --- data_preparation_agent (the LangGraph node) -------------------------

def _base_state(**overrides):
    state = {
        "raw_input_paths": [],
        "anonymized_patient_data": {},
        "stage_status": new_stage_status(),
        "audit_log": [],
    }
    state.update(overrides)
    return state


def test_agent_happy_path_produces_structured_data():
    state = _base_state(
        anonymized_patient_data={
            "labs": {"glucose": {"value": 126, "unit": "mg/dL"}},
            "history_text": "Pt has T2DM.",
        }
    )
    result = data_preparation_agent(state)
    assert result["structured_clinical_data"]["labs"]["glucose"]["unit"] == "mmol/L"
    assert "type 2 diabetes" in result["structured_clinical_data"]["history_text"]
    assert result["stage_status"]["data_preparation"]["status"] == "ok"
    assert len(result["audit_log"]) == 1


def test_agent_flags_implausible_values_as_needs_review():
    state = _base_state(
        anonymized_patient_data={"labs": {"glucose": {"value": 7, "unit": "mg/dL"}}}
    )
    result = data_preparation_agent(state)
    assert result["stage_status"]["data_preparation"]["status"] == "needs_review"


def test_agent_records_failure_on_unknown_test_without_raising():
    state = _base_state(
        anonymized_patient_data={"labs": {"vitamin_d": {"value": 30, "unit": "ng/mL"}}}
    )
    result = data_preparation_agent(state)
    assert result["stage_status"]["data_preparation"]["status"] == "failed"


def test_agent_preserves_other_stages_status():
    """Regression test for the stage_status merge bug: this agent must not
    wipe out a status some other stage already recorded."""
    state = _base_state()
    state["stage_status"]["document_parser"] = {"status": "ok", "message": None}

    result = data_preparation_agent(state)

    assert result["stage_status"]["document_parser"] == {"status": "ok", "message": None}
    assert result["stage_status"]["data_preparation"]["status"] == "ok"
