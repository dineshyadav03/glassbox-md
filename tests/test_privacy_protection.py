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


@pytest.mark.parametrize(
    "text, secret",
    [
        ("Device Serial Number: SN-48213907", "SN-48213907"),
        ("Pacemaker Serial No. PM4482917", "PM4482917"),
        ("Serial #: XR200987", "XR200987"),
        ("S/N: 9981-2234-AB", "9981-2234-AB"),
        ("Device ID: 4471829", "4471829"),
        ("Device Identifier 0F82A9C1", "0F82A9C1"),
        ("UDI: (01)00844588003288(17)141120(10)7654321D(21)10987654321", "00844588003288"),
        ("UDI: +H123PARTNO1234567890/$$52001510X3", "PARTNO1234567890"),
        ("SERIAL NO. ab12cd34", "ab12cd34"),
    ],
)
def test_redacts_free_text_device_identifier(text, secret):
    redacted, counts = redact_text(text)
    assert secret not in redacted
    assert counts.get("DEVICE_IDENTIFIER", 0) == 1


@pytest.mark.parametrize(
    "text, secret",
    [
        ("License Plate: ABC1234", "ABC1234"),
        ("License plate number: 7XYZ123", "7XYZ123"),
        ("Licence Plate ABC 1234", "ABC 1234"),
        ("Plate No. 123-ABC", "123-ABC"),
        ("Plate #: AB-123", "AB-123"),
        ("Plate Number: 4KLM892", "4KLM892"),
        ("Tag # 6FTR421", "6FTR421"),
    ],
)
def test_redacts_vehicle_license_plate(text, secret):
    redacted, counts = redact_text(text)
    assert secret not in redacted
    assert counts.get("VEHICLE_LICENSE_PLATE", 0) == 1


def test_device_and_plate_redaction_keeps_the_surrounding_sentence():
    redacted, counts = redact_text("Implant serial number ABC-98765-XYZ; License Plate: 7XYZ123.")
    assert redacted == "Implant <DEVICE_IDENTIFIER>; <VEHICLE_LICENSE_PLATE>."
    assert counts == {"DEVICE_IDENTIFIER": 1, "VEHICLE_LICENSE_PLATE": 1}


def test_device_identifier_shaped_like_a_phone_number_counts_once():
    """Same overlap risk as the ITIN/SSN regression below: a serial that is
    also phone-shaped matches two recognizers on overlapping spans. The
    anonymizer keeps the labelled, wider match; the counts must show one
    DEVICE_IDENTIFIER and no phantom PHONE_NUMBER."""
    redacted, counts = redact_text("Serial No: 555-123-4567")
    assert "555-123-4567" not in redacted
    assert counts == {"DEVICE_IDENTIFIER": 1}


def test_device_id_and_mrn_with_the_same_digits_are_counted_separately():
    redacted, counts = redact_text("Device ID: 4471829 and MRN: 4471829")
    assert "4471829" not in redacted
    assert counts == {"DEVICE_IDENTIFIER": 1, "MEDICAL_RECORD_NUMBER": 1}


@pytest.mark.parametrize(
    "text",
    [
        "Pump housing 9981-2234-AB was replaced.",
        "Parked car was 7XYZ123, dark blue.",
    ],
)
def test_device_and_plate_values_without_a_label_are_left_alone(text):
    """Documents the gate's cost, not just its benefit (see the module
    docstring): the identical value with no label in front of it is NOT
    redacted. Asserting it keeps that limitation a deliberate, visible
    choice -- if a future change starts catching bare values, the
    negative corpus below needs re-checking at the same time."""
    redacted, _ = redact_text(text)
    assert redacted == text


def test_value_on_the_line_below_its_label_is_not_claimed_by_the_label():
    """Same-line-only gap between label and value. A heading that ends a
    line ("Serial Number") must not swallow the first token of the next
    line ("HbA1c") -- the false positive that led to horizontal-only
    whitespace ([^\\S\\r\\n], which still matches NBSP) instead of \\s."""
    text = "Serial Number\nHbA1c 8.0"
    redacted, _ = redact_text(text)
    assert redacted == text


