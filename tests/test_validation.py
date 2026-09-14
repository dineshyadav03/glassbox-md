"""Phase 9: end-to-end validation across a spread of diverse synthetic
cases, run through the real compiled pipeline (all six agents real;
only the RAG collection and LLM caller are injected fakes, matching
every other phase's own test pattern -- fast, free, deterministic,
without weakening what it actually proves about the real agent code).

Three things this file exists to confirm, per the roadmap's Phase 9 task
list:
  1. The pipeline behaves sensibly across realistic and edge-case
     inputs, not just the one happy-path case Phase 7's capstone test
     already covers -- an implausible lab value, an unrecognized lab
     test, a genuinely empty document, DICOM alongside a lab PDF, and a
     close-call differential.
  2. No PHI-shaped identifier planted in a test document survives past
     the Privacy Protection Agent into ANY downstream state field --
     checked as a blanket structural sweep (serialize the whole
     downstream state, search for each raw planted value), not just the
     one history_text field Phase 3's own test already checked.
  3. Imaging-only input (an MRI or X-ray with no lab report or history
     text) reaches a full report instead of dying partway through --
     added after a live manual test of the running app surfaced a real
     bug: the RAG and Diagnostic Prediction agents both only looked at
     labs/history text, so an imaging-only case hard-failed before the
     model ever got a chance to reason over the image. See the module
     docstrings in medical_knowledge_rag.py and diagnostic_prediction.py.
"""

import json

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
from reportlab.platypus import Table, TableStyle

from glassbox_md.agents.diagnostic_prediction import DifferentialCondition, ModelDifferentialResponse
from glassbox_md.agents.medical_knowledge_rag import build_literature_collection
from glassbox_md.pipeline import build_pipeline_graph
from glassbox_md.state import new_stage_status


def _make_pdf(tmp_path, filename, lines, table=None):
    path = tmp_path / filename
    c = canvas.Canvas(str(path), pagesize=letter)
    y = 750
    for line in lines:
        c.drawString(72, y, line)
        y -= 20
    if table:
        t = Table(table)
        t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)]))
        t.wrapOn(c, 400, 200)
        t.drawOn(c, 72, max(y - 100, 50))
    c.save()
    return str(path)


def _make_dicom(tmp_path, filename, patient_name="Test^Synthetic"):
    path = tmp_path / filename
    file_meta = FileMetaDataset()
    file_meta.MediaStorageSOPClassUID = generate_uid()
    file_meta.MediaStorageSOPInstanceUID = generate_uid()
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian

    ds = Dataset()
    ds.file_meta = file_meta
    ds.SOPClassUID = file_meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
    ds.PatientName = patient_name
    ds.Modality = "MR"
    ds.Rows, ds.Columns = 4, 4
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    ds.PixelData = np.zeros((4, 4), dtype=np.uint16).tobytes()
    ds.save_as(str(path), enforce_file_format=True)
    return str(path)


def _initial_state(paths):
    return {
        "raw_input_paths": paths,
        "extracted_document_content": {},
        "anonymized_patient_data": {},
        "structured_clinical_data": {},
        "rag_literature_context": [],
        "diagnostic_prediction_result": {},
        "final_explainable_report": None,
        "stage_status": new_stage_status(),
        "audit_log": [],
    }


def _fake_llm(confidence=0.8, conditions=None):
    def caller(prompt, image_path):
        return ModelDifferentialResponse(
            differential=conditions
            or [DifferentialCondition(condition="type 2 diabetes", likelihood=confidence, supporting_evidence=["x"])],
            overall_confidence=confidence,
            reasoning_notes="synthetic validation reasoning",
        )

    return caller


def _rag_collection(tmp_path):
    return build_literature_collection(
        [
            {
                "pmid": "111",
                "title": "Type 2 diabetes management",
                "abstract": "Glucose control strategies for type 2 diabetes patients.",
                "url": "https://pubmed.ncbi.nlm.nih.gov/111/",
            },
            {
                "pmid": "222",
                "title": "Coronary artery disease risk factors",
                "abstract": "Hypertension and hyperlipidemia are risk factors for coronary artery disease.",
                "url": "https://pubmed.ncbi.nlm.nih.gov/222/",
            },
        ],
        persist_directory=str(tmp_path / "chroma"),
    )


# --- Case 1: clean diabetes case ------------------------------------------

