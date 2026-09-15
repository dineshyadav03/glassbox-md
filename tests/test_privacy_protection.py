"""Tests for the Privacy Protection Agent: text redaction, lab-table
extraction, DICOM tag stripping, the raw_input_paths leak fix, and an
end-to-end check that a synthetic fake-patient document with planted PII
comes out clean on the other side.
"""

import pytest
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

from glassbox_md.agents.document_parser import document_parser_agent
from glassbox_md.agents.privacy_protection import (
    extract_labs_from_tables,
    privacy_protection_agent,
    redact_text,
    strip_dicom_phi_tags,
)
from glassbox_md.state import (
    PrivacyBoundaryViolation,
    assert_privacy_boundary_respected,
    new_stage_status,
)


def _base_state(**overrides):
    state = {
        "raw_input_paths": [],
        "extracted_document_content": {"documents": [], "parse_errors": []},
        "stage_status": new_stage_status(),
        "audit_log": [],
    }
    state.update(overrides)
    return state


def _pdf_document(text="", tables=None):
    return {
        "source_path": "fake.pdf",
        "kind": "pdf",
        "text": text,
        "tables": tables or [],
        "dicom_metadata": None,
        "pixel_summary": None,
    }


def _dicom_document(metadata):
    return {
        "source_path": "fake.dcm",
        "kind": "dicom",
        "text": "",
        "tables": [],
        "dicom_metadata": metadata,
        "pixel_summary": {"shape": (4, 4), "dtype": "uint16"},
    }


# --- redact_text -----------------------------------------------------------

def test_redacts_a_person_name():
    redacted, counts = redact_text("Patient John Smith presents with fatigue.")
    assert "John Smith" not in redacted
    assert counts.get("PERSON", 0) >= 1


def test_redacts_ssn():
    # Not 123-45-6789: Presidio's UsSsnRecognizer explicitly denylists that
    # exact number (and a couple of other canonical examples) as a known
    # tutorial/documentation placeholder, specifically so it does *not*
    # false-positive on sample text -- so it's the one 9-digit string this
    # recognizer will never flag. Use a realistic-but-arbitrary one instead.
    redacted, counts = redact_text("SSN: 234-56-7890")
    assert "234-56-7890" not in redacted
    assert counts.get("US_SSN", 0) == 1


def test_redacts_medical_record_number():
    redacted, counts = redact_text("MRN: 4471829")
    assert "4471829" not in redacted
    assert counts.get("MEDICAL_RECORD_NUMBER", 0) == 1


def test_redacts_medical_license_number():
    # A DEA-certificate-shaped value: first letter in the DEA-valid set,
    # and the checksum genuinely passes -- MedicalLicenseRecognizer
    # validates via a real Luhn check, not just the regex shape.
    redacted, counts = redact_text("Prescriber DEA number: AB1234563")
    assert "AB1234563" not in redacted
    assert counts.get("MEDICAL_LICENSE", 0) == 1


def test_redacts_itin():
    redacted, counts = redact_text("Taxpayer ITIN: 912-73-4567")
    assert "912-73-4567" not in redacted
    assert counts.get("US_ITIN", 0) == 1


def test_itin_does_not_double_count_an_overlapping_ssn():
    """Regression test: US_ITIN's valid range structurally overlaps
    US_SSN's shape-only pattern (nothing on the SSN side excludes ITIN's
    900+ prefix), so one ITIN-shaped value can match both recognizers.
    The anonymizer correctly resolves the overlap to a single
    redaction -- this test locks in that redact_text's *counts* reflect
    that resolved reality (via anonymized.items) rather than the raw,
    pre-conflict-resolution results list, which would silently inflate
    the SSN count with a phantom second match that was never its own
    redaction."""
    text = "Taxpayer ITIN: 900-70-1234. Patient also has SSN: 234-56-7890 on file."
    redacted, counts = redact_text(text)
    assert "900-70-1234" not in redacted
    assert "234-56-7890" not in redacted
    assert counts.get("US_SSN", 0) == 1
    assert counts.get("US_ITIN", 0) == 1


def test_redacts_medicare_beneficiary_identifier():
    redacted, counts = redact_text("MBI: 4EG9-TK2-XR56")
    assert "4EG9-TK2-XR56" not in redacted
    assert counts.get("US_MBI", 0) == 1


def test_redacts_account_number():
    redacted, counts = redact_text("Account #: 90012345678")
    assert "90012345678" not in redacted
    assert counts.get("ACCOUNT_NUMBER", 0) == 1


def test_redacts_vehicle_identification_number():
    redacted, counts = redact_text("VIN: 1HGCM82633A123456")
    assert "1HGCM82633A123456" not in redacted
    assert counts.get("VEHICLE_IDENTIFICATION_NUMBER", 0) == 1


def test_realistic_lab_panel_text_passes_through_unredacted():
    """The existing test_unrecognized_clinical_text_passes_through has no
    digits in it at all, so it can't catch a false-positive regression
    from any of the digit-heavy entities added above. This one targets
    that specific risk surface directly."""
    text = "Fasting glucose: 205 mg/dL, HbA1c: 8.0%, Total Cholesterol: 200 mg/dL, Reference Range 70-100"
    redacted, _ = redact_text(text)
    assert redacted == text


def test_empty_text_returns_empty_with_no_counts():
    redacted, counts = redact_text("")
    assert redacted == ""
    assert counts == {}


def test_unrecognized_clinical_text_passes_through():
    text = "Patient reports mild headache, no fever."
    redacted, _ = redact_text(text)
    assert "headache" in redacted


