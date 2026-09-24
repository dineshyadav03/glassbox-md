"""The text-only case set: its integrity, its scorer, and that every case
survives the real parse -> privacy -> normalize path with its labs intact."""

import pytest

from glassbox_md import text_eval as te
from glassbox_md.agents.data_preparation import LAB_CONVERSIONS
from glassbox_md.agents.diagnostic_prediction import DifferentialCondition, ModelDifferentialResponse
from glassbox_md.agents.medical_knowledge_rag import build_literature_collection
from glassbox_md.pipeline import build_pipeline_graph

_LAB_KEY = {"Hemoglobin A1c": "hemoglobin_a1c"}


def _key(name):
    return _LAB_KEY.get(name, name.lower().replace(" ", "_"))


# --- the case set -------------------------------------------------------------

def test_case_ids_are_unique_and_groups_are_known():
    ids = te.case_ids()
    assert len(ids) == len(set(ids))
    assert {c.group for c in te.CASES} == {"single", "comorbid", "control"}


def test_every_condition_has_at_least_four_single_cases():
    for key in te.CONDITIONS:
        assert sum(c.group == "single" and c.expected == (key,) for c in te.CASES) >= 4, key


def test_group_expectations_are_consistent():
    for c in te.CASES:
        assert set(c.expected) <= set(te.CONDITIONS)
        if c.group == "single":
            assert len(c.expected) == 1
        elif c.group == "comorbid":
            assert len(c.expected) == 2
        else:
            assert c.expected == ()


def test_every_lab_is_one_the_pipeline_knows_in_a_unit_it_can_read():
    for c in te.CASES:
        for name, value, unit in c.labs:
            spec = LAB_CONVERSIONS[_key(name)]
            assert unit in (spec.canonical_unit, spec.us_unit), (c.case_id, name, unit)
            assert isinstance(value, (int, float))


def test_no_case_history_states_the_answer_by_name():
    """A case that says 'diabetes' outright tests reading, not reasoning; the
    only allowed mentions are family history and prior-year context."""
    # Family history ("Father had diabetes", "Sister has Hashimoto") or a test
    # result that is evidence rather than a label ("Coronary calcium score").
    allowed = {"t2d-1", "thy-4", "cad-4"}
    for c in te.CASES:
        if c.case_id in allowed:
            continue
        hits = te.condition_keys_in(c.history)
        # com-2 says "diabetic for twelve years" on purpose: the second condition is what is being asked
        if c.case_id == "com-2":
            hits -= {"type_2_diabetes"}
        assert not hits, (c.case_id, hits)


# --- matching model text -------------------------------------------------------

@pytest.mark.parametrize(
    "text, expected",
    [
        ("Type 2 diabetes mellitus", {"type_2_diabetes"}),
        ("Prediabetes", set()),
        ("No evidence of hypertension", set()),
        ("Essential hypertension", {"hypertension"}),
        ("Pulmonary hypertension", set()),
        ("Chronic kidney disease, stage 4", {"chronic_kidney_disease"}),
        ("Primary hypothyroidism (Hashimoto)", {"hypothyroidism"}),
        ("Stable angina pectoris", {"coronary_artery_disease"}),
        ("Familial hypercholesterolemia", {"hyperlipidemia"}),
        ("Normal", set()),
        (None, set()),
    ],
)
def test_condition_matching(text, expected):
    assert te.condition_keys_in(text) == expected


def test_names_no_condition():
    assert te.names_no_condition("Normal / no acute abnormality")
    assert te.names_no_condition("Healthy adult")
    assert not te.names_no_condition("Normal heart size but type 2 diabetes")
    assert not te.names_no_condition(None)


# --- scoring -------------------------------------------------------------------

def _case(cid):
    return next(c for c in te.CASES if c.case_id == cid)


def _rec(top1, top3=None, error=None):
    return {"top1_condition": top1, "top3": top3 or ([top1] if top1 else []), "error": error}


def test_single_case_scores_top1_and_reports_top3():
    c = _case("t2d-1")
    assert te.score_record(c, _rec("Type 2 diabetes"))["correct"] is True
    miss = te.score_record(c, _rec("Hypothyroidism", ["Hypothyroidism", "Type 2 diabetes"]))
    assert miss["correct"] is False and miss["top3_hit"] is True


