"""Diagnostic Prediction Agent.

Fifth in pipeline order. Calls a multimodal LLM with the patient's
structured labs/history and the literature retrieved by the RAG agent,
and returns a *ranked differential* -- never a single "the diagnosis" --
with a confidence score and an explicit abstention path.

Renamed in spirit, not just in name: `DifferentialCondition` and its
`supporting_evidence` are meant to read as "here is what the evidence
suggests," not "here is the diagnosis," per the clinical-safety critique.
The state field name (`diagnostic_prediction_result`) is unchanged from
Phase 0's schema to avoid unnecessary churn, but nothing in its content
asserts a diagnosis, and every prompt sent to the model says so explicitly.

Provider: OpenRouter's free router (`openrouter/free`), reached with the
`openai` SDK pointed at OpenRouter's endpoint -- not Gemini or OpenAI
called directly, both tried first:
  - Gemini (`google-genai`) worked in code right up until a real API key
    hit a persistent `API_KEY_SERVICE_BLOCKED` error from Google -- a
    Cloud-Console-issued key's own API-restriction allowlist rejecting
    Gemini access, reproducible via a bare API call outside this
    codebase, and not resolved by enabling the API project-wide or
    checking billing.
  - OpenAI was tried next, but its API has no meaningful free tier --
    billing is required even for the nominal trial credit.
  - A local model (e.g. via Ollama) was considered and rejected for a
    different reason: it only runs on the machine it's installed on, so
    a deployed version of this app couldn't reach it.
  - OpenRouter's free router auto-selects, per request, a free model
    that supports both image input and structured JSON output, and is
    itself a normal hosted API reachable from a deployed app -- no
    local compute, no per-provider billing setup. The structured-output
    schema below (`ModelDifferentialResponse`) is fully provider-
    agnostic and was carried over unchanged through all three attempts;
    only `_default_caller`'s client configuration changed.

Model name is read from the `OPENROUTER_MODEL` env var, defaulting to
`openrouter/free` rather than a specific model name -- free-model
availability on OpenRouter rotates, and the router itself is the stable
identifier. `response_format={"type": "json_object"}` (plain JSON mode)
is used instead of the OpenAI SDK's stricter `.parse()`/`response_schema`
helper, since the free router can land on any underlying model and not
all of them support strict schema-constrained decoding; the exact
required JSON shape is spelled out in `SYSTEM_INSTRUCTION` instead, and
the response is validated against `ModelDifferentialResponse` by hand. A
model that returns malformed JSON surfaces as a normal `failed` stage
status via the same try/except already around the caller -- not a
special case.

Two-stage abstention, not one:
  1. Pre-call: no clinical data AND no retrieved literature at all means
     abstaining without spending an API call -- there's nothing for the
     model to reason over.
  2. Post-call: if the model's own `overall_confidence` is below
     `CONFIDENCE_THRESHOLD`, the result is marked abstained even though a
     response came back. A low-confidence differential is exactly the
     "insufficient evidence" case the clinical-safety critique wants
     surfaced, not presented as a normal result.

What this agent does NOT do: explain itself. Whatever model the free
router selects is a closed API -- no gradients, no attention weights,
nothing to inspect. `reasoning_notes` and
`supporting_evidence` are the model's self-reported reasoning, explicitly
labeled as such. A self-report is not a faithful mechanistic explanation;
turning it into something a clinician can actually audit is Phase 6's job.

Imaging is best-effort. DICOM pixel data is converted to PNG for the
multimodal prompt when available (`_dicom_to_png_bytes`), reading from the
imaging entry's `source_path` -- the same path the Privacy agent already
documented as not pixel-defaced (a stated V2 limitation, not new scope
creep here). Conversion failures degrade to a text-only call rather than
raising: the two conditions this MVP targets (type 2 diabetes, coronary
artery disease) are primarily lab/history-driven, not imaging-diagnosed,
so a missing or unreadable image is a degraded case, not a broken one.
"""

from __future__ import annotations

import io
import os
from pathlib import Path
from typing import Any, Callable, TypedDict

from openai import APIConnectionError, APITimeoutError, InternalServerError, OpenAI, RateLimitError
from pydantic import BaseModel, Field
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from ..audit import audit_entry
from ..state import Citation, MedicalPipelineState, update_stage_status

STAGE_NAME = "diagnostic_prediction"

MODEL_ENV_VAR = "OPENROUTER_MODEL"
DEFAULT_MODEL_NAME = "openrouter/free"  # a router, deliberately not a specific model; see .env.example
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# Generous, not tight: the free router's observed latency in practice is
# around 70s (queueing/routing overhead on a $0 model), so a conventional
# 10-30s API timeout would fail this specific setup routinely, not
# exceptionally.
REQUEST_TIMEOUT_SECONDS = 90.0