# --- strip_dicom_phi_tags ---------------------------------------------------

def test_strips_known_phi_tags():
    metadata = {"PatientName": "Test^Synthetic", "Modality": "MR", "DeviceSerialNumber": "SN123"}
    cleaned, removed = strip_dicom_phi_tags(metadata)
    assert "PatientName" not in cleaned
    assert "DeviceSerialNumber" not in cleaned
    assert cleaned["Modality"] == "MR"
    assert set(removed) == {"PatientName", "DeviceSerialNumber"}


def test_strip_dicom_phi_tags_on_empty_metadata():
    cleaned, removed = strip_dicom_phi_tags({})
    assert cleaned == {}
    assert removed == []


# --- extract_labs_from_tables -----------------------------------------------

def test_extracts_recognizable_lab_table():
    table = [
        ["Test", "Result", "Units", "Reference Range"],
        ["Glucose", "126", "mg/dL", "70-100"],
        ["Total Cholesterol", "200", "mg/dL", "<200"],
    ]
    labs = extract_labs_from_tables([table])
    assert labs["glucose"] == {"value": 126.0, "unit": "mg/dL"}
    assert labs["total_cholesterol"] == {"value": 200.0, "unit": "mg/dL"}


def test_skips_unrecognizable_table():
    table = [["Column A", "Column B"], ["foo", "bar"]]
    assert extract_labs_from_tables([table]) == {}


def test_skips_short_or_empty_tables():
    assert extract_labs_from_tables([[], [["Test"]]]) == {}


def test_skips_non_numeric_result_row():
    table = [["Test", "Result", "Units"], ["Glucose", "pending", "mg/dL"]]
    assert extract_labs_from_tables([table]) == {}


# --- privacy_protection_agent (the LangGraph node) --------------------------

def test_agent_fails_when_no_documents():
    result = privacy_protection_agent(_base_state())
    assert result["stage_status"]["privacy_protection"]["status"] == "failed"


def test_agent_clears_raw_input_paths():
    state = _base_state(
        raw_input_paths=["patient_123.pdf"],
        extracted_document_content={"documents": [_pdf_document(text="hello")], "parse_errors": []},
    )
    result = privacy_protection_agent(state)
    assert result["raw_input_paths"] == []


def test_agent_output_satisfies_the_privacy_boundary_guard():
    state = _base_state(
        raw_input_paths=["patient_123.pdf"],
        extracted_document_content={"documents": [_pdf_document(text="hello")], "parse_errors": []},
    )
    result = privacy_protection_agent(state)
    # Should not raise -- if it does, the agent broke its own contract.
    assert_privacy_boundary_respected({**state, **result})


def test_agent_combines_pdf_and_dicom_documents():
    table = [["Test", "Result", "Units"], ["Glucose", "126", "mg/dL"]]
    state = _base_state(
        raw_input_paths=["a.pdf", "b.dcm"],
        extracted_document_content={
            "documents": [
                _pdf_document(text="Patient has T2DM.", tables=[table]),
                _dicom_document({"PatientName": "Test^Synthetic", "Modality": "MR"}),
            ],
            "parse_errors": [],
        },
    )
    result = privacy_protection_agent(state)
    data = result["anonymized_patient_data"]
    assert data["labs"]["glucose"] == {"value": 126.0, "unit": "mg/dL"}
    assert len(data["imaging"]) == 1
    assert "PatientName" not in data["imaging"][0]["metadata"]
    assert result["stage_status"]["privacy_protection"]["status"] == "ok"


def test_agent_preserves_other_stages_status():
    state = _base_state(
        extracted_document_content={"documents": [_pdf_document(text="hello")], "parse_errors": []},
    )
    state["stage_status"]["document_parser"] = {"status": "ok", "message": None}
    result = privacy_protection_agent(state)
    assert result["stage_status"]["document_parser"] == {"status": "ok", "message": None}


# --- end-to-end: does anything actually leak? -------------------------------

def test_no_planted_pii_survives_parser_and_privacy_together(tmp_path):
    """Task p3-4: run a synthetic fake-patient PDF, with planted but
    clearly-fake PII we control, through Parser -> Privacy and confirm
    every planted identifier is gone from the final output."""
    planted = {
        "name": "John Smith",
        "dob": "March 14, 1985",
        "ssn": "234-56-7890",  # not the canonical 123-45-6789 -- see test_redacts_ssn
        "mrn_value": "4471829",
        "account_value": "90012345678",
        "vin_value": "1HGCM82633A123456",
    }

    path = tmp_path / "fake_patient.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    c.drawString(72, 750, f"Patient: {planted['name']}")
    c.drawString(72, 730, f"DOB: {planted['dob']}")
    c.drawString(72, 710, f"SSN: {planted['ssn']}")
    c.drawString(72, 690, f"MRN: {planted['mrn_value']}")
    c.drawString(72, 670, f"Account #: {planted['account_value']}")
    c.drawString(72, 650, f"VIN: {planted['vin_value']}")
    c.drawString(72, 630, "History: Patient has T2DM and HTN.")
    c.save()

    parser_state = _base_state(raw_input_paths=[str(path)])
    parser_result = document_parser_agent(parser_state)
    combined_state = {**parser_state, **parser_result}

    privacy_result = privacy_protection_agent(combined_state)
    output_text = privacy_result["anonymized_patient_data"]["history_text"]

    for label, value in planted.items():
        assert value not in output_text, f"{label} leaked into output: {value!r}"

    # And the terminology the note carried should still be there --
    # redaction should not have removed clinically meaningful content.
    assert "T2DM" in output_text or "diabetes" in output_text.lower()