# Realistic lab/history text that mentions the trigger words in ordinary
# clinical senses. Every entry must come out byte-identical; this is the
# regression net for the two label-gated recognizers above, in the same
# spirit as the lab-panel test below. Phrases that trip the *pre-existing*
# DATE_TIME/PERSON recognizers ("over 3 days", "Plateau reached at week 12")
# are deliberately kept out so a failure here always means a new recognizer.
_ORDINARY_TEXT_WITH_TRIGGER_WORDS = [
    "Platelet count 250 x10^9/L",
    "Platelet count: 250, MPV 9.8 fL",
    "Fasting glucose: 205 mg/dL, HbA1c: 8.0%, Total Cholesterol: 200 mg/dL, Reference Range 70-100",
    "Serial creatinine 1.2, 1.4, 1.9 mg/dL.",
    "Serial testing is recommended.",
    "Serial nodules noted in the right lung.",
    "Serial no evidence of progression on imaging.",
    "Serial Number: not recorded",
    "Serial number of samples: 5",
    "Serial #3 culture grew no organisms.",
    "S/N ratio was acceptable.",
    "Device: insulin pump",
    "Device ID pending",
    "Device ID verification was completed.",
    "Device identifier confirmed before the procedure.",
    "Pacemaker Serial No. pending",
    "UDI: not available",
    "UDI required by regulation",
    "The plate count was 250.",
    "Plate 3 of the culture showed growth.",
    "Plate No. 3 of the culture showed growth.",
    "Plate number 4 was contaminated.",
    "Agar plate showed colony growth.",
    "License plate reader data was not reviewed.",
    "License plate: pending",
    "License plate is unknown",
    "Driver's license status: valid.",
    "Patient holds a valid license to drive.",
    "Tag # 5",
    "Tag removed from the specimen.",
    "Skin tag on the left forearm, 4 mm.",
    "Vehicle accident reported; no VIN recorded.",
    "Serial Number\nHbA1c 8.0",
    # Found by independent review, not by the first round of tests: UDI is
    # also the Urogenital Distress Inventory, and the MRN label used to run
    # into "Patient identified".
    "UDI-6/IIQ-7 scores improved after sling surgery.",
    "PFDI-20 (UDI-6/CRADI-8/POPDI-6) reviewed.",
    "Patient identified by two identifiers.",
    "MRN pending",
    "MRN: pending",
    "Plate\nNo. 12345 not used",
    "Serial No: 12",
]


@pytest.mark.parametrize("text", _ORDINARY_TEXT_WITH_TRIGGER_WORDS)
def test_ordinary_text_with_trigger_words_passes_through_byte_identical(text):
    redacted, counts = redact_text(text)
    assert redacted == text
    assert counts == {}


@pytest.mark.parametrize(
    "text",
    [
        "Serial Number: SN48213907",
        "Serial No. PM4482917",
        "License Plate: ABC1234",
        "Plate No. ABC1234",
        "Serial Number: SN48213907",
    ],
)
def test_non_breaking_and_thin_spaces_after_a_label_do_not_defeat_redaction(text):
    """Word/HTML-derived PDF text puts NBSP or a thin space after the colon.
    An earlier `[ \\t]` gap missed those, so the older MRN/Account/VIN
    recognizers redacted the same layout while the new ones leaked -- a
    real PHI leak found by review."""
    redacted, counts = redact_text(text)
    assert redacted.startswith("<") and redacted.endswith(">")
    assert sum(counts.values()) == 1