def test_case_clean_diabetes(tmp_path):
    table = [["Test", "Result", "Units"], ["Glucose", "180", "mg/dL"]]
    pdf = _make_pdf(tmp_path, "c1.pdf", ["History: Patient has type 2 diabetes, reports fatigue."], table=table)
    graph = build_pipeline_graph(llm_caller=_fake_llm(0.85), rag_collection=_rag_collection(tmp_path))

    result = graph.invoke(_initial_state([pdf]))

    assert result["final_explainable_report"] is not None
    assert result["final_explainable_report"]["disagreement_flagged"] is False
    assert result["stage_status"]["diagnostic_prediction"]["status"] == "ok"


# --- Case 2: clean coronary artery disease case ---------------------------

def test_case_clean_cad(tmp_path):
    table = [["Test", "Result", "Units"], ["Total Cholesterol", "260", "mg/dL"]]
    pdf = _make_pdf(tmp_path, "c2.pdf", ["History: Patient has coronary artery disease and hypertension."], table=table)
    graph = build_pipeline_graph(
        llm_caller=_fake_llm(
            0.7, [DifferentialCondition(condition="coronary artery disease", likelihood=0.7, supporting_evidence=["cholesterol elevated"])]
        ),
        rag_collection=_rag_collection(tmp_path),
    )

    result = graph.invoke(_initial_state([pdf]))

    assert result["final_explainable_report"] is not None
    assert result["stage_status"]["data_preparation"]["status"] == "ok"


# --- Case 3: implausible lab value is flagged, not blocked ----------------

def test_case_implausible_lab_value_flagged_not_blocked(tmp_path):
    table = [["Test", "Result", "Units"], ["Glucose", "7", "mg/dL"]]  # a real mmol/L value mistagged
    pdf = _make_pdf(tmp_path, "c3.pdf", ["History: Patient has type 2 diabetes."], table=table)
    graph = build_pipeline_graph(llm_caller=_fake_llm(0.6), rag_collection=_rag_collection(tmp_path))

    result = graph.invoke(_initial_state([pdf]))

    assert result["stage_status"]["data_preparation"]["status"] == "needs_review"
    assert result["final_explainable_report"] is not None  # needs_review doesn't halt the pipeline


# --- Case 4: unrecognized lab test halts cleanly, no crash ----------------

def test_case_unknown_lab_test_halts_cleanly(tmp_path):
    table = [["Test", "Result", "Units"], ["Vitamin D", "30", "ng/mL"]]
    pdf = _make_pdf(tmp_path, "c4.pdf", ["History: routine checkup."], table=table)
    graph = build_pipeline_graph(llm_caller=_fake_llm(0.8), rag_collection=_rag_collection(tmp_path))

    result = graph.invoke(_initial_state([pdf]))

    assert result["stage_status"]["data_preparation"]["status"] == "failed"
    assert result["final_explainable_report"] is None
    assert result["stage_status"]["medical_knowledge_rag"]["status"] == "pending"


# --- Case 5: a genuinely empty document halts cleanly at RAG --------------

def test_case_empty_document_still_produces_an_explained_report(tmp_path):
    """No text, no table, no imaging at all -- every stage should still
    run and produce a real "insufficient evidence" report, not silently
    die partway through. (An earlier version hard-failed at RAG and
    stopped there with no report at all; that's the bug the imaging-only
    fix in this same session corrected -- this case exercises the same
    fix from the "nothing whatsoever" end of the spectrum.)"""
    pdf = _make_pdf(tmp_path, "c5.pdf", [])  # no text, no table at all
    graph = build_pipeline_graph(llm_caller=_fake_llm(0.8), rag_collection=_rag_collection(tmp_path))

    result = graph.invoke(_initial_state([pdf]))

    assert result["stage_status"]["document_parser"]["status"] == "ok"
    assert result["stage_status"]["privacy_protection"]["status"] == "ok"
    assert result["stage_status"]["data_preparation"]["status"] == "ok"
    assert result["stage_status"]["medical_knowledge_rag"]["status"] == "needs_review"
    assert result["stage_status"]["diagnostic_prediction"]["status"] == "needs_review"
    assert result["diagnostic_prediction_result"]["abstained"] is True

    report = result["final_explainable_report"]
    assert report is not None
    assert "insufficient evidence" in report["narrative"].lower()
    assert report["disagreement_flagged"] is True


# --- Case 6: DICOM imaging alongside a lab PDF ----------------------------

