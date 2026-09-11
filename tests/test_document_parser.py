"""Tests for the Document Parser Agent. Fixtures are real files generated
at test time -- a valid PDF via reportlab, a valid DICOM file via
pydicom's own dataset classes -- rather than committed binaries, so they
can never drift out of sync with what the parser actually expects.
"""

import numpy as np
import pytest
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

from glassbox_md.agents.document_parser import document_parser_agent, parse_dicom, parse_pdf
from glassbox_md.state import new_stage_status


@pytest.fixture
def sample_pdf(tmp_path):
    path = tmp_path / "lab_report.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    c.drawString(72, 720, "Glucose: 126 mg/dL")
    c.drawString(72, 700, "Patient has T2DM.")
    c.save()
    return str(path)


@pytest.fixture
def sample_dicom(tmp_path):
    path = tmp_path / "scan.dcm"

    file_meta = FileMetaDataset()
    file_meta.MediaStorageSOPClassUID = generate_uid()
    file_meta.MediaStorageSOPInstanceUID = generate_uid()
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian

    ds = Dataset()
    ds.file_meta = file_meta
    ds.SOPClassUID = file_meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
    ds.PatientName = "Test^Synthetic"
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


def _base_state(**overrides):
    state = {"raw_input_paths": [], "stage_status": new_stage_status(), "audit_log": []}
    state.update(overrides)
    return state


# --- parse_pdf -----------------------------------------------------------

def test_parse_pdf_extracts_text(sample_pdf):
    result = parse_pdf(sample_pdf)
    assert result["kind"] == "pdf"
    assert "Glucose: 126 mg/dL" in result["text"]
    assert "T2DM" in result["text"]


def test_parse_pdf_missing_file_raises(tmp_path):
    with pytest.raises(Exception):
        parse_pdf(str(tmp_path / "does_not_exist.pdf"))


# --- parse_dicom -----------------------------------------------------------

def test_parse_dicom_extracts_metadata(sample_dicom):
    result = parse_dicom(sample_dicom)
    assert result["kind"] == "dicom"
    assert result["dicom_metadata"]["Modality"] == "MR"
    assert "Test" in result["dicom_metadata"]["PatientName"]


def test_parse_dicom_extracts_pixel_summary_not_raw_array(sample_dicom):
    result = parse_dicom(sample_dicom)
    assert result["pixel_summary"]["shape"] == (4, 4)
    assert "dtype" in result["pixel_summary"]
    assert "PixelData" not in result["dicom_metadata"]


def test_parse_dicom_corrupt_file_raises(tmp_path):
    bad_path = tmp_path / "corrupt.dcm"
    bad_path.write_bytes(b"not a real dicom file")
    with pytest.raises(Exception):
        parse_dicom(str(bad_path))


# --- document_parser_agent (the LangGraph node) --------------------------

def test_agent_parses_mixed_pdf_and_dicom(sample_pdf, sample_dicom):
    state = _base_state(raw_input_paths=[sample_pdf, sample_dicom])
    result = document_parser_agent(state)
    content = result["extracted_document_content"]
    assert len(content["documents"]) == 2
    assert content["parse_errors"] == []
    assert result["stage_status"]["document_parser"]["status"] == "ok"


def test_agent_reports_error_for_corrupt_file_without_raising(tmp_path, sample_pdf):
    bad_path = tmp_path / "corrupt.dcm"
    bad_path.write_bytes(b"not a real dicom file")
    state = _base_state(raw_input_paths=[sample_pdf, str(bad_path)])

    result = document_parser_agent(state)

    content = result["extracted_document_content"]
    assert len(content["documents"]) == 1
    assert len(content["parse_errors"]) == 1
    assert result["stage_status"]["document_parser"]["status"] == "needs_review"


def test_agent_fails_when_every_file_is_corrupt(tmp_path):
    bad_path = tmp_path / "corrupt.pdf"
    bad_path.write_bytes(b"not a real pdf")
    state = _base_state(raw_input_paths=[str(bad_path)])

    result = document_parser_agent(state)

    assert result["extracted_document_content"]["documents"] == []
    assert result["stage_status"]["document_parser"]["status"] == "failed"


def test_agent_fails_on_no_input_paths():
    result = document_parser_agent(_base_state(raw_input_paths=[]))
    assert result["stage_status"]["document_parser"]["status"] == "failed"


def test_agent_unsupported_extension_recorded_as_parse_error(tmp_path):
    path = tmp_path / "notes.txt"
    path.write_text("plain text file")
    state = _base_state(raw_input_paths=[str(path)])

    result = document_parser_agent(state)

    assert result["extracted_document_content"]["parse_errors"][0]["source_path"] == str(path)
    assert result["stage_status"]["document_parser"]["status"] == "failed"


def test_agent_preserves_other_stages_status():
    state = _base_state(raw_input_paths=[])
    state["stage_status"]["data_preparation"] = {"status": "ok", "message": None}

    result = document_parser_agent(state)

    assert result["stage_status"]["data_preparation"] == {"status": "ok", "message": None}