@pytest.mark.parametrize(
    "text, hidden",
    [
        ("UDI: (01)00844588003288 (17)141120 (10)7654321D (21)10987654321", ["141120", "7654321D", "10987654321"]),
        ("Serial No. AB123/4567", ["4567"]),
        ("Serial No. AB123.4567", ["4567"]),
        ("Serial No: 12345 6789", ["6789"]),
        ("Serial number PM 4482917", ["4482917"]),
        ("License Plate: ABC-1234-5", ["-5"]),
        ("License Plate: CA 7ABC123", ["7ABC123"]),
        ("License Plate: AB12 CDE", ["CDE"]),
    ],
)
def test_redaction_covers_the_whole_value_not_just_its_first_segment(text, hidden):
    """A partial match is worse than a miss here: it reports a redaction
    while the patient-specific tail (a UDI's (21) serial, the part of a
    serial after a slash) stays in the output."""
    redacted, counts = redact_text(text)
    for fragment in hidden:
        assert fragment not in redacted
    assert sum(counts.values()) == 1


@pytest.mark.parametrize(
    "text, secret",
    [
        ("Pacemaker SN: PM4482917", "PM4482917"),
        ("Pacemaker Serial: PM4482917", "PM4482917"),
        ("Device Number: 4482917", "4482917"),
        ("Vehicle plate: ABC1234", "ABC1234"),
        ("Tag Number: ABC1234", "ABC1234"),
        ("UDI-DI: 00844588003288", "00844588003288"),
    ],
)
def test_additional_common_label_spellings_are_recognised(text, secret):
    redacted, counts = redact_text(text)
    assert secret not in redacted
    assert sum(counts.values()) == 1


@pytest.mark.parametrize(
    "text, secret",
    [
        ("MRN4471829", "4471829"),
        ("MRN: 4471829", "4471829"),
        ("Patient ID 88123-77", "88123-77"),
    ],
)
def test_mrn_still_redacted_after_tightening_the_label_and_value_rules(text, secret):
    redacted, counts = redact_text(text)
    assert secret not in redacted
    assert counts.get("MEDICAL_RECORD_NUMBER", 0) == 1


def test_label_gated_recognizers_outscore_spacy_ner_so_ties_are_not_hash_seed_dependent():
    """spaCy NER's default score is 0.85. At an equal score, "MRN4471829"
    (one token NER tags PERSON) was labelled PERSON or MEDICAL_RECORD_NUMBER
    depending on PYTHONHASHSEED -- 3 of 8 seeds. The value was redacted
    either way; the audit-log counts were the nondeterministic part."""
    from glassbox_md.agents import privacy_protection as pp

    recognizers = [
        pp._MRN_RECOGNIZER,
        pp._ACCOUNT_NUMBER_RECOGNIZER,
        pp._VIN_RECOGNIZER,
        pp._LICENSE_PLATE_RECOGNIZER,
        pp._DEVICE_IDENTIFIER_RECOGNIZER,
    ]
    assert all(pattern.score > 0.85 for r in recognizers for pattern in r.patterns)


def test_missing_spacy_model_fails_fast_with_the_install_command(monkeypatch):
    """Without this guard Presidio runs `spacy download` mid-request, which
    in an environment with no pip raises SystemExit -- a BaseException that
    can end the whole process rather than fail one case."""
    from glassbox_md.agents import privacy_protection as pp

    monkeypatch.setattr(pp, "_analyzer", None)
    monkeypatch.setattr(pp.spacy.util, "is_package", lambda name: False)
    with pytest.raises(RuntimeError, match=r"python -m spacy download en_core_web_lg"):
        pp._get_analyzer()


@pytest.mark.parametrize(
    "text",
    [
        "Serial creatinine 1.2, 1.4, 1.9 mg/dL over 3 days",
        "Serial testing is recommended every 6 months.",
        "Colonies on the agar plate at 48 hours.",
        "Driver's license renewed in 2019; license plate reader not used.",
    ],
)
def test_new_recognizers_stay_silent_on_text_that_trips_older_ones(text):
    """These can still be touched by the date/duration handling, so
    byte-identical is the wrong assertion -- what matters is that the
    device/plate recognizers themselves don't fire."""
    _, counts = redact_text(text)
    assert "DEVICE_IDENTIFIER" not in counts
    assert "VEHICLE_LICENSE_PLATE" not in counts


