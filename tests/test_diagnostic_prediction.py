"""Tests for the Diagnostic Prediction Agent.

The LLM call is injected as `llm_caller` for every test except the last:
a fake caller returning a canned ModelDifferentialResponse, so the whole
suite runs without an OpenRouter API key. The one exception
(test_live_openrouter_call_smoke_test) is skipped automatically unless
OPENROUTER_API_KEY is present in the environment -- it's the same
"real integration, not just mocks" check every other phase's RAG/parser
work got, just gated behind credentials this repo doesn't ship with.
"""

import os

import numpy as np
import pytest
from dotenv import load_dotenv
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

# Must run at collection time, before the skipif below evaluates its
# condition -- .env isn't loaded into os.environ automatically, and a
# skipif's condition is checked before any test body (including one that
# calls load_dotenv() itself) ever runs.
load_dotenv()

from openai import APIConnectionError, AuthenticationError

from glassbox_md.agents.diagnostic_prediction import (
    CONFIDENCE_THRESHOLD,
    DifferentialCondition,
    ModelDifferentialResponse,
    _build_prompt,
    _call_openrouter,
    _dicom_to_png_bytes,
    diagnostic_prediction_agent,
)
from glassbox_md.state import new_stage_status


def _base_state(**overrides):
    state = {
        "structured_clinical_data": {},
        "rag_literature_context": [],
        "anonymized_patient_data": {},
        "stage_status": new_stage_status(),
        "audit_log": [],
    }
    state.update(overrides)
    return state


# --- _call_openrouter retry behavior ----------------------------------------

def _fake_request():
    import httpx

    return httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions")


def _fake_http_response(status_code):
    import httpx

    return httpx.Response(status_code, request=_fake_request())


class _FakeCompletions:
    def __init__(self, responses):
        self._responses = list(responses)
        self.call_count = 0

    def create(self, **kwargs):
        self.call_count += 1
        result = self._responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


class _FakeClient:
    def __init__(self, responses):
        self.chat = type("_Chat", (), {"completions": _FakeCompletions(responses)})()


def _fake_completion(content):
    from types import SimpleNamespace

    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


def test_call_openrouter_retries_transient_errors_then_succeeds():
    responses = [
        APIConnectionError(request=_fake_request()),
        APIConnectionError(request=_fake_request()),
        _fake_completion('{"differential": []}'),
    ]
    client = _FakeClient(responses)

    result = _call_openrouter(client, "openrouter/free", [{"role": "user", "content": "hi"}])

    assert result == '{"differential": []}'
    assert client.chat.completions.call_count == 3


def test_call_openrouter_does_not_retry_auth_errors():
    client = _FakeClient([AuthenticationError("blocked", response=_fake_http_response(401), body=None)])

    with pytest.raises(AuthenticationError):
        _call_openrouter(client, "openrouter/free", [{"role": "user", "content": "hi"}])

    assert client.chat.completions.call_count == 1


def test_call_openrouter_gives_up_after_max_attempts():
    client = _FakeClient([APIConnectionError(request=_fake_request()) for _ in range(5)])

    with pytest.raises(APIConnectionError):
        _call_openrouter(client, "openrouter/free", [{"role": "user", "content": "hi"}])

    assert client.chat.completions.call_count == 3


def _fake_response(confidence=0.8, conditions=None):
    conditions = conditions or [
        DifferentialCondition(
            condition="type 2 diabetes",
            likelihood=0.75,
            supporting_evidence=["glucose 6.99 mmol/L", "[111] supports elevated glucose association"],
        )
    ]
    return ModelDifferentialResponse(
        differential=conditions, overall_confidence=confidence, reasoning_notes="elevated glucose plus history"
    )


class _CountingCaller:
    """Tracks whether it was invoked, so tests can assert the pre-call
    abstention path never reaches the model."""

    def __init__(self, response=None, exc=None):
        self.response = response
        self.exc = exc
        self.calls = 0

    def __call__(self, prompt, image_path):
        self.calls += 1
        if self.exc:
            raise self.exc
        return self.response


# --- _build_prompt ---------------------------------------------------------

def test_build_prompt_includes_labs_history_and_citations():
    prompt = _build_prompt(
        {"labs": {"glucose": {"value": 6.99, "unit": "mmol/L"}}, "history_text": "Patient has type 2 diabetes."},
        [{"source_id": "111", "title": "Diabetes study", "url": "u", "passage": "glucose control matters"}],
    )
    assert "glucose: 6.99 mmol/L" in prompt
    assert "type 2 diabetes" in prompt
    assert "[111]" in prompt


def test_build_prompt_handles_empty_input():
    prompt = _build_prompt({}, [])
    assert "(none provided)" in prompt
    assert "(none retrieved)" in prompt


# --- _dicom_to_png_bytes ----------------------------------------------------

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
    ds.Modality = "MR"
    ds.Rows, ds.Columns = 8, 8
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    ds.PixelData = (np.arange(64, dtype=np.uint16).reshape(8, 8) * 100).tobytes()
    ds.save_as(str(path), enforce_file_format=True)
    return str(path)


def test_dicom_to_png_bytes_produces_valid_png(sample_dicom):
    png_bytes = _dicom_to_png_bytes(sample_dicom)
    assert png_bytes is not None
    assert png_bytes[:8] == b"\x89PNG\r\n\x1a\n"  # PNG magic number