# Retries only the transient cases (connection blips, timeouts, rate
# limits, 5xx). Deliberately NOT auth/permission errors -- this project's
# own Gemini attempt hit API_KEY_SERVICE_BLOCKED, and retrying a
# permission error just burns attempts on something retrying can't fix.
_RETRYABLE_ERRORS = (APIConnectionError, APITimeoutError, RateLimitError, InternalServerError)

# Below this, a returned differential is treated as "insufficient evidence"
# rather than a usable result, per the clinical-safety critique's abstention
# requirement. Arbitrary but explicit -- tune once real cases are available.
CONFIDENCE_THRESHOLD = 0.4

SYSTEM_INSTRUCTION = (
    "You are a clinical decision-support assistant generating an "
    "EDUCATIONAL, NON-DIAGNOSTIC differential for a synthetic test case. "
    "You are not a doctor, this is not a real patient, and nothing you "
    "produce should be read as an actual diagnosis. Given structured lab "
    "values, a normalized clinical history, and retrieved literature "
    "excerpts, produce a ranked differential of possible conditions. For "
    "each condition give a likelihood and short supporting_evidence "
    "bullets that reference specific lab values, history terms, or "
    "literature by their bracketed source_id. Report overall_confidence "
    "honestly: if the evidence is thin, contradictory, or ambiguous, say "
    "so with a low confidence score rather than overstating certainty.\n\n"
    "Respond with ONLY a single JSON object (no markdown fences, no other "
    "text) matching exactly this shape:\n"
    "{\n"
    '  "differential": [\n'
    '    {"condition": "<string>", "likelihood": <0-1 float>, '
    '"supporting_evidence": ["<string>", ...]}\n'
    "  ],\n"
    '  "overall_confidence": <0-1 float>,\n'
    '  "reasoning_notes": "<string>"\n'
    "}"
)


class DifferentialCondition(BaseModel):
    condition: str = Field(description="Canonical condition name, e.g. 'type 2 diabetes'")
    likelihood: float = Field(ge=0, le=1, description="Model's stated likelihood for this condition")
    supporting_evidence: list[str] = Field(
        description="Short bullets citing specific lab values, history terms, or literature source_ids"
    )


class ModelDifferentialResponse(BaseModel):
    """The shape asked of the model directly (response_schema). The agent
    wraps this into the richer DiagnosticPredictionResult below, adding
    the fields that are this agent's own responsibility, not the model's
    (abstained, abstention_reason, model_name)."""

    differential: list[DifferentialCondition]
    overall_confidence: float = Field(ge=0, le=1)
    reasoning_notes: str = Field(description="Free-text self-report of reasoning, not a mechanistic explanation")


class DiagnosticPredictionResult(TypedDict):
    differential: list[dict[str, Any]]
    overall_confidence: float
    reasoning_notes: str
    abstained: bool
    abstention_reason: str | None
    model_name: str


LLMCaller = Callable[[str, str | None], ModelDifferentialResponse]


def _dicom_to_png_bytes(source_path: str) -> bytes | None:
    """Best-effort conversion of a DICOM file's pixel data to PNG bytes.
    Returns None (never raises) on any failure -- see module docstring on
    why imaging is degrade-gracefully, not required, for this MVP."""
    try:
        import numpy as np
        import pydicom
        from PIL import Image

        dataset = pydicom.dcmread(source_path)
        array = dataset.pixel_array.astype("float32")
        array -= array.min()
        if array.max() > 0:
            array = array / array.max() * 255.0
        image = Image.fromarray(array.astype("uint8"))
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        return buffer.getvalue()
    except Exception:
        return None


def _load_image_for_prompt(source_path: str) -> tuple[bytes, str] | None:
    """Return (bytes, mime_type) for `source_path`, converting DICOM to
    PNG as needed. None if the file can't be turned into prompt-ready
    image data."""
    extension = Path(source_path).suffix.lower()
    if extension in (".dcm", ".dicom", ""):
        png_bytes = _dicom_to_png_bytes(source_path)
        return (png_bytes, "image/png") if png_bytes else None
    if extension in (".png", ".jpg", ".jpeg"):
        try:
            data = Path(source_path).read_bytes()
        except OSError:
            return None
        mime = "image/png" if extension == ".png" else "image/jpeg"
        return data, mime
    return None


def _build_prompt(structured_clinical_data: dict[str, Any], rag_literature_context: list[Citation]) -> str:
    labs = structured_clinical_data.get("labs", {})
    history = structured_clinical_data.get("history_text", "")

    lab_lines = "\n".join(f"- {name}: {lab['value']} {lab['unit']}" for name, lab in labs.items())
    citation_lines = "\n".join(
        f"- [{c['source_id']}] {c['title']}: {c['passage'][:300]}" for c in rag_literature_context
    )

    return (
        f"Patient history: {history or '(none provided)'}\n\n"
        f"Lab values:\n{lab_lines or '(none provided)'}\n\n"
        f"Retrieved literature:\n{citation_lines or '(none retrieved)'}"
    )


