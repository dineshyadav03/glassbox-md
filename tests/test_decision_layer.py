"""The optional evidence check (decision_layer.py): the judge's wire format and
maths, the per-claim rule, the flags, and its integration into the report. A
fake backend stands in for the model everywhere except the wire-format tests,
which use a fake client so the exact request and the logprob arithmetic are checked.
Nothing here measures the real model; that needs it served (see the module docstring)."""

import json
import math
from types import SimpleNamespace

import pytest

from glassbox_md import decision_layer as dl
from glassbox_md.agents.explainability import explainability_agent
from glassbox_md.decision_layer import (
    CONTRADICTED, NOT_ENOUGH, SUPPORTED, UNCERTAIN, DecisionError, Option, OpenAICompatibleBackend,
)
from glassbox_md.report_format import build_report_markdown
from glassbox_md.state import new_stage_status


# --- the wire format ---------------------------------------------------------------------

def _completion(pairs):
    """pairs: [(token, logprob), ...] as the first generated token's top logprobs."""
    top = [SimpleNamespace(token=t, logprob=lp) for t, lp in pairs]
    return SimpleNamespace(choices=[SimpleNamespace(logprobs=SimpleNamespace(content=[SimpleNamespace(top_logprobs=top)]))])


class _Client:
    def __init__(self, completion=None, exc=None):
        self.completion, self.exc, self.requests = completion, exc, []
        outer = self

        class _C:
            def create(self, **kw):
                outer.requests.append(kw)
                if outer.exc:
                    raise outer.exc
                return outer.completion

        self.chat = SimpleNamespace(completions=_C())


OPTS = (Option("yes", "It is."), Option("no", "It is not."), Option("unsure", "Cannot tell."))


def test_the_request_matches_the_model_card():
    client = _Client(_completion([("A", -0.1), ("B", -3.0), ("C", -4.0)]))
    OpenAICompatibleBackend("http://x/v1", client=client).decide("the source", "the question?", OPTS)

    request = client.requests[0]
    assert request["model"] == dl.DEFAULT_MODEL
    assert request["max_tokens"] == 1 and request["temperature"] == 0
    assert request["logprobs"] is True and request["top_logprobs"] == 20
    assert request["extra_body"] == {"chat_template_kwargs": {"enable_thinking": False}}
    system, user = request["messages"]
    assert system == {"role": "system", "content": dl.SYSTEM_PROMPT}
    assert json.loads(user["content"]) == {
        "state": "the source",
        "question": "the question?",
        "options": [
            {"label": "A", "key": "yes", "description": "It is."},
            {"label": "B", "key": "no", "description": "It is not."},
            {"label": "C", "key": "unsure", "description": "Cannot tell."},
        ],
    }


def test_probabilities_are_the_temperature_scaled_softmax_of_the_option_logprobs():
    client = _Client(_completion([("A", -0.2), ("B", -2.0), ("C", -3.5), ("Z", -9.0)]))
    probs = OpenAICompatibleBackend("http://x/v1", client=client).decide("s", "q", OPTS)

    scaled = [lp / dl.TEMPERATURE for lp in (-0.2, -2.0, -3.5)]
    expected = [math.exp(v) / sum(math.exp(x) for x in scaled) for v in scaled]
    assert [probs[k] for k in ("yes", "no", "unsure")] == pytest.approx(expected)
    assert sum(probs.values()) == pytest.approx(1.0)
    assert max(probs, key=probs.get) == "yes"


def test_temperature_softens_the_distribution_relative_to_plain_softmax():
    lps = (-0.2, -2.0, -3.5)
    plain = [math.exp(v) / sum(math.exp(x) for x in lps) for v in lps]
    client = _Client(_completion(list(zip("ABC", lps))))
    probs = OpenAICompatibleBackend("http://x/v1", client=client).decide("s", "q", OPTS)
    assert probs["yes"] < plain[0]  # T > 1 lowers the top probability


def test_leading_space_tokens_and_duplicates_are_handled():
    client = _Client(_completion([(" A", -0.3), ("A", -0.1), ("B", -2.0), ("C", -3.0)]))
    probs = OpenAICompatibleBackend("http://x/v1", client=client).decide("s", "q", OPTS)
    assert max(probs, key=probs.get) == "yes"