# One positive test per remaining detector behind the module docstring's
# "addressed" tiers, so each claim there has an assertion behind it.
@pytest.mark.parametrize(
    "text, entity, secret",
    [
        ("Seen in Springfield, Illinois.", "LOCATION", "Springfield"),
        ("Seen on March 14, 2021.", "DATE", "March 14, 2021"),
        ("She is 95 years old.", "AGE_BAND", "95"),
        ("Call (555) 234-5678 for results.", "PHONE_NUMBER", "234-5678"),
        ("Fax: 555-234-5679", "PHONE_NUMBER", "234-5679"),
        ("Contact jane.doe@example.org for records.", "EMAIL_ADDRESS", "jane.doe@example.org"),
        ("See https://portal.example.org/patient/123", "URL", "portal.example.org"),
        ("Logged from 192.168.10.44", "IP_ADDRESS", "192.168.10.44"),
    ],
)
def test_redacts_each_ner_and_shape_based_detector(text, entity, secret):
    redacted, counts = redact_text(text)
    assert secret not in redacted
    assert counts.get(entity, 0) >= 1


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


def test_agent_audit_log_counts_new_entity_types_without_their_values():
    state = _base_state(
        extracted_document_content={
            "documents": [
                _pdf_document(text="Device Serial Number: SN-48213907\nLicense Plate: ABC1234\nHistory: T2DM."),
                _pdf_document(text="Pacemaker Serial No. PM4482917"),
            ],
            "parse_errors": [],
        },
    )
    result = privacy_protection_agent(state)

    summary = result["audit_log"][0]["summary"]
    # Counts accumulate across documents, same as every other entity type.
    assert "DEVICE_IDENTIFIER:2" in summary
    assert "VEHICLE_LICENSE_PLATE:1" in summary
    for value in ("SN-48213907", "ABC1234", "PM4482917"):
        assert value not in summary
        assert value not in result["anonymized_patient_data"]["history_text"]
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
        "device_serial_value": "PM4482917",
        "plate_value": "7XYZ123",
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
    c.drawString(72, 610, f"Pacemaker Serial No. {planted['device_serial_value']}")
    c.drawString(72, 590, f"License Plate: {planted['plate_value']}")
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


# --- date / age policy through the real analyzer --------------------------------
#
# See agents/redaction_policy.py. The privacy-critical direction is asserted
# hardest: no calendar date and no age of 90 or over may survive, in any of the
# forms below. The other direction (clinically useful durations and ages are
# kept) is what the powered rerun in docs/text-eval-redaction-powered-rerun.md
# showed was worth ~5 of 32 cases.

_AGE_FORMS = [
    "{n} year old", "{n}-year-old", "{n} years old", "{n} y/o", "{n}yo", "{n} y.o.", "aged {n}", "Age: {n}",
    "age {n}", "at the age of {n}", "{n} years of age", "age of {n} years", "{n} yr old", "Age {n} years",
    "{n} year-old", "{n}-yr-old",
]


@pytest.mark.parametrize("n", [90, 93, 101])
@pytest.mark.parametrize("form", _AGE_FORMS)
def test_an_age_of_90_or_over_is_generalised_in_every_supported_form(form, n):
    redacted, counts = redact_text(f"Patient is {form.format(n=n)} and presents today.")
    if n > 90:
        assert str(n) not in redacted
    assert "90+" in redacted
    assert counts.get("AGE_BAND", 0) >= 1


@pytest.mark.parametrize(
    "phrase",
    [
        "ninety year old", "ninety-three year old", "ninety three years old", "ninety-five-year-old",
        "one hundred year old", "aged ninety-two", "in his 90s", "in her nineties", "in his late 90s",
    ],
)
def test_a_written_out_age_of_90_or_over_is_generalised(phrase):
    redacted, _ = redact_text(f"Patient is {phrase} with cough.")
    assert "90+" in redacted