def test_case_dicom_imaging_alongside_labs(tmp_path):
    table = [["Test", "Result", "Units"], ["Glucose", "150", "mg/dL"]]
    pdf = _make_pdf(tmp_path, "c6.pdf", ["History: Patient has type 2 diabetes."], table=table)
    dicom = _make_dicom(tmp_path, "c6.dcm")
    graph = build_pipeline_graph(llm_caller=_fake_llm(0.75), rag_collection=_rag_collection(tmp_path))

    result = graph.invoke(_initial_state([pdf, dicom]))

    assert result["final_explainable_report"] is not None
    imaging = result["anonymized_patient_data"]["imaging"]
    assert len(imaging) == 1
    assert "PatientName" not in imaging[0]["metadata"]


# --- Case 9: imaging ONLY -- an MRI/X-ray with no lab report or history --

def test_case_imaging_only_reaches_a_full_report(tmp_path):
    """Regression test for a real bug this exact question surfaced: an
    MRI or X-ray with nothing else attached used to hard-fail at the RAG
    stage (no text to build a literature query with) and never reach
    Diagnostic Prediction at all -- silently defeating the multimodal
    design for the one case it exists to handle. Both fixes are
    exercised together here, end to end, not just in isolation."""
    dicom = _make_dicom(tmp_path, "c9.dcm")
    graph = build_pipeline_graph(llm_caller=_fake_llm(0.7), rag_collection=_rag_collection(tmp_path))

    result = graph.invoke(_initial_state([dicom]))

    assert result["stage_status"]["medical_knowledge_rag"]["status"] == "needs_review"
    assert result["stage_status"]["diagnostic_prediction"]["status"] == "ok"
    assert result["final_explainable_report"] is not None


# --- Case 7: a close-call differential is flagged for review --------------

def test_case_close_call_differential_flagged(tmp_path):
    table = [["Test", "Result", "Units"], ["Glucose", "140", "mg/dL"]]
    pdf = _make_pdf(tmp_path, "c7.pdf", ["History: Patient presents with ambiguous symptoms."], table=table)
    conditions = [
        DifferentialCondition(condition="type 2 diabetes", likelihood=0.5, supporting_evidence=["a"]),
        DifferentialCondition(condition="coronary artery disease", likelihood=0.48, supporting_evidence=["b"]),
    ]
    graph = build_pipeline_graph(llm_caller=_fake_llm(0.5, conditions), rag_collection=_rag_collection(tmp_path))

    result = graph.invoke(_initial_state([pdf]))

    assert result["final_explainable_report"]["disagreement_flagged"] is True


# --- Case 8: planted PII swept across the ENTIRE downstream state ---------

_PLANTED = {
    "name": "Priyanka Menon",
    "dob": "November 2, 1978",
    "ssn": "418-27-9053",  # not the canonical 123-45-6789 -- see test_privacy_protection.py
    "mrn": "8823410",
    "dicom_patient_name": "Rao^Priyanka",
}


def test_case_planted_pii_absent_from_entire_final_state(tmp_path):
    table = [["Test", "Result", "Units"], ["Glucose", "160", "mg/dL"]]
    pdf = _make_pdf(
        tmp_path,
        "c8.pdf",
        [
            f"Patient: {_PLANTED['name']}",
            f"DOB: {_PLANTED['dob']}",
            f"SSN: {_PLANTED['ssn']}",
            f"MRN: {_PLANTED['mrn']}",
            "History: Patient has type 2 diabetes.",
        ],
        table=table,
    )
    dicom = _make_dicom(tmp_path, "c8.dcm", patient_name=_PLANTED["dicom_patient_name"])

    graph = build_pipeline_graph(
        llm_caller=_fake_llm(
            0.8, [DifferentialCondition(condition="type 2 diabetes", likelihood=0.8, supporting_evidence=["glucose elevated"])]
        ),
        rag_collection=_rag_collection(tmp_path),
    )

    result = graph.invoke(_initial_state([pdf, dicom]))

    # Serialize everything a clinician, a log, or a future case-
    # persistence layer could ever see, and confirm none of the planted
    # raw identifiers survive anywhere in it -- not just the one field
    # Phase 3's own test already checked.
    downstream_state = {
        key: value
        for key, value in result.items()
        if key not in ("raw_input_paths", "extracted_document_content")  # pre-anonymization by design
    }
    serialized = json.dumps(downstream_state, default=str)

    for label, value in _PLANTED.items():
        assert value not in serialized, f"{label} leaked into downstream state: {value!r}"

    assert result["raw_input_paths"] == []  # the Phase 0 leak fix, exercised end to end again
