"""Tests for the compiled six-agent pipeline: conditional routing, and
the capstone end-to-end check that a real synthetic case flows through
all six real agents with the audit log accumulating correctly.

The RAG collection and LLM caller are injected exactly as Phase 4 and
Phase 5's own tests inject them, so this runs fully offline -- no API
key, no pre-built literature index.
"""

from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

from glassbox_md.agents.diagnostic_prediction import DifferentialCondition, ModelDifferentialResponse
from glassbox_md.agents.medical_knowledge_rag import build_literature_collection
from glassbox_md.pipeline import PARSER_STAGE, STAGE_ORDER, _route_on_failure, build_pipeline_graph
from glassbox_md.state import new_stage_status


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


def _fake_llm_caller(prompt, image_path):
    return ModelDifferentialResponse(
        differential=[
            DifferentialCondition(
                condition="type 2 diabetes",
                likelihood=0.8,
                supporting_evidence=["history mentions type 2 diabetes"],
            )
        ],
        overall_confidence=0.8,
        reasoning_notes="test reasoning",
    )


# --- _route_on_failure --------------------------------------------------

def test_router_continues_on_ok_status():
    state = {"stage_status": {"document_parser": {"status": "ok", "message": None}}}
    router = _route_on_failure("document_parser", "privacy_protection")
    assert router(state) == "privacy_protection"


def test_router_continues_on_needs_review_status():
    state = {"stage_status": {"document_parser": {"status": "needs_review", "message": "partial"}}}
    router = _route_on_failure("document_parser", "privacy_protection")
    assert router(state) == "privacy_protection"


def test_router_routes_to_end_on_failed_status():
    from langgraph.graph import END

    state = {"stage_status": {"document_parser": {"status": "failed", "message": "no input"}}}
    router = _route_on_failure("document_parser", "privacy_protection")
    assert router(state) == END


# --- full pipeline: early termination ------------------------------------

def test_pipeline_stops_early_when_parser_fails():
    graph = build_pipeline_graph(llm_caller=_fake_llm_caller, rag_collection=None)

    result = graph.invoke(_initial_state(paths=[]))  # no input files -> parser fails immediately

    assert result["stage_status"][PARSER_STAGE]["status"] == "failed"
    assert len(result["audit_log"]) == 1
    assert result["audit_log"][0]["stage"] == PARSER_STAGE
    # nothing downstream ran
    assert result["final_explainable_report"] is None


# --- full pipeline: end-to-end happy path --------------------------------

def test_pipeline_runs_all_six_stages_with_audit_log_accumulating(tmp_path):
    # A real synthetic PDF, parsed by the real Document Parser Agent.
    pdf_path = tmp_path / "patient.pdf"
    c = canvas.Canvas(str(pdf_path), pagesize=letter)
    c.drawString(72, 750, "History: Patient has type 2 diabetes, reports fatigue.")
    c.save()

    # A small, real ChromaDB collection so the RAG agent has something
    # to retrieve, without needing a live PubMed fetch or a pre-built index.
    rag_collection = build_literature_collection(
        [
            {
                "pmid": "111",
                "title": "Type 2 diabetes management",
                "abstract": "Glucose control strategies for type 2 diabetes patients.",
                "url": "https://pubmed.ncbi.nlm.nih.gov/111/",
            }
        ],
        persist_directory=str(tmp_path / "chroma"),
    )

    graph = build_pipeline_graph(llm_caller=_fake_llm_caller, rag_collection=rag_collection)
    result = graph.invoke(_initial_state(paths=[str(pdf_path)]))

    # Every stage actually ran and recorded a real (non-pending) status.
    for stage in STAGE_ORDER:
        assert result["stage_status"][stage]["status"] in ("ok", "needs_review"), stage

    # The audit log accumulated one entry per stage, in pipeline order --
    # the actual thing this phase's task list asked to confirm.
    assert [entry["stage"] for entry in result["audit_log"]] == list(STAGE_ORDER)

    # The Phase 0 privacy leak fix held all the way through a real run.
    assert result["raw_input_paths"] == []

    # And the pipeline actually produced its final artifact.
    report = result["final_explainable_report"]
    assert report is not None
    assert "type 2 diabetes" in report["narrative"].lower()