@pytest.mark.parametrize(
    "age, band",
    [(18, "18-19"), (19, "18-19"), (20, "20-29"), (52, "50-59"), (67, "60-69"), (89, "80-89")],
)
def test_adult_ages_under_90_become_a_decade_band(age, band):
    redacted, counts = redact_text(f"A {age} year old with a cough.")
    assert redacted == f"A {band} year old with a cough."
    assert counts == {"AGE_BAND": 1}


@pytest.mark.parametrize("text", ["A 5 year old with a cough.", "A 17 year old with a cough.", "Patient is a 4 month old infant."])
def test_a_childs_age_is_kept_exactly(text):
    redacted, counts = redact_text(text)
    assert redacted == text and counts == {}


@pytest.mark.parametrize(
    "text, secret",
    [
        ("Seen on March 14, 2021.", "2021"), ("Seen on 03/14/2021.", "03/14/2021"), ("Seen 3/14/21.", "3/14/21"),
        ("Seen 14 March 2021.", "2021"), ("Seen 2021-03-14.", "2021-03-14"), ("Seen Mar 14 2021.", "2021"),
        ("DOB 05/12/1980", "1980"), ("DOB: 12 May 1980", "1980"), ("born in 1980", "1980"), ("Born May 1980.", "1980"),
        ("admitted on 2019-03-14 and discharged 2019-03-20", "2019"), ("since 2019", "2019"), ("in summer 2019", "2019"),
        ("on Monday", "Monday"), ("last Tuesday", "Tuesday"), ("on September 3rd", "September"), ("Sept. 3, 2020", "2020"),
        ("in January", "January"), ("the 1990s", "1990"), ("at 3:30 pm", "3:30"), ("at 14:30", "14:30"),
        ("visit scheduled for 12/25/2026", "2026"), ("died on 2 April 2024", "2024"), ("March of 2018", "2018"),
        ("Date of birth: 1/2/1950", "1950"), ("Admission date 03-14-2021", "2021"), ("surgery in 2015", "2015"),
        ("December 2020", "2020"), ("Q3 2019", "2019"),
    ],
)
def test_no_calendar_date_or_clock_time_survives(text, secret):
    redacted, counts = redact_text(text)
    assert secret not in redacted
    assert "<DATE_TIME>" not in redacted
    assert counts.get("DATE", 0) + counts.get("TIME", 0) >= 1


def test_redactions_of_dates_and_times_are_typed_not_generic():
    redacted, counts = redact_text("Seen on 03/14/2021 at 3:30 pm.")
    assert "<DATE>" in redacted and "<TIME>" in redacted
    assert "DATE_TIME" not in counts and "<DATE_TIME>" not in redacted


@pytest.mark.parametrize(
    "text",
    [
        "Symptoms for three months, worse over the past year.",
        "Thirst and frequent urination for two weeks.",
        "Take metformin twice daily.",
        "Vitals every 6 hours.",
        "He had a stent placed two years ago.",
        "Has not seen a doctor in ten years.",
        "Chest pressure eases within minutes of resting.",
        "Glucose has been high for several months.",
        "Creatinine rising over six months.",
        "Fatigue since last week.",
        "Diabetic for twelve years.",
    ],
)
def test_durations_frequencies_and_relative_times_are_kept_verbatim(text):
    redacted, counts = redact_text(text)
    assert redacted == text and counts == {}


def test_a_duration_of_ninety_years_or_more_is_generalised_because_it_reads_as_an_age():
    redacted, _ = redact_text("Has lived alone for 95 years.")
    assert "95" not in redacted and "90+" in redacted