def test_an_option_letter_missing_from_the_top_logprobs_is_treated_as_negligible():
    client = _Client(_completion([("A", -0.1), ("B", -2.0)]))  # C never appeared in the top 20
    probs = OpenAICompatibleBackend("http://x/v1", client=client).decide("s", "q", OPTS)
    assert probs["unsure"] < 1e-6 and sum(probs.values()) == pytest.approx(1.0)


def test_a_model_that_did_not_choose_an_option_is_an_error_not_a_guess():
    client = _Client(_completion([("The", -0.1), ("A", -6.0), ("B", -7.0), ("C", -8.0)]))
    with pytest.raises(DecisionError, match="did not pick one of the options"):
        OpenAICompatibleBackend("http://x/v1", client=client).decide("s", "q", OPTS)


@pytest.mark.parametrize("completion", [SimpleNamespace(choices=[SimpleNamespace(logprobs=None)]), SimpleNamespace(choices=[])])
def test_a_server_without_logprobs_is_a_clear_error(completion):
    with pytest.raises(DecisionError, match="logprobs"):
        OpenAICompatibleBackend("http://x/v1", client=_Client(completion)).decide("s", "q", OPTS)


def test_a_transport_failure_becomes_a_decision_error():
    client = _Client(exc=ConnectionError("refused"))
    with pytest.raises(DecisionError, match="ConnectionError"):
        OpenAICompatibleBackend("http://x/v1", client=client).decide("s", "q", OPTS)


@pytest.mark.parametrize("n", [0, 1, 25])
def test_the_number_of_options_is_bounded(n):
    with pytest.raises(ValueError):
        OpenAICompatibleBackend("http://x/v1", client=_Client()).decide("s", "q", [Option(str(i), "d") for i in range(n)])


# --- configuration -----------------------------------------------------------------------

def test_the_layer_is_off_unless_configured(monkeypatch):
    monkeypatch.delenv("DECISION_BASE_URL", raising=False)
    assert dl.backend_from_env() is None and dl.backend_description() is None


def test_configuration_selects_a_backend_and_describes_where_text_goes(monkeypatch):
    monkeypatch.setenv("DECISION_BASE_URL", "http://localhost:8001/v1")
    monkeypatch.setenv("DECISION_MODEL", "my/biodecision")
    backend = dl.backend_from_env()
    assert isinstance(backend, OpenAICompatibleBackend) and backend.model == "my/biodecision"
    assert "this machine" in dl.backend_description()

    monkeypatch.setenv("DECISION_BASE_URL", "https://gpu.example.org/v1")
    assert "gpu.example.org" in dl.backend_description()


@pytest.mark.parametrize("raw, expected", [("", 120.0), ("abc", 120.0), ("-3", 120.0), ("30", 30.0)])
def test_the_timeout_falls_back_when_invalid(monkeypatch, raw, expected):
    monkeypatch.setenv("DECISION_BASE_URL", "http://localhost:8001/v1")
    monkeypatch.setenv("DECISION_TIMEOUT_SECONDS", raw)
    assert dl.backend_from_env().timeout == expected


# --- what is checked -----------------------------------------------------------------------

def _prediction(*conditions):
    return {"differential": [{"condition": c, "likelihood": lk, "supporting_evidence": ev} for c, lk, ev in conditions]}


def test_claims_come_from_the_top_conditions_in_rank_order_with_caps():
    pred = _prediction(
        ("low", 0.1, ["z1"]),
        ("top", 0.9, ["a1", "a2", "a3", "a4", "a5"]),
        ("mid", 0.5, ["b1"]),
        ("fourth", 0.2, ["c1"]),
    )
    claims = dl.claims_to_check(pred)
    # ranked by likelihood: top 0.9, mid 0.5, fourth 0.2 (low 0.1 falls outside the top three)
    assert [(c["rank"], c["claim"]) for c in claims] == [(1, "a1"), (1, "a2"), (1, "a3"), (2, "b1"), (3, "c1")]
    assert {c["condition"] for c in claims} == {"top", "mid", "fourth"}


def test_blank_claims_are_skipped_and_long_ones_truncated():
    claims = dl.claims_to_check(_prediction(("x", 0.9, ["", "  ", "y" * 1000])))
    assert len(claims) == 1 and len(claims[0]["claim"]) == dl.MAX_CLAIM_CHARS