def test_single_case_naming_an_extra_condition_is_not_a_miss():
    assert te.score_record(_case("t2d-1"), _rec("Type 2 diabetes with hypertension"))["correct"] is True


def test_comorbid_needs_both_in_the_top_three():
    c = _case("com-1")
    both = te.score_record(c, _rec("Type 2 diabetes", ["Type 2 diabetes", "Hypertension", "Anemia"]))
    one = te.score_record(c, _rec("Type 2 diabetes", ["Type 2 diabetes", "Anemia"]))
    assert both["correct"] is True and one["correct"] is False


def test_control_is_a_false_alarm_only_if_top1_names_a_condition():
    c = _case("ctl-1")
    assert te.score_record(c, _rec("Normal, no acute abnormality"))["correct"] is True
    alarm = te.score_record(c, _rec("Hypothyroidism"))
    assert alarm["correct"] is False and alarm["false_alarm"] is True
    assert te.score_record(c, _rec("Unspecified fatigue"))["correct"] is True  # names no target condition


def test_errored_records_are_not_answered():
    assert te.score_record(_case("t2d-1"), _rec(None, error="boom")) == {"answered": False}


def test_summarize_counts_groups_and_excludes_errors():
    records = [
        {"case_id": "t2d-1", **_rec("Type 2 diabetes"), "overall_confidence": 0.9, "abstained": False, "wall_seconds": 5.0},
        {"case_id": "t2d-2", **_rec("Hypothyroidism"), "overall_confidence": 0.9, "abstained": False, "wall_seconds": 5.0},
        {"case_id": "ctl-1", **_rec(None, error="x"), "overall_confidence": None, "abstained": None, "wall_seconds": 1.0},
    ]
    s = te.summarize(records)
    assert s["n_cases"] == 3 and s["n_errors"] == 1
    assert s["single"]["n"] == 2 and s["single"]["n_correct"] == 1
    assert s["control"]["n"] == 0
    assert "nan" not in te.render_markdown(s).lower()


def test_load_records_last_write_wins_and_skips_junk(tmp_path):
    path = tmp_path / "r.jsonl"
    path.write_bytes(b'{"case_id": "t2d-1", "error": "x"}\nnot json\n{"case_id": "t2d-1", "error": null}\n')
    records = te.load_records(path)
    assert len(records) == 1 and records[0]["error"] is None
    assert te.completed_ids(path) == {"t2d-1"}
    assert te.completed_ids(path, retry_errors=True) == {"t2d-1"}


# --- every case through the real pipeline (fake model, empty RAG) --------------

class _Echo:
    def __init__(self):
        self.prompts = []

    def __call__(self, prompt, image_paths):
        self.prompts.append(prompt)
        return ModelDifferentialResponse(
            differential=[DifferentialCondition(condition="x", likelihood=0.5, supporting_evidence=["e"])],
            overall_confidence=0.6,
            reasoning_notes="n",
        )


@pytest.fixture(scope="module")
def empty_collection(tmp_path_factory):
    # No literature: these cases only need to get through the pipeline.
    return build_literature_collection([], persist_directory=str(tmp_path_factory.mktemp("chroma")))


@pytest.mark.parametrize("case", te.CASES, ids=lambda c: c.case_id)
def test_every_case_reaches_the_model_with_its_labs_and_history(case, tmp_path, empty_collection):
    echo = _Echo()
    graph = build_pipeline_graph(llm_caller=echo, rag_collection=empty_collection)

    record = te.run_case(graph, case, tmp_path)

    assert record["error"] is None, record["error"]
    assert len(echo.prompts) == 1
    prompt = echo.prompts[0]
    for name, value, _unit in case.labs:
        assert _key(name) in prompt.lower().replace(" ", "_") or name.lower() in prompt.lower(), (case.case_id, name)
    # Not verbatim: the Privacy agent bands ages ("52 year old" -> "50-59 year old")
    # and redacts a bare number after "at". What must survive is the clinical
    # substance, so check that most of the descriptive words do.
    words = {w for w in "".join(ch if ch.isalpha() else " " for ch in case.history.lower()).split() if len(w) >= 5}
    kept = {w for w in words if w in prompt.lower()}
    assert len(kept) >= 0.6 * len(words), (case.case_id, sorted(words - kept))
