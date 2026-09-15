"""Tests for local case persistence (case_store.py) -- real sqlite against
a pytest tmp_path, no mocking, matching this project's established style
for testing on-disk persistence (see test_medical_knowledge_rag.py's
ChromaDB tests).
"""

import sqlite3

import pytest

from glassbox_md.case_store import confirm_case, get_case, list_recent_cases, save_case
from glassbox_md.state import PrivacyBoundaryViolation


def _valid_report():
    return {
        "narrative": "Test narrative.",
        "citations": [],
        "confidence": 0.8,
        "shap_reference": None,
        "disagreement_flagged": False,
        "clinician_confirmed": False,
    }


def _valid_state(**overrides):
    state = {
        "raw_input_paths": [],
        "anonymized_patient_data": {"age_band": "40-49"},
        "structured_clinical_data": {"history_text": "Patient has type 2 diabetes."},
        "diagnostic_prediction_result": {"differential": [], "overall_confidence": 0.8},
        "final_explainable_report": _valid_report(),
        "audit_log": [{"stage": "explainability", "summary": "assembled report", "timestamp": "2026-01-01T00:00:00+00:00"}],
    }
    state.update(overrides)
    return state


def _row_count(db_path):
    conn = sqlite3.connect(db_path)
    try:
        return conn.execute("SELECT COUNT(*) FROM cases").fetchone()[0]
    except sqlite3.OperationalError:
        return 0  # table doesn't exist yet -- zero rows either way
    finally:
        conn.close()


# --- save_case ---------------------------------------------------------

def test_save_case_returns_a_case_id_and_persists_it(tmp_path):
    db_path = str(tmp_path / "cases.db")
    case_id = save_case(_valid_state(), db_path=db_path)

    case = get_case(case_id, db_path=db_path)
    assert case is not None
    assert case["case_id"] == case_id
    assert case["confirmed"] is False
    assert case["final_explainable_report"]["narrative"] == "Test narrative."


def test_save_case_raises_on_privacy_boundary_violation(tmp_path):
    db_path = str(tmp_path / "cases.db")
    state = _valid_state(raw_input_paths=["patient_123.dcm"])  # leaked alongside anonymized data

    with pytest.raises(PrivacyBoundaryViolation):
        save_case(state, db_path=db_path)

    assert _row_count(db_path) == 0  # fail-closed, not a partial write


def test_save_case_raises_without_a_final_report(tmp_path):
    db_path = str(tmp_path / "cases.db")
    state = _valid_state(final_explainable_report=None)

    with pytest.raises(ValueError):
        save_case(state, db_path=db_path)

    assert _row_count(db_path) == 0


def test_save_case_never_persists_raw_or_pre_redaction_fields(tmp_path):
    db_path = str(tmp_path / "cases.db")
    state = _valid_state(
        extracted_document_content={"documents": [{"text": "Jane Doe, DOB 1970-01-01"}]},
    )
    case_id = save_case(state, db_path=db_path)

    conn = sqlite3.connect(db_path)
    raw_json = conn.execute("SELECT report_json FROM cases WHERE case_id = ?", (case_id,)).fetchone()[0]
    conn.close()

    for forbidden in ("raw_input_paths", "extracted_document_content", "anonymized_patient_data", "structured_clinical_data", "Jane Doe"):
        assert forbidden not in raw_json


def test_save_case_creates_parent_directory_if_missing(tmp_path):
    db_path = str(tmp_path / "nested" / "dir" / "cases.db")
    case_id = save_case(_valid_state(), db_path=db_path)
    assert get_case(case_id, db_path=db_path) is not None


# --- confirm_case --------------------------------------------------------

def test_confirm_case_sets_confirmed_and_timestamp(tmp_path):
    db_path = str(tmp_path / "cases.db")
    case_id = save_case(_valid_state(), db_path=db_path)

    confirmed_at = confirm_case(case_id, db_path=db_path)

    assert confirmed_at is not None
    case = get_case(case_id, db_path=db_path)
    assert case["confirmed"] is True
    assert case["confirmed_at"] == confirmed_at


def test_confirm_case_is_idempotent_and_keeps_first_timestamp(tmp_path):
    db_path = str(tmp_path / "cases.db")
    case_id = save_case(_valid_state(), db_path=db_path)

    first = confirm_case(case_id, db_path=db_path)
    second = confirm_case(case_id, db_path=db_path)

    assert first == second


def test_confirm_case_returns_none_for_unknown_case_id(tmp_path):
    db_path = str(tmp_path / "cases.db")
    assert confirm_case("does-not-exist", db_path=db_path) is None


# --- get_case --------------------------------------------------------------

def test_get_case_returns_none_for_unknown_case_id(tmp_path):
    db_path = str(tmp_path / "cases.db")
    save_case(_valid_state(), db_path=db_path)
    assert get_case("does-not-exist", db_path=db_path) is None


def test_get_case_before_any_case_ever_saved_returns_none(tmp_path):
    db_path = str(tmp_path / "cases.db")
    assert get_case("anything", db_path=db_path) is None


def test_get_case_patches_clinician_confirmed_to_match_confirmed_column(tmp_path):
    db_path = str(tmp_path / "cases.db")
    case_id = save_case(_valid_state(), db_path=db_path)

    before = get_case(case_id, db_path=db_path)
    assert before["final_explainable_report"]["clinician_confirmed"] is False

    confirm_case(case_id, db_path=db_path)

    after = get_case(case_id, db_path=db_path)
    assert after["final_explainable_report"]["clinician_confirmed"] is True


# --- list_recent_cases ------------------------------------------------------

def test_list_recent_cases_orders_newest_first(tmp_path):
    db_path = str(tmp_path / "cases.db")
    first = save_case(_valid_state(), db_path=db_path)
    second = save_case(_valid_state(), db_path=db_path)
    third = save_case(_valid_state(), db_path=db_path)

    ids = [case["case_id"] for case in list_recent_cases(db_path=db_path)]
    assert ids == [third, second, first]


def test_list_recent_cases_respects_limit(tmp_path):
    db_path = str(tmp_path / "cases.db")
    for _ in range(5):
        save_case(_valid_state(), db_path=db_path)

    assert len(list_recent_cases(limit=2, db_path=db_path)) == 2


def test_list_recent_cases_empty_db_returns_empty_list(tmp_path):
    db_path = str(tmp_path / "cases.db")
    assert list_recent_cases(db_path=db_path) == []