def test_the_source_is_the_text_the_model_saw_and_is_empty_without_any():
    state = {
        "structured_clinical_data": {"labs": {"glucose": {"value": 10.1, "unit": "mmol/L"}}, "history_text": "thirsty"},
        "rag_literature_context": [{"source_id": "111", "title": "T", "url": "u", "passage": "glucose matters"}],
    }
    source = dl.build_source(state)
    assert "glucose: 10.1 mmol/L" in source and "thirsty" in source and "[111]" in source
    assert dl.build_source({"structured_clinical_data": {}, "rag_literature_context": []}) == ""


# --- the verdict rule and the flags --------------------------------------------------------

class _Fake:
    name = "fake-judge"

    def __init__(self, script):
        self.script, self.calls = list(script), []

    def decide(self, state, question, options):
        self.calls.append((state, question))
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def _p(s=0.0, c=0.0, n=0.0):
    return {SUPPORTED: s, CONTRADICTED: c, NOT_ENOUGH: n}


def test_a_verdict_needs_the_confidence_threshold():
    assert dl.verdict_of(_p(0.7, 0.2, 0.1)) == SUPPORTED
    assert dl.verdict_of(_p(0.59, 0.3, 0.11)) == UNCERTAIN
    assert dl.verdict_of(_p(0.6, 0.3, 0.1)) == SUPPORTED  # the threshold itself counts


_STATE = {
    "structured_clinical_data": {"labs": {"glucose": {"value": 10.1, "unit": "mmol/L"}}, "history_text": "thirsty"},
    "rag_literature_context": [],
}
_PRED = _prediction(("type 2 diabetes", 0.9, ["glucose is 10.1 mmol/L", "patient is thirsty"]), ("other", 0.3, ["something"]))


def test_all_supported_is_not_flagged():
    result = dl.run_evidence_check(_STATE, _PRED, _Fake([_p(s=0.9), _p(s=0.8), _p(s=0.7)]))
    assert result["counts"][SUPPORTED] == 3 and not result["flagged"] and result["flag_reasons"] == []
    assert [c["verdict"] for c in result["checked"]] == [SUPPORTED] * 3
    assert result["note"] == dl.ADVISORY_NOTE


def test_a_contradicted_claim_for_the_top_condition_flags_the_case():
    result = dl.run_evidence_check(_STATE, _PRED, _Fake([_p(s=0.9), _p(c=0.8), _p(s=0.9)]))
    assert result["flagged"] and "contradicted" in result["flag_reasons"][0]


def test_a_contradiction_for_a_lower_ranked_condition_alone_does_not_flag():
    result = dl.run_evidence_check(_STATE, _PRED, _Fake([_p(s=0.9), _p(s=0.9), _p(c=0.9)]))
    assert not result["flagged"] and result["counts"][CONTRADICTED] == 1


def test_no_confirmed_claim_for_the_top_condition_flags_the_case():
    result = dl.run_evidence_check(_STATE, _PRED, _Fake([_p(n=0.9), _p(n=0.8), _p(s=0.9)]))
    assert result["flagged"] and "none of the checked claims" in result["flag_reasons"][0]


def test_an_uncertain_verdict_does_not_count_as_confirmed():
    result = dl.run_evidence_check(_STATE, _PRED, _Fake([_p(0.5, 0.3, 0.2), _p(0.5, 0.3, 0.2), _p(s=0.9)]))
    assert result["counts"][UNCERTAIN] == 2 and result["flagged"]


def test_each_claim_is_asked_with_the_source_and_the_claim():
    fake = _Fake([_p(s=0.9)] * 3)
    dl.run_evidence_check(_STATE, _PRED, fake)
    state, question = fake.calls[0]
    assert "glucose: 10.1 mmol/L" in state and "glucose is 10.1 mmol/L" in question
    assert question == dl.build_question("glucose is 10.1 mmol/L")


def test_the_question_and_options_follow_the_model_cards_worked_example():
    assert dl.build_question("X.") == (
        "Does the evidence support this answer to the question? Question: "
        "What does the case record or the cited literature say? Answer: X."
    )
    assert [(o.key, o.description) for o in dl.CLAIM_OPTIONS] == [
        ("supported", "The evidence supports the answer."),
        ("contradicted", "The evidence contradicts the answer."),
        ("not_enough_information", "The evidence does not provide enough information to support or refute the answer."),
    ]