@retry(
    retry=retry_if_exception_type(_RETRYABLE_ERRORS),
    stop=stop_after_attempt(3),
    # Short backoff (~0.5s, ~1s) rather than a conventional multi-second
    # one -- this call already routinely takes ~70s on the free router,
    # so a long inter-retry wait adds cost without adding much value, and
    # a short one keeps the test suite (which exercises this exact retry
    # path against a fake client) fast.
    wait=wait_exponential(multiplier=0.5, min=0.5, max=4),
    reraise=True,
)
def _call_openrouter(client: OpenAI, model_name: str, messages: list[dict[str, Any]]) -> str:
    """The actual network call, isolated so retry only wraps the part
    that can be transiently wrong (connection blips, timeouts, rate
    limits, 5xx) -- not the JSON parsing/validation that follows it,
    which retrying can't fix. `reraise=True` means the caller sees the
    original exception type after retries are exhausted, not a wrapper.
    """
    completion = client.chat.completions.create(
        model=model_name,
        messages=messages,
        response_format={"type": "json_object"},
        temperature=0.2,
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    raw_content = completion.choices[0].message.content
    if not raw_content:
        raise ValueError("model returned an empty response")
    return raw_content


def _default_caller(prompt: str, image_path: str | None) -> ModelDifferentialResponse:
    """The real API call, via OpenRouter (using the `openai` SDK pointed
    at OpenRouter's base URL -- OpenRouter speaks the OpenAI API format).
    Not used directly by tests -- injected as `llm_caller` so tests
    supply a fake instead."""
    import base64

    client = OpenAI(api_key=os.environ.get("OPENROUTER_API_KEY"), base_url=OPENROUTER_BASE_URL)
    model_name = os.environ.get(MODEL_ENV_VAR, DEFAULT_MODEL_NAME)

    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    if image_path:
        loaded = _load_image_for_prompt(image_path)
        if loaded:
            data, mime_type = loaded
            encoded = base64.b64encode(data).decode("ascii")
            content.append(
                {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{encoded}"}}
            )

    # Plain JSON mode, not the SDK's stricter .parse()/response_schema --
    # the free router can land on any underlying model, and not all of
    # them support strict schema-constrained decoding. The exact required
    # shape is spelled out in SYSTEM_INSTRUCTION instead, and validated
    # by hand below.
    messages = [
        {"role": "system", "content": SYSTEM_INSTRUCTION},
        {"role": "user", "content": content},
    ]
    raw_content = _call_openrouter(client, model_name, messages)
    return ModelDifferentialResponse.model_validate_json(raw_content)


def diagnostic_prediction_agent(
    state: MedicalPipelineState, llm_caller: LLMCaller | None = None
) -> dict[str, Any]:
    """The LangGraph node. `llm_caller` is injectable for testing -- a
    fake returning a canned ModelDifferentialResponse instead of a real
    API call, the same pattern Phase 4's `collection` parameter uses.
    """
    structured = state.get("structured_clinical_data") or {}
    citations = state.get("rag_literature_context") or []
    imaging = (state.get("anonymized_patient_data") or {}).get("imaging") or []

    has_clinical_data = bool(structured.get("labs")) or bool(structured.get("history_text"))
    if not has_clinical_data and not citations:
        return {
            "stage_status": update_stage_status(
                state,
                STAGE_NAME,
                {"status": "needs_review", "message": "no clinical data or literature to reason over"},
            ),
            "audit_log": [audit_entry(STAGE_NAME, "abstained: no clinical data or literature available")],
        }

    prompt = _build_prompt(structured, citations)
    image_path = imaging[0]["source_path"] if imaging else None
    caller = llm_caller or _default_caller

    try:
        model_response = caller(prompt, image_path)
    except Exception as exc:  # the external API call -- network/auth/parsing failures, not a code bug
        return {
            "stage_status": update_stage_status(
                state, STAGE_NAME, {"status": "failed", "message": f"model call failed: {exc}"}
            ),
            "audit_log": [audit_entry(STAGE_NAME, f"failed: model call error: {exc}")],
        }

    abstained = model_response.overall_confidence < CONFIDENCE_THRESHOLD
    result: DiagnosticPredictionResult = {
        "differential": [c.model_dump() for c in model_response.differential],
        "overall_confidence": model_response.overall_confidence,
        "reasoning_notes": model_response.reasoning_notes,
        "abstained": abstained,
        "abstention_reason": "model confidence below threshold" if abstained else None,
        "model_name": os.environ.get(MODEL_ENV_VAR, DEFAULT_MODEL_NAME),
    }

    status = {
        "status": "needs_review" if abstained else "ok",
        "message": result["abstention_reason"],
    }
    summary = (
        f"{'abstained (low confidence)' if abstained else 'produced'} differential with "
        f"{len(result['differential'])} condition(s), confidence {result['overall_confidence']:.2f}"
    )

    return {
        "diagnostic_prediction_result": result,
        "stage_status": update_stage_status(state, STAGE_NAME, status),
        "audit_log": [audit_entry(STAGE_NAME, summary)],
    }
