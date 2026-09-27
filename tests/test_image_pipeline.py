"""A PNG/JPEG uploaded on its own, end to end: it must reach the model as pixels
only, and nothing from its metadata may appear anywhere in the pipeline state."""

import base64
import io
import json

import pytest
from PIL import Image, PngImagePlugin

from glassbox_md.agents import diagnostic_prediction as dp
from glassbox_md.agents.diagnostic_prediction import (
    DifferentialCondition,
    ModelDifferentialResponse,
    _load_image_for_prompt,
    _load_images_for_prompt,
    backend_description,
    diagnostic_prediction_agent,
)
from glassbox_md.agents.medical_knowledge_rag import build_literature_collection
from glassbox_md.agents.privacy_protection import privacy_protection_agent
from glassbox_md.pipeline import build_pipeline_graph
from glassbox_md.state import new_stage_status

PHI = "Jane Q. Patient"


def _jpeg_with_phi(tmp_path, name="phone.jpg"):
    exif = Image.Exif()
    exif[0x013B] = PHI
    exif[0x010F] = "AcmeScanner"
    path = tmp_path / name
    Image.new("L", (64, 48), 100).save(path, format="JPEG", exif=exif)
    return str(path)


def _png_with_phi(tmp_path, name="export.png"):
    info = PngImagePlugin.PngInfo()
    info.add_text("Author", PHI)
    path = tmp_path / name
    Image.new("L", (64, 48), 100).save(path, format="PNG", pnginfo=info)
    return str(path)


def _fake_response(confidence=0.7):
    return ModelDifferentialResponse(
        differential=[DifferentialCondition(condition="No acute abnormality", likelihood=0.7, supporting_evidence=["clear"])],
        overall_confidence=confidence,
        reasoning_notes="image only",
    )


class _Recorder:
    def __init__(self):
        self.calls = []

    def __call__(self, prompt, image_paths):
        self.calls.append((prompt, list(image_paths)))
        return _fake_response()


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


@pytest.fixture
def empty_collection(tmp_path):
    return build_literature_collection([], persist_directory=str(tmp_path / "chroma"))


# --- what is loaded for the model ------------------------------------------------------

@pytest.mark.parametrize("make", [_jpeg_with_phi, _png_with_phi])
def test_load_image_for_prompt_returns_metadata_free_png(tmp_path, make):
    path = make(tmp_path)
    assert PHI.encode() in open(path, "rb").read()  # the fixture does carry it

    data, mime = _load_image_for_prompt(path)

    assert mime == "image/png" and data.startswith(b"\x89PNG")
    assert PHI.encode() not in data and b"AcmeScanner" not in data


def test_load_image_for_prompt_returns_none_for_a_broken_image_instead_of_raising(tmp_path):
    bad = tmp_path / "bad.png"
    bad.write_bytes(b"not an image")
    assert _load_image_for_prompt(str(bad)) is None
    assert _load_images_for_prompt([str(bad), _png_with_phi(tmp_path)])[0][1] == "image/png"  # the good one still loads


class _CaptureClient:
    """Stands in for the OpenAI client; records the request the model would get."""

    def __init__(self, **_):
        self.requests = []
        outer = self

        class _Completions:
            def create(self, **kwargs):
                outer.requests.append(kwargs)
                from types import SimpleNamespace

                content = json.dumps(
                    {"differential": [], "overall_confidence": 0.5, "reasoning_notes": "x"}
                )
                return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))], model="m")

        self.chat = type("_Chat", (), {"completions": _Completions()})()


def test_the_request_sent_to_the_model_contains_no_image_metadata(tmp_path, monkeypatch):
    client = _CaptureClient()
    monkeypatch.setattr(dp, "OpenAI", lambda **kw: client)
    monkeypatch.setenv("OPENROUTER_API_KEY", "k")

    dp._default_caller("prompt", [_jpeg_with_phi(tmp_path), _png_with_phi(tmp_path)])

    request = client.requests[0]
    blob = json.dumps(request["messages"])
    assert PHI not in blob and "AcmeScanner" not in blob
    parts = [p for p in request["messages"][1]["content"] if p["type"] == "image_url"]
    assert len(parts) == 2
    for part in parts:
        url = part["image_url"]["url"]
        assert url.startswith("data:image/png;base64,")
        png = base64.b64decode(url.split(",", 1)[1])
        assert PHI.encode() not in png and Image.open(io.BytesIO(png)).format == "PNG"


# --- through the privacy agent ---------------------------------------------------------

