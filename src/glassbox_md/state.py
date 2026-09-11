"""LangGraph state schema for the Glassbox MD pipeline.

The original pitch used a single flat TypedDict passed sequentially through
six nodes, with no per-stage status, no confidence, and a final report
collapsed into one opaque string. The architecture critique in the project
brief flagged that this makes failures crash the whole chain (a bad DICOM
file surfaces only as a downstream KeyError) and leaves the pipeline with
nothing to show for its own reasoning -- ironic for a project whose entire
thesis is "clinicians need to know why."

This revised schema fixes both: every stage records its own status so
LangGraph's conditional edges can route around a failure instead of dying,
and every stage appends to an audit log so the reasoning trail is part of
the state itself, not something the UI has to reconstruct after the fact.
"""

from __future__ import annotations

import operator
from typing import Annotated, Any, Literal, TypedDict

# Agents 1-6, in pipeline order. Used as keys into stage_status and as the
# `stage` value in audit log entries, so every part of the codebase names
# stages the same way.
STAGE_NAMES = (
    "document_parser",
    "privacy_protection",
    "data_preparation",
    "medical_knowledge_rag",
    "diagnostic_prediction",
    "explainability",
)

StageStatus = Literal["pending", "ok", "failed", "needs_review"]


class StageResult(TypedDict):
    """Outcome of a single agent's run, keyed by stage name in stage_status.

    `needs_review` is distinct from `failed`: it means the agent produced a
    result but one that fell below a confidence threshold or hit an
    abstention condition -- the clinical-safety review's "insufficient
    evidence" path, not a crash.
    """

    status: StageStatus
    message: str | None


class AuditEntry(TypedDict):
    """One append-only entry in the pipeline's audit log.

    `timestamp` is filled in by the agent at run time (not by this module --
    state schemas shouldn't reach for wall-clock time themselves), typically
    as an ISO-8601 string so log entries sort and serialize predictably.
    """

    stage: str
    summary: str
    timestamp: str


class Citation(TypedDict):
    """A single grounded source, as returned by the Medical Knowledge RAG
    agent and threaded through to the final explainable report -- so the
    explanation can point at the literature it actually used, not just the
    prediction agent that consumed it upstream.
    """

    source_id: str  # e.g. a PubMed ID
    title: str
    url: str
    passage: str


class ExplainableReport(TypedDict):
    """The final output. A structured object instead of a single string, so
    a UI can render distinct, drill-downable sections (per the technical
    critique) rather than parsing prose to find the parts that matter.
    """

    narrative: str
    citations: list[Citation]
    confidence: float
    shap_reference: str | None
    disagreement_flagged: bool
    clinician_confirmed: bool


class MedicalPipelineState(TypedDict):
    """The object threaded through all six LangGraph nodes.

    Each agent should return a partial-dict update (as in the original code
    sample's `return {"extracted_document_content": ...}` pattern), not the
    whole state -- LangGraph merges partial updates into the running state,
    and `audit_log`'s `operator.add` annotation means returning a new log
    entry *appends* to the existing list instead of overwriting it.
    """

    # --- Initial input ---
    raw_input_paths: list[str]

    # --- Intermediate state, populated by agents in pipeline order ---
    extracted_document_content: dict[str, Any]
    anonymized_patient_data: dict[str, Any]
    structured_clinical_data: dict[str, Any]
    rag_literature_context: list[Citation]
    diagnostic_prediction_result: dict[str, Any]

    # --- Final output ---
    final_explainable_report: ExplainableReport | None

    # --- Cross-cutting additions from the architecture critique ---
    stage_status: dict[str, StageResult]
    audit_log: Annotated[list[AuditEntry], operator.add]


class PrivacyBoundaryViolation(RuntimeError):
    """Raised when raw, pre-anonymization identifiers are still present in
    state after the point where they should have been cleared.
    """


def assert_privacy_boundary_respected(state: MedicalPipelineState) -> None:
    """Runtime guard for the privacy leak the critique flagged in the
    original design: `raw_input_paths` (which can embed PHI, e.g. a
    patient's name in a filename) sat in the same shared state as
    `anonymized_patient_data` with nothing stopping a downstream node --
    including the one that calls an external LLM API -- from reading it.

    A TypedDict is a static type hint only; it enforces nothing at run
    time. This function is the actual enforcement. The Privacy Protection
    Agent's node must clear `raw_input_paths` (e.g. return
    `{"raw_input_paths": []}` alongside its real output) once it has
    produced `anonymized_patient_data`. Call this at the boundary of any
    node that is not the parser or privacy agent -- most importantly
    immediately before the Medical Knowledge RAG and Diagnostic Prediction
    agents, since those are the two nodes that reach out to external
    services.
    """
    if state.get("anonymized_patient_data") and state.get("raw_input_paths"):
        raise PrivacyBoundaryViolation(
            "raw_input_paths must be cleared once anonymized_patient_data "
            "exists -- a downstream node (or an external API call) could "
            "otherwise still read pre-anonymization identifiers."
        )


def new_stage_status() -> dict[str, StageResult]:
    """A fresh `stage_status` dict with every stage marked pending, for
    initializing pipeline runs."""
    return {name: {"status": "pending", "message": None} for name in STAGE_NAMES}


def update_stage_status(
    state: MedicalPipelineState, stage: str, result: StageResult
) -> dict[str, StageResult]:
    """Return a full `stage_status` dict with `stage` set to `result`,
    merged with whatever the other stages already recorded.

    `stage_status` has no LangGraph reducer -- unlike `audit_log`, which
    accumulates automatically via its `operator.add` annotation, a plain
    dict field is simply overwritten by the latest node's return value. A
    node that returned `{"stage_status": {stage: result}}` directly would
    silently erase every other stage's recorded status, not merge into it.
    Every agent should build its `stage_status` update through this helper
    instead of constructing the dict by hand.
    """
    merged = dict(state.get("stage_status") or new_stage_status())
    merged[stage] = result
    return merged
