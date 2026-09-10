"""Tests for the pipeline state schema, in particular the privacy-boundary
guard -- the one piece of Phase 0 that's actual logic rather than a type
definition, so it's the one piece worth testing before moving on.
"""

import pytest

from glassbox_md.state import (
    PrivacyBoundaryViolation,
    assert_privacy_boundary_respected,
    new_stage_status,
)


def test_no_violation_before_anonymization_runs():
    """Raw paths are expected to be present until the Privacy agent runs --
    that's not a violation yet, just an earlier point in the pipeline."""
    state = {"raw_input_paths": ["patient_123.dcm"], "anonymized_patient_data": {}}
    assert_privacy_boundary_respected(state)  # should not raise


def test_violation_when_raw_paths_survive_anonymization():
    """Once anonymized_patient_data exists, raw_input_paths must be gone --
    this is the exact leak the architecture critique flagged."""
    state = {
        "raw_input_paths": ["patient_123.dcm"],
        "anonymized_patient_data": {"age_band": "40-49"},
    }
    with pytest.raises(PrivacyBoundaryViolation):
        assert_privacy_boundary_respected(state)


def test_no_violation_once_raw_paths_cleared():
    """The fix: the Privacy agent clears raw_input_paths in the same
    update where it sets anonymized_patient_data."""
    state = {
        "raw_input_paths": [],
        "anonymized_patient_data": {"age_band": "40-49"},
    }
    assert_privacy_boundary_respected(state)  # should not raise


def test_new_stage_status_covers_all_six_agents():
    status = new_stage_status()
    assert len(status) == 6
    assert all(s["status"] == "pending" for s in status.values())