def test_dicom_to_png_bytes_returns_none_on_corrupt_file(tmp_path):
    bad_path = tmp_path / "corrupt.dcm"
    bad_path.write_bytes(b"not a real dicom file")
    assert _dicom_to_png_bytes(str(bad_path)) is None


# --- diagnostic_prediction_agent (the LangGraph node) -----------------------

def test_agent_abstains_before_calling_model_when_no_input():
    caller = _CountingCaller(response=_fake_response())
    result = diagnostic_prediction_agent(_base_state(), llm_caller=caller)

    assert caller.calls == 0
    assert result["stage_status"]["diagnostic_prediction"]["status"] == "needs_review"


def test_agent_calls_model_for_imaging_only_case_with_no_labs_or_history(sample_dicom):
    """The bug this regression-tests: an MRI/X-ray with no accompanying
    lab report or history text is real clinical input, not empty input --
    it must reach the model (with the image attached), not abstain
    pre-call just because structured_clinical_data happens to be empty."""
    state = _base_state(
        anonymized_patient_data={"imaging": [{"source_path": sample_dicom, "metadata": {}, "pixel_summary": {}}]}
    )
    caller = _CountingCaller(response=_fake_response())

    result = diagnostic_prediction_agent(state, llm_caller=caller)

    assert caller.calls == 1
    assert result["stage_status"]["diagnostic_prediction"]["status"] == "ok"


def test_agent_happy_path_produces_differential():
    state = _base_state(
        structured_clinical_data={
            "labs": {"glucose": {"value": 6.99, "unit": "mmol/L"}},
            "history_text": "Patient has type 2 diabetes.",
        },
        rag_literature_context=[{"source_id": "111", "title": "t", "url": "u", "passage": "p"}],
    )
    caller = _CountingCaller(response=_fake_response(confidence=0.8))

    result = diagnostic_prediction_agent(state, llm_caller=caller)

    assert caller.calls == 1
    assert result["stage_status"]["diagnostic_prediction"]["status"] == "ok"
    prediction = result["diagnostic_prediction_result"]
    assert prediction["abstained"] is False
    assert prediction["differential"][0]["condition"] == "type 2 diabetes"
    assert prediction["overall_confidence"] == 0.8


def test_agent_abstains_after_call_on_low_confidence():
    state = _base_state(
        structured_clinical_data={"history_text": "Ambiguous presentation."},
        rag_literature_context=[{"source_id": "1", "title": "t", "url": "u", "passage": "p"}],
    )
    assert CONFIDENCE_THRESHOLD > 0.1  # sanity: the fixture below must sit under the real threshold
    caller = _CountingCaller(response=_fake_response(confidence=0.1))

    result = diagnostic_prediction_agent(state, llm_caller=caller)

    prediction = result["diagnostic_prediction_result"]
    assert prediction["abstained"] is True
    assert result["stage_status"]["diagnostic_prediction"]["status"] == "needs_review"


def test_agent_records_failure_when_model_call_raises():
    state = _base_state(
        structured_clinical_data={"history_text": "Patient has type 2 diabetes."},
        rag_literature_context=[{"source_id": "1", "title": "t", "url": "u", "passage": "p"}],
    )
    caller = _CountingCaller(exc=RuntimeError("api unreachable"))

    result = diagnostic_prediction_agent(state, llm_caller=caller)

    assert result["stage_status"]["diagnostic_prediction"]["status"] == "failed"


def test_agent_preserves_other_stages_status():
    state = _base_state(
        structured_clinical_data={"history_text": "Patient has type 2 diabetes."},
        rag_literature_context=[{"source_id": "1", "title": "t", "url": "u", "passage": "p"}],
    )
    state["stage_status"]["medical_knowledge_rag"] = {"status": "ok", "message": None}
    caller = _CountingCaller(response=_fake_response())

    result = diagnostic_prediction_agent(state, llm_caller=caller)

    assert result["stage_status"]["medical_knowledge_rag"] == {"status": "ok", "message": None}


# --- live integration (gated) ------------------------------------------------

@pytest.mark.skipif(not os.environ.get("OPENROUTER_API_KEY"), reason="OPENROUTER_API_KEY not set in environment")
def test_live_openrouter_call_smoke_test():
    """Proof the real API integration works, not just the mocked unit
    tests -- runs only when a real key is configured (see .env)."""
    state = _base_state(
        structured_clinical_data={
            "labs": {"glucose": {"value": 11.1, "unit": "mmol/L"}},
            "history_text": "Patient reports polyuria and polydipsia; has type 2 diabetes.",
        },
        rag_literature_context=[
            {
                "source_id": "test-1",
                "title": "Glycemic control in type 2 diabetes",
                "url": "https://pubmed.ncbi.nlm.nih.gov/test-1/",
                "passage": "Elevated fasting glucose is a key diagnostic marker for type 2 diabetes.",
            }
        ],
    )

    result = diagnostic_prediction_agent(state)  # no llm_caller override -- hits the real API

    assert result["stage_status"]["diagnostic_prediction"]["status"] in ("ok", "needs_review")
    prediction = result["diagnostic_prediction_result"]
    assert isinstance(prediction["differential"], list)
    assert 0.0 <= prediction["overall_confidence"] <= 1.0
    assert prediction["model_name"]
