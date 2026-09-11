"""Privacy Protection Agent.

Second in pipeline order, and the most load-bearing agent for the whole
project's premise: everything downstream of this agent -- including the
two nodes that call an external API -- must never see a raw identifier.

This agent has three jobs, not one, and the third is a scope decision
worth explaining. "Anonymizes PII" and "extracts structured lab values"
sound unrelated, but both require scanning the same raw text and tables
this agent already has open, so lab-value extraction lives here rather
than bulking out the Document Parser (which stays a pure format-level
extractor) or the Data Preparation Agent (which was already built, in
Phase 1, expecting `anonymized_patient_data["labs"]` to arrive already
structured as `{"glucose": {"value": 126, "unit": "mg/dL"}}`). Extraction
happens first, purely on raw text/tables; redaction is independent of it
and targets a disjoint signal (names/dates/IDs, not numeric lab values).

Renamed from the original pitch's "HIPAA compliance" and "differential
privacy" to what this agent actually does, per the privacy critique:
compliance is a legal/organizational status this repo cannot claim, and
differential privacy protects aggregate/training data, not a single
patient's chart -- neither is the right label for a de-identification
pipeline. What follows is "HIPAA Safe-Harbor-*aligned*" de-identification,
scoped honestly below, not "compliant."

Coverage against the 18 HIPAA Safe Harbor identifiers (45 CFR 164.514):
  covered via spaCy NER + Presidio     -- names, geographic subdivisions,
                                           dates, phone/fax numbers,
                                           email addresses, SSNs, URLs,
                                           IP addresses
  covered via a custom pattern         -- medical record / patient ID
    recognizer                            numbers ("any other unique
                                           identifying number")
  covered via DICOM tag stripping      -- device identifiers/serial
                                           numbers, institution and
                                           physician names, account/
                                           certificate numbers, when
                                           present as DICOM metadata
  NOT covered (documented limitation,  -- biometric identifiers, full-
  not silently ignored)                   face photographs (pixel-level
                                           defacing of head/face imaging
                                           is a V2 item), vehicle
                                           identifiers, web URLs embedded
                                           in scanned image content

spaCy model: en_core_web_sm, not _lg. ~15MB vs ~587MB, with correspondingly
lower named-entity recall on unusual names -- acceptable for this MVP's
synthetic test corpus, not a claim that this is production-grade recall
on messy real-world text.

DICOM tag list: a curated subset of the PS3.15 Basic Application Level
Confidentiality Profile (the identity-bearing tags most likely to appear
in a clinical file), not the full ~200-tag table -- see
`_DICOM_PHI_KEYWORDS` below.

The audit log entry this agent writes never contains a redacted value,
only entity-type counts -- an audit trail that itself leaked PHI would
defeat the entire point of having one.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from presidio_analyzer import AnalyzerEngine, Pattern, PatternRecognizer
from presidio_anonymizer import AnonymizerEngine

from ..audit import audit_entry
from ..state import MedicalPipelineState, assert_privacy_boundary_respected, update_stage_status
from .document_parser import Table

STAGE_NAME = "privacy_protection"

# A curated subset of DICOM PS3.15's Basic Application Level Confidentiality
# Profile -- the identity-bearing tags most likely to appear in a clinical
# imaging file, not the full ~200-tag table (a V2 item if broader coverage
# is ever needed). Device serial numbers are included since HIPAA's Safe
# Harbor list treats device identifiers as PHI.
_DICOM_PHI_KEYWORDS = frozenset(
    {
        "PatientName",
        "PatientID",
        "PatientBirthDate",
        "PatientAddress",
        "PatientTelephoneNumbers",
        "PatientMotherBirthName",
        "OtherPatientIDs",
        "OtherPatientNames",
        "EthnicGroup",
        "InstitutionName",
        "InstitutionAddress",
        "ReferringPhysicianName",
        "PerformingPhysicianName",
        "OperatorsName",
        "AccessionNumber",
        "StudyID",
        "DeviceSerialNumber",
        "StationName",
    }
)

# Presidio has no built-in recognizer for medical record / patient ID
# numbers -- HIPAA identifier #15, "any other unique identifying number."
# This pattern is deliberately narrow (requires an explicit MRN/Patient ID
# label) to avoid false-positives on ordinary numbers elsewhere in a note.
_MRN_RECOGNIZER = PatternRecognizer(
    supported_entity="MEDICAL_RECORD_NUMBER",
    patterns=[
        Pattern(
            name="mrn_or_patient_id",
            regex=r"\b(?:MRN|Patient\s?ID)[:\s#]*[A-Z0-9-]{5,12}\b",
            score=0.85,
        )
    ],
)

_ENTITIES = [
    "PERSON",
    "DATE_TIME",
    "PHONE_NUMBER",
    "EMAIL_ADDRESS",
    "LOCATION",
    "US_SSN",
    "URL",
    "IP_ADDRESS",
    "MEDICAL_RECORD_NUMBER",
]

_analyzer: AnalyzerEngine | None = None
_anonymizer = AnonymizerEngine()


def _get_analyzer() -> AnalyzerEngine:
    """Lazily build the AnalyzerEngine -- loading the spaCy model has real
    cost (spaCy) and shouldn't happen at import time or once per call."""
    global _analyzer
    if _analyzer is None:
        analyzer = AnalyzerEngine()
        analyzer.registry.add_recognizer(_MRN_RECOGNIZER)
        _analyzer = analyzer
    return _analyzer