def test_privacy_agent_turns_an_image_document_into_an_imaging_entry_with_no_metadata(tmp_path):
    path = _jpeg_with_phi(tmp_path)
    state = {
        "extracted_document_content": {
            "documents": [
                {
                    "source_path": path, "kind": "image", "text": "", "tables": [],
                    "dicom_metadata": None, "pixel_summary": {"format": "JPEG", "shape": (48, 64), "dtype": "uint8"},
                }
            ],
            "parse_errors": [],
        },
        "raw_input_paths": [path],
        "stage_status": new_stage_status(),
        "audit_log": [],
    }

    update = privacy_protection_agent(state)

    imaging = update["anonymized_patient_data"]["imaging"]
    assert imaging == [
        {"source_path": path, "metadata": {}, "pixel_summary": {"format": "JPEG", "shape": (48, 64), "dtype": "uint8"}}
    ]
    assert update["raw_input_paths"] == []
    summary = update["audit_log"][0]["summary"]
    assert "1 PNG/JPEG file(s)" in summary and "NOT redacted" in summary


def test_audit_summary_is_unchanged_when_there_are_no_plain_images(tmp_path):
    state = {
        "extracted_document_content": {
            "documents": [{"source_path": "a.pdf", "kind": "pdf", "text": "hello", "tables": [],
                           "dicom_metadata": None, "pixel_summary": None}],
            "parse_errors": [],
        },
        "raw_input_paths": ["a.pdf"], "stage_status": new_stage_status(), "audit_log": [],
    }
    assert "PNG/JPEG" not in privacy_protection_agent(state)["audit_log"][0]["summary"]


# --- the whole pipeline ------------------------------------------------------------------

@pytest.mark.parametrize("make", [_jpeg_with_phi, _png_with_phi])
def test_an_image_only_upload_reaches_a_full_report_with_the_image_attached(tmp_path, empty_collection, make):
    path = make(tmp_path)
    recorder = _Recorder()
    graph = build_pipeline_graph(llm_caller=recorder, rag_collection=empty_collection)

    final = graph.invoke(_initial_state([path]))

    assert final["final_explainable_report"] is not None
    assert len(recorder.calls) == 1 and recorder.calls[0][1] == [path]
    assert recorder.calls[0][0].startswith("Imaging: 1 imaging file(s) attached")
    statuses = {k: v["status"] for k, v in final["stage_status"].items()}
    assert statuses["document_parser"] == "ok" and statuses["privacy_protection"] == "ok"
    assert statuses["diagnostic_prediction"] in ("ok", "needs_review")


def test_no_metadata_value_appears_anywhere_in_the_final_state(tmp_path, empty_collection):
    paths = [_jpeg_with_phi(tmp_path), _png_with_phi(tmp_path)]
    graph = build_pipeline_graph(llm_caller=_Recorder(), rag_collection=empty_collection)

    final = graph.invoke(_initial_state(paths))

    blob = json.dumps(final, default=str)
    assert PHI not in blob and "AcmeScanner" not in blob


def test_a_corrupt_image_next_to_a_good_one_still_produces_a_report(tmp_path, empty_collection):
    bad = tmp_path / "bad.png"
    bad.write_bytes(b"garbage")
    recorder = _Recorder()
    graph = build_pipeline_graph(llm_caller=recorder, rag_collection=empty_collection)

    final = graph.invoke(_initial_state([str(bad), _png_with_phi(tmp_path)]))

    assert final["final_explainable_report"] is not None
    assert final["stage_status"]["document_parser"]["status"] == "needs_review"
    assert len(recorder.calls[0][1]) == 1


# --- telling the user where the image goes -----------------------------------------------

def test_backend_description_names_the_destination(monkeypatch):
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    monkeypatch.setenv("OPENROUTER_MODEL", "openrouter/free")
    assert "OpenRouter" in backend_description() and "third-party" in backend_description()

    monkeypatch.setenv("LLM_BASE_URL", "http://localhost:11434/v1")
    monkeypatch.setenv("OPENROUTER_MODEL", "medgemma1.5:4b")
    text = backend_description()
    assert "this machine" in text and "medgemma1.5:4b" in text and "not sent to a third party" in text

    monkeypatch.setenv("LLM_BASE_URL", "https://gpu.example.org/v1")
    text = backend_description()
    assert "gpu.example.org" in text and "this machine" not in text


@pytest.mark.parametrize("url", ["http://127.0.0.1:11434/v1", "http://[::1]:11434/v1", "http://LOCALHOST:1/v1"])
def test_loopback_urls_count_as_this_machine(monkeypatch, url):
    monkeypatch.setenv("LLM_BASE_URL", url)
    assert "this machine" in backend_description()


def test_a_lookalike_host_is_not_this_machine(monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "http://localhost.evil.example/v1")
    assert "this machine" not in backend_description()