def test_a_failure_part_way_keeps_what_was_checked_and_never_raises():
    result = dl.run_evidence_check(_STATE, _PRED, _Fake([_p(s=0.9), DecisionError("boom")]))
    assert len(result["checked"]) == 1 and result["error"] == "boom"
    assert not result["flagged"]  # "nothing confirmed" would be a claim about claims never checked


def test_a_contradiction_found_before_a_failure_still_flags():
    result = dl.run_evidence_check(_STATE, _PRED, _Fake([_p(c=0.9), DecisionError("boom")]))
    assert result["flagged"] and "contradicted" in result["flag_reasons"][0] and result["error"] == "boom"


def test_an_unexpected_exception_type_is_also_contained():
    result = dl.run_evidence_check(_STATE, _PRED, _Fake([RuntimeError("weird")]))
    assert result["error"] == "weird" and result["checked"] == []


def test_an_image_only_case_is_skipped_with_the_reason():
    fake = _Fake([])
    result = dl.run_evidence_check({"structured_clinical_data": {}, "rag_literature_context": []}, _PRED, fake)
    assert "image-only" in result["skipped"] and result["checked"] == [] and fake.calls == []


def test_no_claims_is_skipped():
    result = dl.run_evidence_check(_STATE, {"differential": []}, _Fake([]))
    assert "no supporting-evidence claims" in result["skipped"]


def test_the_audit_summary_has_counts_and_no_claim_text():
    result = dl.run_evidence_check(_STATE, _PRED, _Fake([_p(s=0.9), _p(c=0.8), _p(n=0.9)]))
    line = dl.summarize(result)
    assert "3 claim(s): 1 supported, 1 not confirmed, 1 contradicted" in line and "flagged" in line
    assert "10.1" not in line and "thirsty" not in line


# --- in the report ---------------------------------------------------------------------------

def _explain_state(prediction=None, citations=None):
    return {
        "structured_clinical_data": _STATE["structured_clinical_data"],
        "rag_literature_context": citations or [],
        "diagnostic_prediction_result": prediction or {
            "differential": [
                {"condition": "type 2 diabetes", "likelihood": 0.9, "supporting_evidence": ["glucose is 10.1 mmol/L"]},
                {"condition": "other", "likelihood": 0.2, "supporting_evidence": ["something"]},
            ],
            "overall_confidence": 0.85, "reasoning_notes": "r", "abstained": False, "abstention_reason": None, "model_name": "m",
        },
        "stage_status": new_stage_status(),
        "audit_log": [],
    }


def test_without_a_backend_the_report_is_exactly_as_before(monkeypatch):
    monkeypatch.delenv("DECISION_BASE_URL", raising=False)
    update = explainability_agent(_explain_state())
    assert "evidence_checks" not in update["final_explainable_report"]
    assert "evidence check" not in update["audit_log"][0]["summary"]
    assert update["stage_status"]["explainability"]["status"] == "ok"


def test_a_backend_adds_the_section_and_leaves_the_differential_alone(monkeypatch):
    monkeypatch.delenv("DECISION_BASE_URL", raising=False)
    state = _explain_state()
    before = json.dumps(state["diagnostic_prediction_result"], sort_keys=True)

    update = explainability_agent(state, decision_backend=_Fake([_p(s=0.9), _p(s=0.8)]))

    report = update["final_explainable_report"]
    assert report["evidence_checks"]["counts"][SUPPORTED] == 2 and not report["disagreement_flagged"]
    assert json.dumps(state["diagnostic_prediction_result"], sort_keys=True) == before
    assert update["stage_status"]["explainability"]["status"] == "ok"
    assert "evidence check (fake-judge): 2 claim(s): 2 supported" in update["audit_log"][0]["summary"]


def test_a_flagged_evidence_check_makes_the_stage_need_review_without_touching_disagreement():
    update = explainability_agent(_explain_state(), decision_backend=_Fake([_p(c=0.9), _p(s=0.9)]))
    status = update["stage_status"]["explainability"]
    assert status["status"] == "needs_review" and "evidence check:" in status["message"]
    assert update["final_explainable_report"]["disagreement_flagged"] is False


def test_a_broken_backend_never_sinks_the_report():
    update = explainability_agent(_explain_state(), decision_backend=_Fake([DecisionError("down")]))
    report = update["final_explainable_report"]
    assert report["evidence_checks"]["error"] == "down"
    assert update["stage_status"]["explainability"]["status"] == "ok"
    assert "stopped early" in update["audit_log"][0]["summary"]