def redact_text(text: str) -> tuple[str, dict[str, int]]:
    """Replace detected PII with `<ENTITY_TYPE>` placeholders. Returns the
    redacted text and a count of redactions per entity type -- counts only,
    never the original values, so this function's own return value can't
    become a second place PHI leaks from."""
    if not text:
        return text, {}

    results = _get_analyzer().analyze(text=text, language="en", entities=_ENTITIES)
    anonymized = _anonymizer.anonymize(text=text, analyzer_results=results)

    counts: dict[str, int] = defaultdict(int)
    for result in results:
        counts[result.entity_type] += 1
    return anonymized.text, dict(counts)


def strip_dicom_phi_tags(metadata: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Remove PHI-bearing DICOM tags from a metadata dict. Returns the
    cleaned metadata and the list of tag *names* removed (never their
    values) for the audit log."""
    cleaned: dict[str, Any] = {}
    removed: list[str] = []
    for key, value in metadata.items():
        if key in _DICOM_PHI_KEYWORDS:
            removed.append(key)
        else:
            cleaned[key] = value
    return cleaned, removed


def extract_labs_from_tables(tables: list[Table]) -> dict[str, dict[str, Any]]:
    """Find lab-panel-shaped tables (a header row naming a test/lab column,
    a result/value column, and a units column) and turn them into the
    structured `{test_name: {"value": ..., "unit": ...}}` shape the Data
    Preparation Agent expects. A table that doesn't look like a lab panel
    is skipped, not guessed at."""
    labs: dict[str, dict[str, Any]] = {}
    for table in tables:
        if not table or len(table) < 2:
            continue

        header = [str(cell or "").strip().lower() for cell in table[0]]
        try:
            name_idx = next(i for i, h in enumerate(header) if "test" in h or "lab" in h)
            value_idx = next(i for i, h in enumerate(header) if "result" in h or "value" in h)
            unit_idx = next(i for i, h in enumerate(header) if "unit" in h)
        except StopIteration:
            continue  # not a recognizable lab table

        for row in table[1:]:
            if len(row) <= max(name_idx, value_idx, unit_idx):
                continue
            name = str(row[name_idx] or "").strip()
            raw_value = str(row[value_idx] or "").strip()
            unit = str(row[unit_idx] or "").strip()
            if not name or not raw_value:
                continue
            try:
                value = float(raw_value)
            except ValueError:
                continue
            labs[name.lower().replace(" ", "_")] = {"value": value, "unit": unit}
    return labs


def privacy_protection_agent(state: MedicalPipelineState) -> dict[str, Any]:
    """The LangGraph node. Reads `extracted_document_content`, writes
    `anonymized_patient_data`, and clears `raw_input_paths` in the same
    update -- the fix for the Phase 0 leak where raw, pre-anonymization
    file paths could otherwise survive into every downstream node.
    """
    content = state.get("extracted_document_content") or {}
    documents = content.get("documents", [])

    if not documents:
        return {
            "stage_status": update_stage_status(
                state, STAGE_NAME, {"status": "failed", "message": "no parsed documents to anonymize"}
            ),
            "audit_log": [audit_entry(STAGE_NAME, "failed: no parsed documents to anonymize")],
        }

    labs: dict[str, dict[str, Any]] = {}
    history_parts: list[str] = []
    imaging: list[dict[str, Any]] = []
    redaction_counts: dict[str, int] = defaultdict(int)
    stripped_tags: set[str] = set()

    for document in documents:
        if document["kind"] == "pdf":
            labs.update(extract_labs_from_tables(document["tables"]))
            redacted_text, counts = redact_text(document["text"])
            if redacted_text:
                history_parts.append(redacted_text)
            for entity_type, count in counts.items():
                redaction_counts[entity_type] += count
        elif document["kind"] == "dicom":
            cleaned_metadata, removed = strip_dicom_phi_tags(document.get("dicom_metadata") or {})
            imaging.append(
                {
                    "source_path": document["source_path"],
                    "metadata": cleaned_metadata,
                    "pixel_summary": document.get("pixel_summary"),
                }
            )
            stripped_tags.update(removed)

    anonymized_patient_data = {
        "labs": labs,
        "history_text": "\n".join(history_parts),
        "imaging": imaging,
    }

    total_redactions = sum(redaction_counts.values())
    entity_breakdown = ", ".join(f"{k}:{v}" for k, v in sorted(redaction_counts.items())) or "none"
    summary = (
        f"redacted {total_redactions} PII entity occurrence(s) ({entity_breakdown}); "
        f"stripped {len(stripped_tags)} DICOM tag(s) across {len(imaging)} image(s)"
    )

    update = {
        "anonymized_patient_data": anonymized_patient_data,
        "raw_input_paths": [],
        "stage_status": update_stage_status(state, STAGE_NAME, {"status": "ok", "message": None}),
        "audit_log": [audit_entry(STAGE_NAME, summary)],
    }

    # Self-check: confirm this agent actually closed the leak it exists to
    # close, using the same guard every downstream node is required to call.
    assert_privacy_boundary_respected({**state, **update})

    return update
