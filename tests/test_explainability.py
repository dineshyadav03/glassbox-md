"""Tests for the Explainability Agent: citation resolution, narrative
assembly, the disagreement signal, the SHAP demo, and the final node.
"""

from glassbox_md.agents.explainability import (
    DISAGREEMENT_MARGIN,
    _build_narrative,
    _build_shap_demo,
    _differential_disagreement,
    _resolve_cited_sources,
    explainability_agent,
)
from glassbox_md.state import new_stage_status

_CITATIONS = [
    {"source_id": "111", "title": "Diabetes study", "url": "https://pubmed.ncbi.nlm.nih.gov/111/", "passage": "p1"},
    {"source_id": "222", "title": "CAD study", "url": "https://pubmed.ncbi.nlm.nih.gov/222/", "passage": "p2"},
]


def _base_state(**overrides):
    state = {
        "diagnostic_prediction_result": None,
        "rag_literature_context": [],
        "stage_status": new_stage_status(),
        "audit_log": [],
    }
    state.update(overrides)
    return state


def _prediction(differential=None, confidence=0.8, abstained=False, notes="reasoning here"):
    return {
        "differential": differential
        or [{"condition": "type 2 diabetes", "likelihood": 0.75, "supporting_evidence": ["glucose elevated [111]"]}],
        "overall_confidence": confidence,
        "reasoning_notes": notes,
        "abstained": abstained,
        "abstention_reason": "model confidence below threshold" if abstained else None,
        "model_name": "test-model",
    }


# --- _resolve_cited_sources --------------------------------------------------

def test_resolves_referenced_citations_in_order():
    differential = [
        {"condition": "a", "likelihood": 0.6, "supporting_evidence": ["evidence one [222]"]},
        {"condition": "b", "likelihood": 0.4, "supporting_evidence": ["evidence two [111]"]},
    ]
    resolved = _resolve_cited_sources(differential, _CITATIONS)
    assert [c["source_id"] for c in resolved] == ["222", "111"]


def test_ignores_unresolvable_and_duplicate_references():
    differential = [
        {"condition": "a", "likelihood": 0.6, "supporting_evidence": ["[111]", "[111]", "[999]"]},
    ]
    resolved = _resolve_cited_sources(differential, _CITATIONS)
    assert [c["source_id"] for c in resolved] == ["111"]


def test_no_citations_when_nothing_referenced():
    differential = [{"condition": "a", "likelihood": 0.6, "supporting_evidence": ["no brackets here"]}]
    assert _resolve_cited_sources(differential, _CITATIONS) == []


# --- _build_narrative --------------------------------------------------------

def test_narrative_for_abstained_prediction_says_insufficient_evidence():
    narrative = _build_narrative(_prediction(abstained=True, confidence=0.1), [])
    assert "insufficient evidence" in narrative.lower()


def test_narrative_includes_differential_and_citations():
    narrative = _build_narrative(_prediction(), _CITATIONS[:1])
    assert "type 2 diabetes" in narrative
    assert "Diabetes study" in narrative
    assert "reasoning here" in narrative


# --- _differential_disagreement ----------------------------------------------

def test_disagreement_true_when_top_two_are_close():
    differential = [
        {"condition": "a", "likelihood": 0.55, "supporting_evidence": []},
        {"condition": "b", "likelihood": 0.55 - DISAGREEMENT_MARGIN + 0.01, "supporting_evidence": []},
    ]
    assert _differential_disagreement(differential) is True


def test_disagreement_false_when_top_two_are_far_apart():
    differential = [
        {"condition": "a", "likelihood": 0.9, "supporting_evidence": []},
        {"condition": "b", "likelihood": 0.1, "supporting_evidence": []},
    ]
    assert _differential_disagreement(differential) is False


def test_disagreement_false_with_a_single_condition():
    assert _differential_disagreement([{"condition": "a", "likelihood": 0.9, "supporting_evidence": []}]) is False


# --- _build_shap_demo ---------------------------------------------------------

def test_shap_demo_returns_three_top_features_with_float_values():
    demo = _build_shap_demo()
    assert len(demo["top_features"]) == 3
    for entry in demo["top_features"]:
        assert isinstance(entry["shap_value"], float)
        assert entry["feature"]


def test_shap_demo_is_cached_across_calls():
    first = _build_shap_demo()
    second = _build_shap_demo()
    assert first is second


# --- explainability_agent (the LangGraph node) --------------------------------

def test_agent_fails_when_no_prediction_to_explain():
    result = explainability_agent(_base_state())
    assert result["stage_status"]["explainability"]["status"] == "failed"


def test_agent_happy_path_produces_full_report():
    state = _base_state(
        diagnostic_prediction_result=_prediction(),
        rag_literature_context=_CITATIONS,
    )
    result = explainability_agent(state)

    report = result["final_explainable_report"]
    assert report["citations"][0]["source_id"] == "111"
    assert report["confidence"] == 0.8
    assert report["clinician_confirmed"] is False
    assert report["shap_reference"] is not None
    assert result["stage_status"]["explainability"]["status"] == "ok"


def test_agent_flags_disagreement_on_close_likelihoods():
    differential = [
        {"condition": "a", "likelihood": 0.5, "supporting_evidence": []},
        {"condition": "b", "likelihood": 0.45, "supporting_evidence": []},
    ]
    state = _base_state(diagnostic_prediction_result=_prediction(differential=differential))

    result = explainability_agent(state)

    assert result["final_explainable_report"]["disagreement_flagged"] is True
    assert result["stage_status"]["explainability"]["status"] == "needs_review"


def test_agent_flags_disagreement_when_upstream_abstained():
    state = _base_state(diagnostic_prediction_result=_prediction(abstained=True, confidence=0.1))
    result = explainability_agent(state)
    assert result["final_explainable_report"]["disagreement_flagged"] is True


def test_agent_preserves_other_stages_status():
    state = _base_state(diagnostic_prediction_result=_prediction())
    state["stage_status"]["diagnostic_prediction"] = {"status": "ok", "message": None}

    result = explainability_agent(state)

    assert result["stage_status"]["diagnostic_prediction"] == {"status": "ok", "message": None}
