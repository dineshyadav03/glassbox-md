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

Coverage against the 18 HIPAA Safe Harbor identifiers (45 CFR
164.514(b)(2)(i)(A)-(R)), given as one status per category rather than
one headline number. An earlier revision of this docstring and the
README said "12 of 18", which doesn't hold under any single counting
rule: it only reconstructs by counting phone and fax as one item and
leaving medical record numbers and DICOM device tags out of the tally,
while still counting (B), (I), (K) and (L) as covered although each was
only partly handled. The rule used
here: a category is "addressed" if some detector in this module redacts
a realistic synthetic value of it (tests/test_privacy_protection.py
asserts one per detector), and it is flagged "partial" wherever a
sub-identifier HIPAA names under it is still missed. Counted across both
input modalities (PDF text and DICOM metadata): 16 of 18 addressed
((P) and (Q) are not); of those 16, 7 are complete in kind, 4 fire only
behind an explicit label, and 5 are partial. Adding license-plate and
free-text device recognizers moved no category count -- (L) was already
addressed through VINs and now also covers plates, and (M) was already
addressed through DICOM tags and now also covers free text. "Complete in
kind" means no identifier type HIPAA lists under the category is
unhandled, not that recall is perfect (see the spaCy note below). README's
"Known limitations" should carry these same tiers.
  addressed, complete in kind (7)
    (A) names                      -- PERSON (spaCy NER)
    (D) telephone numbers          -- PHONE_NUMBER
    (E) fax numbers                -- PHONE_NUMBER (shape-based, so a
                                      "Fax:" label neither helps nor is
                                      needed)
    (F) email addresses            -- EMAIL_ADDRESS
    (G) SSNs                       -- US_SSN
    (N) web URLs                   -- URL
    (O) IP addresses               -- IP_ADDRESS
  addressed, but only behind an explicit label (4) -- an explicit label
  must immediately precede the value, so the same string written bare
  elsewhere in a note is deliberately NOT redacted (a bare number would
  otherwise be mistaken for an ordinary lab value at threshold 0)
    (H) medical record numbers     -- MEDICAL_RECORD_NUMBER ("MRN:",
                                      "Patient ID")
    (J) account numbers            -- ACCOUNT_NUMBER ("Account #:")
    (L) vehicle identifiers and    -- VEHICLE_IDENTIFICATION_NUMBER
        serial numbers                ("VIN:") and VEHICLE_LICENSE_PLATE
                                      ("License Plate", "Plate No./
                                      Number/#", "Tag #"): both halves
                                      HIPAA names. A plate with no digit
                                      at all (some vanity plates) is not
                                      caught -- see the recognizer
    (M) device identifiers and     -- DEVICE_IDENTIFIER in free text
        serial numbers                ("Serial Number(s)"/"Serial No."/
                                      "Serial:"/"S/N"/"SN:"/"Device
                                      ID"/"Device Number"/"UDI"). UDI is
                                      matched by its real structure (GS1
                                      "(01)..(21).." groups, HIBC "+...",
                                      or 8-14 digits), because a bare
                                      "UDI" is also the Urogenital
                                      Distress Inventory ("UDI-6/IIQ-7").
                                      Plus
                                      unconditional DICOM tag stripping
                                      (DeviceSerialNumber) in imaging
                                      metadata. The bare word "serial"
                                      never triggers
  addressed, partial (5)
    (B) geographic subdivisions    -- cities, counties and states via
                                      spaCy LOCATION. A street *name* is
                                      tagged but its number survives, and
                                      ZIP codes are not reliably caught
                                      (a bare "ZIP: 90210" passes through)
    (C) dates                      -- DATE_TIME redacts every date
                                      element, year included (stricter
                                      than Safe Harbor needs). Ages over
                                      89 are caught only as "N years old";
                                      "aged 93", "93 y/o" and "Age: 91"
                                      pass through
    (I) health plan beneficiary    -- Medicare only (US_MBI, a fixed
        numbers                       format); commercial member, policy
                                      and group IDs are not caught
    (K) certificate/license        -- DEA-format only (MEDICAL_LICENSE,
        numbers                       a real Luhn checksum); driver's
                                      license, state medical license and
                                      other certificates are not caught
                                      (US_DRIVER_LICENSE is rejected,
                                      below)
    (R) any other unique number,   -- open-ended by definition; only
        characteristic or code        US_ITIN is added, a materially
                                      different identifier shape from
                                      the label-gated numbers above
  not addressed (2) -- (P) biometric identifiers and (Q) full-face
  photographs / comparable images; see the NOT covered entry below
  explicitly NOT added, despite being  -- US_BANK_NUMBER, US_DRIVER_
  auto-registered by a plain              LICENSE, US_PASSPORT. Read
  AnalyzerEngine()                        their actual patterns: each
                                           one's weakest/only pattern is
                                           an unconstrained N-digit-number
                                           match (US_BANK_NUMBER is
                                           solely `\b[0-9]{8,17}\b` at
                                           score 0.05; US_PASSPORT's weak
                                           pattern is `\b[0-9]{9}\b` at
                                           0.05; US_DRIVER_LICENSE's
                                           weakest is
                                           `\b([0-9]{6,14}|[0-9]{16})\b`
                                           at 0.01). This module's
                                           `default_score_threshold` is 0
                                           (see `_get_analyzer`), so none
                                           of these would be filtered by
                                           confidence -- adding them would
                                           very likely redact ordinary
                                           clinical content (accession
                                           numbers, reference values, any
                                           bare multi-digit string) right
                                           alongside a real bank account
                                           or driver's license number. A
                                           `LemmaContextAwareEnhancer` is
                                           active by default and can
                                           raise scores near a context
                                           word ("bank", "account"), but
                                           never lowers a non-matching
                                           score below the pattern's own
                                           floor -- it doesn't change this
                                           conclusion at threshold 0.
                                           Found by reading Presidio's own
                                           source, not assumed.
  NOT covered (documented limitation,  -- biometric identifiers -- not
  not silently ignored)                   just "not done yet": genuinely
                                           inapplicable to this project's
                                           input modalities (a fingerprint
                                           or voiceprint isn't text- or
                                           DICOM-metadata-representable in
                                           the way this pipeline consumes
                                           documents). Full-face
                                           photographs / pixel-level
                                           DICOM defacing -- a genuinely
                                           different technical domain
                                           (computer vision, not NLP/
                                           regex), disproportionate to
                                           this MVP's scope, a V3+ item.
                                           Values with no label -- a
                                           plate, serial number, MRN or
                                           account number written bare
                                           on its own -- pass through:
                                           label-gating trades that
                                           recall for not over-redacting
                                           ordinary numbers at threshold
                                           0. The plate and device
                                           recognizers also miss a value
                                           on the line *below* its label
                                           (same-line only; see them),
                                           only take the first serial in a
                                           list ("Serial Numbers: LV123456,
                                           RA234567" redacts LV123456),
                                           and skip
                                           plates with no digit. "Tag #"
                                           and "Tag Number" can also match
                                           a non-vehicle asset tag.
                                           Web URLs embedded in scanned
                                           image content -- an OCR gap
                                           (pdfplumber doesn't OCR
                                           image-only content), not a
                                           redaction gap; see the Document
                                           Parser's own dependency
                                           decisions for why.

spaCy model: en_core_web_lg (~587MB). `AnalyzerEngine()` with no
`nlp_engine` argument loads it by default, and this module never
configured anything else. An earlier revision of this docstring, the
README and requirements.txt said en_core_web_sm; that was never what ran
-- found while setting up CI, where the smaller model was installed but
the tests still passed only because Presidio silently downloads _lg at
first use. Switching to the ~15MB _sm would lower named-entity recall on
names, the one thing this agent has no structural check for, so it needs
measuring before anyone does it. Either way this is recall on synthetic
test text, not a claim of production-grade recall on messy real-world
text.

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

import spacy.util
from presidio_analyzer import AnalyzerEngine, Pattern, PatternRecognizer
from presidio_analyzer.predefined_recognizers import UsMbiRecognizer
from presidio_anonymizer import AnonymizerEngine

from ..audit import audit_entry
from ..state import MedicalPipelineState, assert_privacy_boundary_respected, update_stage_status
from .document_parser import Table

STAGE_NAME = "privacy_protection"

# The model Presidio's default AnalyzerEngine() loads; see the module
# docstring's "spaCy model" note.
SPACY_MODEL = "en_core_web_lg"

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

# Score for every label-gated recognizer below. Above spaCy NER's default
# 0.85, on purpose: a label-gated match is the more precise signal, and
# when both cover the same span ("MRN4471829" is one token that NER tags
# PERSON) an equal score left the winner to PYTHONHASHSEED -- 3 of 8 seeds
# reported PERSON instead of MEDICAL_RECORD_NUMBER. The value was redacted
# either way, but the audit log's entity counts were nondeterministic.
_LABEL_GATED_SCORE = 0.95

# Presidio has no built-in recognizer for medical record / patient ID
# numbers -- HIPAA identifier (H). This pattern is deliberately narrow
# (requires an explicit MRN/Patient ID label) to avoid false-positives on
# ordinary numbers elsewhere in a note.
#
# Presidio compiles every pattern case-insensitively, so two guards matter
# here: the label must not run on into a longer word ("Patient identified
# by two identifiers" used to read as "Patient id" + "entified" and got
# redacted), and the value must contain a digit ("MRN: pending" is not an
# MRN). Both were found by review, not hypothesized.
_MRN_RECOGNIZER = PatternRecognizer(
    supported_entity="MEDICAL_RECORD_NUMBER",
    patterns=[
        Pattern(
            name="mrn_or_patient_id",
            regex=r"\b(?:MRN|Patient\s?ID)(?![A-Z])[:\s#]*(?=[A-Z0-9-]*\d)[A-Z0-9-]{5,12}\b",
            score=_LABEL_GATED_SCORE,
        )
    ],
)

# Horizontal whitespace only -- `[^\S\r\n]` is "any whitespace except a
# line break", so it covers the non-breaking and thin spaces that Word- and
# HTML-derived PDF text puts after a colon (a literal `[ \t]` class missed
# them and left the value unredacted), without letting a label at the end
# of a line claim the first token of the next line.
_HWS = r"[^\S\r\n]"
_LABEL_GAP = rf"(?:[:#]|{_HWS})*"

# Same label-gated strategy as the MRN recognizer above -- HIPAA identifier
# (J) (account numbers). Presidio's own US_BANK_NUMBER recognizer exists
# but its only pattern is an unconstrained \b[0-9]{8,17}\b (score 0.05,
# i.e. "any 8-17 digit number") -- at this module's default_score_threshold
# of 0, that would redact ordinary clinical numbers (accession numbers,
# reference values) right alongside a real account number. Requiring an
# explicit label instead of leaning on a weak confidence score is the same
# fix already proven for MRN.
_ACCOUNT_NUMBER_RECOGNIZER = PatternRecognizer(
    supported_entity="ACCOUNT_NUMBER",
    patterns=[
        Pattern(
            name="account_number",
            regex=r"\b(?:Account(?:\s?(?:No\.?|Number))?|Acct\.?)[:\s#]*[0-9-]{6,17}\b",
            score=_LABEL_GATED_SCORE,
        )
    ],
)

# HIPAA identifier (L) (vehicle identifiers) -- the VIN half; license
# plates are the separate recognizer below. The charset excludes I/O/Q,
# per the real ISO 3779 VIN standard (those letters are excluded
# specifically to avoid confusion with 1/0), which is real structural
# precision, not just a label gate -- but the label is still required
# too, for the same false-positive-avoidance reason as MRN and
# ACCOUNT_NUMBER above.
_VIN_RECOGNIZER = PatternRecognizer(
    supported_entity="VEHICLE_IDENTIFICATION_NUMBER",
    patterns=[
        Pattern(
            name="vin",
            regex=r"\b(?:VIN|Vehicle\s+Identification\s+Number)[:\s#]*[A-HJ-NPR-Z0-9]{17}\b",
            score=_LABEL_GATED_SCORE,
        )
    ],
)

# HIPAA identifier (L)'s other half, license plate numbers. The reason this
# was previously excluded -- plate formats vary too much by state/country
# for a *generic* pattern -- is exactly why this one is not generic: the
# label ("License Plate", "Plate No./Number/#", "Tag #") does the gating and
# the value shapes below only need to cover common plate layouts, not
# every jurisdiction's. Two guards beyond the label keep ordinary text
# safe at threshold 0: the label forms are spelled out (bare "plate" and
# "Platelet" never match, so "platelet count 250" and "plate 3 of the
# culture" pass through), and every value must contain a digit, so
# "License plate: pending" is left alone. Plates with no digit at all
# (some vanity plates) are a deliberate miss for that reason. "Tag #" is the
# loosest label here (it also fits an asset tag), which the digit rule
# and the 5-8 character floor/ceiling on the value have to absorb.
_LICENSE_PLATE_RECOGNIZER = PatternRecognizer(
    supported_entity="VEHICLE_LICENSE_PLATE",
    patterns=[
        Pattern(
            name="license_plate",
            regex=(
                rf"\b(?:(?:License|Licence|Vehicle){_HWS}+Plate(?:{_HWS}+(?:No\b\.?|Number\b|#))?"
                rf"|License-Plate|Plate{_HWS}*(?:No\b\.?|Number\b|#)|Tag{_HWS}*(?:#|No\b\.?|Number\b))"
                rf"{_LABEL_GAP}"
                r"(?:"
                # US layouts, with an optional trailing "-N" segment
                r"[A-Z]{2,3}[ -]\d{3,4}(?:-\d{1,2})?"
                r"|\d{3,4}[ -][A-Z]{2,3}"
                r"|[A-Z]{2,3}[ -]\d{2}[ -]\d{2}"
                # state prefix ("CA 7ABC123") and UK current-style ("AB12 CDE")
                r"|[A-Z]{2} \d[A-Z0-9]{5,6}"
                r"|[A-Z]{2}\d{2} ?[A-Z]{3}"
                # contiguous fallback, must contain a digit
                r"|(?=[A-Z0-9]*\d)[A-Z0-9]{5,8}"
                r")\b"
            ),
            score=_LABEL_GATED_SCORE,
        )
    ],
)

# HIPAA identifier (M) (device identifiers and serial numbers). Before this
# only DICOM tags (DeviceSerialNumber) were stripped, which never touched a
# serial number typed into free text ("Pacemaker Serial No. ..."). Same
# label-gated strategy as MRN/ACCOUNT_NUMBER: the label forms are spelled
# out so the word "serial" on its own ("serial creatinine 1.2", "serial
# testing", "serial nodules") never triggers, and `No\b` keeps "nodules"
# from reading as "No". The value must also contain a digit, so "Serial
# number: not recorded" or "Device ID pending" is left alone -- real
# serials are effectively always alphanumeric with digits, and this is the
# structural precision that stands in for a checksum, which device serials
# don't have. The second pattern handles UDI strings, whose human-readable
# form carries parentheses and (for HIBC) "+" and "/" (handled by the
# second pattern below). The label-to-value gap is same-line only
# (_LABEL_GAP: horizontal whitespace incl. NBSP, not \s like the older
# recognizers): with \s, a
# heading that ends a line ("Serial Number") claimed the first token of
# the next line ("HbA1c") -- found by probing, not hypothesized. The cost,
# a value on the line *below* its label going unredacted, applies to the
# plate recognizer above too.
_DEVICE_IDENTIFIER_RECOGNIZER = PatternRecognizer(
    supported_entity="DEVICE_IDENTIFIER",
    patterns=[
        Pattern(
            name="device_serial_or_id",
            regex=(
                rf"\b(?:(?:Device{_HWS}+)?Serial{_HWS}*(?:No\b\.?|Numbers?\b|#|:)"
                rf"|Device{_HWS}*(?:ID|Identifier|No\b\.?|Number\b|#)(?![A-Z])"
                rf"|S/N\b|SN{_HWS}*[:#])"
                rf"{_LABEL_GAP}"
                r"(?:"
                # optional short letter prefix that splits a serial ("PM 4482917")
                rf"[A-Z]{{1,3}}{_HWS}(?=[A-Z0-9./-]*\d)"
                r"|"
                r")"
                # first digit-bearing token, >= 5 chars, may contain / . - so a
                # serial like "AB123/4567" isn't cut at the slash
                r"(?=[A-Z0-9./-]{5})(?=[A-Z0-9./-]*\d)[A-Z0-9](?:[A-Z0-9./-]*[A-Z0-9])?"
                # up to three more space-separated digit-bearing groups
                rf"(?:{_HWS}(?=[A-Z0-9./-]{{3}})(?=[A-Z0-9./-]*\d)[A-Z0-9](?:[A-Z0-9./-]*[A-Z0-9])?){{0,3}}"
            ),
            score=_LABEL_GATED_SCORE,
        ),
        # UDI needs its real structure, not just the label: a bare "UDI"
        # is also the Urogenital Distress Inventory ("UDI-6/IIQ-7", "UDI 6
        # months") and matched those under a looser value class. A real
        # human-readable UDI is GS1 application identifiers "(01)...(17)..."
        # (spaces allowed between them), HIBC "+...", or a bare 8-14 digit
        # device identifier -- all of which are structurally distinct from
        # a questionnaire name.
        Pattern(
            name="udi",
            regex=(
                rf"\bUDI(?:[-\s]?(?:DI|PI))?\b(?:[:#]|{_HWS})+"
                r"(?:"
                rf"\(\d{{2}}\)[A-Z0-9]{{1,30}}(?:{_HWS}?\(\d{{2}}\)[A-Z0-9]{{1,30}}){{0,5}}"
                r"|\+[A-Z0-9]{8,40}(?:/[A-Z0-9]{1,20})*"
                r"|\d{8,14}"
                r")\b"
            ),
            score=_LABEL_GATED_SCORE,
        ),
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
    # Already auto-registered by a plain AnalyzerEngine() -- just not
    # previously requested. See the module docstring for why these three
    # (real structural constraints, not a bare digit-count regex) and not
    # US_BANK_NUMBER/US_DRIVER_LICENSE/US_PASSPORT (unconstrained N-digit
    # matches -- a real over-redaction risk at this module's threshold).
    "MEDICAL_LICENSE",
    "US_ITIN",
    # Not auto-registered -- explicitly added in _get_analyzer() below,
    # same treatment as the custom recognizers.
    "US_MBI",
    "ACCOUNT_NUMBER",
    "VEHICLE_IDENTIFICATION_NUMBER",
    "VEHICLE_LICENSE_PLATE",
    "DEVICE_IDENTIFIER",
]

_analyzer: AnalyzerEngine | None = None
_anonymizer = AnonymizerEngine()


def _get_analyzer() -> AnalyzerEngine:
    """Lazily build the AnalyzerEngine -- loading the spaCy model has real
    cost (spaCy) and shouldn't happen at import time or once per call.

    default_score_threshold is left at its default of 0 (every match is
    kept regardless of confidence) -- this is exactly why entity choice
    above leans on real structural precision (a checksum, a constrained
    digit-range, an explicit label) rather than a recognizer's own
    confidence score to avoid false positives; see the module docstring.
    """
    global _analyzer
    if _analyzer is None:
        # Presidio's own fallback for a missing model is to run
        # `spacy download` mid-request -- ~587MB, and in an environment
        # without pip it raises SystemExit, which is not an Exception and
        # can take the whole app down instead of failing one case.
        if not spacy.util.is_package(SPACY_MODEL):
            raise RuntimeError(
                f"spaCy model {SPACY_MODEL} is not installed; run: "
                f"python -m spacy download {SPACY_MODEL}"
            )
        analyzer = AnalyzerEngine()
        analyzer.registry.add_recognizer(_MRN_RECOGNIZER)
        analyzer.registry.add_recognizer(_ACCOUNT_NUMBER_RECOGNIZER)
        analyzer.registry.add_recognizer(_VIN_RECOGNIZER)
        analyzer.registry.add_recognizer(_LICENSE_PLATE_RECOGNIZER)
        analyzer.registry.add_recognizer(_DEVICE_IDENTIFIER_RECOGNIZER)
        analyzer.registry.add_recognizer(UsMbiRecognizer())
        _analyzer = analyzer
    return _analyzer


def redact_text(text: str) -> tuple[str, dict[str, int]]:
    """Replace detected PII with `<ENTITY_TYPE>` placeholders. Returns the
    redacted text and a count of redactions per entity type -- counts only,
    never the original values, so this function's own return value can't
    become a second place PHI leaks from.

    Counts are built from `anonymized.items` (the anonymizer's own
    conflict-resolved output), not the raw `results` list -- two
    recognizers can match overlapping spans (e.g. US_ITIN's valid range
    structurally overlaps US_SSN's shape-only pattern; nothing on the
    SSN side excludes ITIN's 900+ prefix), and the anonymizer correctly
    collapses that to one redaction. Counting from raw `results` would
    silently inflate the audit log with a "phantom" second entity that
    was never actually its own redaction, just a losing overlap
    candidate -- found while adding US_ITIN, not hypothesized.
    """
    if not text:
        return text, {}

    results = _get_analyzer().analyze(text=text, language="en", entities=_ENTITIES)
    anonymized = _anonymizer.anonymize(text=text, analyzer_results=results)

    counts: dict[str, int] = defaultdict(int)
    for item in anonymized.items:
        counts[item.entity_type] += 1
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