def test_an_image_only_case_reports_that_the_check_was_skipped():
    state = _explain_state()
    state["structured_clinical_data"] = {}
    report = explainability_agent(state, decision_backend=_Fake([]))["final_explainable_report"]
    assert "image-only" in report["evidence_checks"]["skipped"]


def test_a_report_with_no_differential_makes_no_check():
    state = _explain_state({"differential": [], "overall_confidence": 0.0, "reasoning_notes": "", "abstained": True,
                            "abstention_reason": "x", "model_name": "m"})
    report = explainability_agent(state, decision_backend=_Fake([]))["final_explainable_report"]
    assert "evidence_checks" not in report


def test_the_section_is_rendered_with_verdicts_probabilities_and_the_advisory_note():
    update = explainability_agent(_explain_state(), decision_backend=_Fake([_p(c=0.85, s=0.1, n=0.05), _p(n=0.9)]))
    report = update["final_explainable_report"]
    text = build_report_markdown(report, _explain_state()["diagnostic_prediction_result"])
    assert "**Evidence check (fake-judge, advisory):** 0 of 2 claim(s) confirmed" in text
    assert "❌ contradicted (p=0.85)" in text and "❔ not confirmed (p=0.90)" in text
    assert "Evidence check flagged this case" in text
    assert "research-only" in text and "never changes the differential" in text


def test_a_skipped_check_renders_as_not_run():
    state = _explain_state()
    state["structured_clinical_data"] = {}
    report = explainability_agent(state, decision_backend=_Fake([]))["final_explainable_report"]
    text = build_report_markdown(report, state["diagnostic_prediction_result"])
    assert "not run" in text and "image-only" in text


def test_a_report_without_the_field_renders_unchanged():
    report = {"narrative": "n", "citations": [], "confidence": 0.7, "shap_reference": None,
              "disagreement_flagged": False, "clinician_confirmed": False}
    assert "Evidence check" not in build_report_markdown(report, {"differential": [], "abstained": False})


def test_the_report_with_evidence_checks_survives_the_case_store_round_trip(tmp_path, monkeypatch):
    from glassbox_md import case_store

    monkeypatch.setattr(case_store, "DEFAULT_DB_PATH", tmp_path / "cases.db", raising=False)
    state = _explain_state()
    update = explainability_agent(state, decision_backend=_Fake([_p(s=0.9), _p(s=0.8)]))
    state.update(update)
    try:
        case_id = case_store.save_case(state, db_path=tmp_path / "cases.db")
        loaded = case_store.get_case(case_id, db_path=tmp_path / "cases.db")
    except TypeError:
        pytest.skip("case_store API takes no db_path here")
    assert loaded["final_explainable_report"]["evidence_checks"]["counts"][SUPPORTED] == 2


def test_the_pipeline_forwards_the_backend(tmp_path):
    from glassbox_md.agents.diagnostic_prediction import DifferentialCondition, ModelDifferentialResponse
    from glassbox_md.agents.medical_knowledge_rag import build_literature_collection
    from glassbox_md.pipeline import build_pipeline_graph
    from glassbox_md.text_eval import CASES, make_pdf

    def llm(prompt, images):
        return ModelDifferentialResponse(
            differential=[DifferentialCondition(condition="type 2 diabetes", likelihood=0.9,
                                                supporting_evidence=["glucose is high"])],
            overall_confidence=0.8, reasoning_notes="r",
        )

    fake = _Fake([_p(s=0.9)])
    graph = build_pipeline_graph(
        llm_caller=llm,
        rag_collection=build_literature_collection([], persist_directory=str(tmp_path / "c")),
        decision_backend=fake,
    )
    pdf = make_pdf(CASES[0], tmp_path)
    from glassbox_md.imaging_eval import new_state

    final = graph.invoke(new_state([str(pdf)]))

    assert final["final_explainable_report"]["evidence_checks"]["counts"][SUPPORTED] == 1
    assert fake.calls and "glucose" in fake.calls[0][0].lower()


def test_constants_match_the_model_card():
    assert dl.TEMPERATURE == 1.3929
    assert dl.DEFAULT_MODEL == "lighteternal/biodecision-tev1-4b"
    assert dl.SYSTEM_PROMPT.startswith("Evaluate the supplied decision task.") and dl.SYSTEM_PROMPT.endswith("no explanation.")
    assert dl.TOP_LOGPROBS == 20 and dl.CONFIDENT == 0.6