@pytest.mark.parametrize(
    "text",
    [
        "Blood pressure 168/102 on three separate visits.",
        "BP 152/96 at home.",
        "Home readings average 152/96 over two weeks, confirmed in clinic at 150/94.",
    ],
)
def test_blood_pressures_are_not_mistaken_for_phone_numbers(text):
    redacted, counts = redact_text(text)
    assert "PHONE_NUMBER" not in counts
    assert any(v in redacted for v in ("168/102", "152/96", "150/94"))


def test_a_real_phone_number_next_to_a_blood_pressure_is_still_redacted():
    redacted, counts = redact_text("BP 168/102. Call (555) 234-5678 for results.")
    assert "168/102" in redacted
    assert "234-5678" not in redacted and counts.get("PHONE_NUMBER", 0) >= 1


@pytest.mark.parametrize(
    "text, kept",
    [
        ("Treadmill stress test showed ST segment depression at moderate workload.", "ST segment"),
        ("Yellow fatty deposits on the Achilles tendons.", "Achilles tendons"),
        ("Sister has Hashimoto thyroiditis.", "Hashimoto thyroiditis"),
        ("Family history of Graves disease.", "Graves disease"),
    ],
)
def test_clinical_terms_are_not_redacted_as_names_or_places(text, kept):
    redacted, counts = redact_text(text)
    assert kept in redacted
    assert "PERSON" not in counts and "LOCATION" not in counts


@pytest.mark.parametrize(
    "text, name",
    [
        ("Dr. Graves reviewed the chart.", "Graves"),
        ("Seen by Dr. Alice Nguyen today.", "Nguyen"),
        ("Patient: Achilles Papadopoulos was seen.", "Papadopoulos"),
        ("Referred by Mr Hashimoto.", "Hashimoto"),
    ],
)
def test_real_names_are_still_redacted_even_when_they_look_like_clinical_terms(text, name):
    redacted, counts = redact_text(text)
    assert name not in redacted and counts.get("PERSON", 0) >= 1


def test_a_name_then_a_disease_word_in_a_full_sentence_keeps_only_the_disease():
    redacted, counts = redact_text("John Smith has Graves disease.")
    assert "Smith" not in redacted and "Graves disease" in redacted
    assert counts.get("PERSON", 0) >= 1


def test_every_synthetic_text_eval_history_keeps_its_clinical_content():
    """The 32 histories the powered rerun used. Before this policy each lost
    its age and every duration to `<DATE_TIME>`; now nothing but a bare number
    after "at" is lost, and no generic date token remains."""
    from glassbox_md import text_eval

    for case in text_eval.CASES:
        redacted, counts = redact_text(case.history)
        assert "<DATE_TIME>" not in redacted and "DATE_TIME" not in counts, case.case_id
        words = {w for w in "".join(c if c.isalpha() else " " for c in case.history.lower()).split() if len(w) >= 5}
        kept = {w for w in words if w in redacted.lower()}
        assert len(kept) >= 0.9 * len(words), (case.case_id, sorted(words - kept))
        assert "year old" in redacted, case.case_id  # the age survives, as a band


def test_the_audit_summary_reports_the_new_entity_types_without_values():
    from glassbox_md.agents.privacy_protection import privacy_protection_agent
    from glassbox_md.state import new_stage_status

    state = {
        "extracted_document_content": {
            "documents": [
                {"kind": "pdf", "text": "A 52 year old seen on 03/14/2021 for two weeks of cough.", "tables": []}
            ]
        },
        "raw_input_paths": ["x.pdf"],
        "stage_status": new_stage_status(),
        "audit_log": [],
    }

    update = privacy_protection_agent(state)

    # The summary only: the entry also carries a timestamp, which can contain any digits.
    entry_text = update["audit_log"][0]["summary"]
    assert "AGE_BAND:1" in entry_text and "DATE:1" in entry_text
    assert "03/14/2021" not in entry_text and "52" not in entry_text
    history = update["anonymized_patient_data"]["history_text"]
    assert history == "A 50-59 year old seen on <DATE> for two weeks of cough."
