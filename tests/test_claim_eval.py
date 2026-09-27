"""The evidence-check test set: that its labels are true by construction, that
the scoring is right, and that the standalone GPU script cannot drift from the
decision layer it stands in for."""

import importlib.util
import json
from pathlib import Path

import pytest

from glassbox_md import claim_eval as ce
from glassbox_md import decision_layer as dl

ROOT = Path(__file__).resolve().parent.parent
ITEMS_FILE = ROOT / "docs" / "comparison" / "claim-eval-items.jsonl"


@pytest.fixture(scope="module")
def items():
    return ce.build_items()


# --- the items ------------------------------------------------------------------------

def test_the_set_is_224_items_with_the_expected_class_balance(items):
    assert len(items) == 224
    assert {g: sum(i.gold == g for i in items) for g in ce.GOLDS} == {
        dl.SUPPORTED: 96, dl.CONTRADICTED: 64, dl.NOT_ENOUGH: 64,
    }
    assert len({i.item_id for i in items}) == len(items)


def test_every_case_contributes_seven_items(items):
    from collections import Counter

    assert set(Counter(i.case_id for i in items).values()) == {7}


def test_the_committed_items_file_matches_a_fresh_build(items):
    """If the redaction policy or the cases change, the sources change; regenerate with
    `python scripts/eval_claims.py build --out docs/comparison/claim-eval-items.jsonl`."""
    assert [json.loads(line) for line in ITEMS_FILE.read_text(encoding="utf-8").splitlines() if line.strip()] == [
        json.loads(json.dumps(i.__dict__)) for i in items
    ]


def test_supported_lab_claims_state_a_number_the_source_contains(items):
    import re

    for item in (i for i in items if i.kind == "lab_original"):
        number = re.search(r"is ([\d.]+) ", item.claim).group(1)
        assert re.search(rf"\b{re.escape(number)}\b", item.source), item.item_id


def test_supported_normalised_lab_claims_match_a_lab_value_line(items):
    import re

    for item in (i for i in items if i.kind == "lab_canonical"):
        number = float(re.search(r"is ([\d.]+) ", item.claim).group(1))
        values = [float(v) for v in re.findall(r"^- \w+: ([\d.]+) ", item.source, flags=re.M)]
        assert any(abs(v - number) < 0.051 for v in values), item.item_id


def test_contradicted_lab_values_do_not_appear_in_the_source(items):
    import re

    for item in (i for i in items if i.kind == "lab_wrong_value"):
        number = re.search(r"is ([\d.]+) ", item.claim).group(1)
        assert not re.search(rf"(?<![\d.]){re.escape(number)}(?![\d.])", item.source), item.item_id


def test_age_claims_use_the_band_in_the_source_and_the_wrong_ones_use_another(items):
    import re

    for item in (i for i in items if i.kind == "age"):
        band = re.search(r"is (\d{2}-\d{2}) years old", item.claim).group(1)
        assert f"{band} year old" in item.source
    for item in (i for i in items if i.kind == "age_wrong"):
        band = re.search(r"is (\d{2}-\d{2}) years old", item.claim).group(1)
        assert f"{band} year old" not in item.source


def test_not_enough_information_facts_are_absent_from_their_own_source(items):
    needles = {claim: words for claim, words in ce._ABSENT_FACTS}
    for item in (i for i in items if i.gold == dl.NOT_ENOUGH):
        assert not any(w in item.source.lower() for w in needles[item.claim]), item.item_id


def test_sources_are_what_the_diagnostic_model_sees(items):
    source = items[0].source
    assert source.startswith("Patient history:") and "Lab values:" in source and "Retrieved literature:" in source
    assert "<DATE_TIME>" not in source


def test_sample_is_balanced_deterministic_and_seed_sensitive(items):
    a = ce.sample(items, 5, seed=1)
    assert [i.item_id for i in a] == [i.item_id for i in ce.sample(items, 5, seed=1)]
    assert {g: sum(i.gold == g for i in a) for g in ce.GOLDS} == {g: 5 for g in ce.GOLDS}
    assert [i.item_id for i in a] != [i.item_id for i in ce.sample(items, 5, seed=2)]


def test_items_round_trip_through_the_file(items, tmp_path):
    ce.write_items(tmp_path / "i.jsonl", items[:5])
    assert ce.load_items(tmp_path / "i.jsonl") == items[:5]


# --- scoring ---------------------------------------------------------------------------

def _scores(items, chooser):
    return {i.item_id: {"item_id": i.item_id, "probabilities": chooser(i), "seconds": 1.0} for i in items}


def _peaked(key, p=0.9):
    rest = (1 - p) / 2
    return {k: (p if k == key else rest) for k in ce.GOLDS}


def test_a_perfect_judge_scores_perfectly(items):
    r = ce.score(items, _scores(items, lambda i: _peaked(i.gold)))
    assert r["accuracy"]["rate"] == 1.0 and r["false_pass"]["hits"] == 0 and r["false_alarm"]["hits"] == 0
    assert all(b["rate"] == 1.0 for b in r["per_class"].values())
    assert r["coverage_at_threshold"]["rate"] == 1.0


def test_a_judge_that_says_supported_to_everything_has_a_false_pass_rate_of_one(items):
    r = ce.score(items, _scores(items, lambda i: _peaked(dl.SUPPORTED)))
    assert r["false_pass"]["rate"] == 1.0 and r["false_pass"]["n"] == 128
    assert r["per_class"][dl.SUPPORTED]["rate"] == 1.0 and r["per_class"][dl.CONTRADICTED]["rate"] == 0.0
    assert r["accuracy"]["rate"] == pytest.approx(96 / 224)


def test_a_judge_that_says_contradicted_to_supported_claims_has_false_alarms(items):
    r = ce.score(items, _scores(items, lambda i: _peaked(dl.CONTRADICTED if i.gold == dl.SUPPORTED else i.gold)))
    assert r["false_alarm"]["rate"] == 1.0 and r["false_pass"]["hits"] == 0


def test_errored_and_missing_items_are_excluded_and_counted(items):
    scores = _scores(items[:10], lambda i: _peaked(i.gold))
    scores[items[0].item_id] = {"item_id": items[0].item_id, "error": "boom"}
    r = ce.score(items, scores)
    assert r["n_scored"] == 9 and r["n_errors_or_missing"] == len(items) - 9


def test_low_confidence_answers_lower_the_coverage(items):
    r = ce.score(items, _scores(items, lambda i: {dl.SUPPORTED: 0.4, dl.CONTRADICTED: 0.3, dl.NOT_ENOUGH: 0.3}))
    assert r["coverage_at_threshold"]["rate"] == 0.0 and r["accuracy_when_confident"]["n"] == 0


def test_the_confusion_matrix_counts_every_scored_item(items):
    r = ce.score(items, _scores(items, lambda i: _peaked(dl.NOT_ENOUGH)))
    assert sum(sum(row.values()) for row in r["confusion"].values()) == len(items)


def test_by_kind_covers_every_kind(items):
    r = ce.score(items, _scores(items, lambda i: _peaked(i.gold)))
    assert set(r["by_kind"]) == {"lab_original", "lab_canonical", "age", "lab_wrong_value", "age_wrong", "absent_fact"}


def test_the_report_states_its_limits_and_has_no_nan(items):
    text = ce.render_markdown(ce.score(items, _scores(items, lambda i: _peaked(i.gold))), "fake judge", {"device": "cpu"})
    for needle in ("fake judge", "False pass", "Confusion", "By claim kind", "## Caveats", "device=cpu", "templated"):
        assert needle.lower() in text.lower()
    assert "nan" not in text.lower()


def test_the_report_handles_a_run_with_nothing_scored(items):
    text = ce.render_markdown(ce.score(items, {}), "nobody")
    assert "n/a" in text and "nan" not in text.lower()


class _Backend:
    name = "fake"

    def __init__(self):
        self.calls = []

    def decide(self, state, question, options):
        self.calls.append(question)
        if "72.8" in question:
            raise dl.DecisionError("boom")
        return {dl.SUPPORTED: 0.8, dl.CONTRADICTED: 0.1, dl.NOT_ENOUGH: 0.1}


def test_run_backend_records_errors_instead_of_raising(items):
    backend = _Backend()
    subset = [i for i in items if i.case_id == "t2d-1"]
    records = ce.run_backend(subset, backend, log=lambda *_: None)
    assert len(records) == len(subset) and sum("error" in r for r in records) == 1
    assert all("probabilities" in r for r in records if "error" not in r)
    assert backend.calls[0] == dl.build_question(subset[0].claim)


# --- the standalone GPU script ---------------------------------------------------------

@pytest.fixture(scope="module")
def standalone():
    spec = importlib.util.spec_from_file_location("biodecision_score", ROOT / "scripts" / "biodecision_score.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # imports no torch until main() runs
    return module


def test_the_standalone_script_matches_the_decision_layer(standalone):
    assert standalone.SYSTEM == dl.SYSTEM_PROMPT
    assert standalone.TEMPERATURE == dl.TEMPERATURE
    assert standalone.REPO == dl.DEFAULT_MODEL
    assert standalone.OPTIONS == tuple((o.key, o.description) for o in dl.CLAIM_OPTIONS)
    assert standalone.QUESTION == dl.CLAIM_QUESTION
    assert standalone.build_question("X.") == dl.build_question("X.")


def test_the_standalone_messages_are_byte_identical_to_the_backends_request(standalone):
    from types import SimpleNamespace

    top = [SimpleNamespace(token=t, logprob=lp) for t, lp in (("A", -0.1), ("B", -3.0), ("C", -4.0))]
    completion = SimpleNamespace(choices=[SimpleNamespace(logprobs=SimpleNamespace(content=[SimpleNamespace(top_logprobs=top)]))])
    seen = {}

    class _C:
        class chat:
            class completions:
                @staticmethod
                def create(**kw):
                    seen.update(kw)
                    return completion

    dl.OpenAICompatibleBackend("http://x/v1", client=_C()).decide("SRC", dl.build_question("claim"), dl.CLAIM_OPTIONS)
    assert seen["messages"] == standalone.build_messages("SRC", "claim")


def test_the_standalone_probabilities_match_the_backends_arithmetic(standalone):
    from types import SimpleNamespace

    lps = (-0.2, -2.0, -3.5)
    top = [SimpleNamespace(token=t, logprob=lp) for t, lp in zip("ABC", lps)]
    completion = SimpleNamespace(choices=[SimpleNamespace(logprobs=SimpleNamespace(content=[SimpleNamespace(top_logprobs=top)]))])
    backend = dl.OpenAICompatibleBackend._probabilities(completion, list("ABC"), [k for k, _ in standalone.OPTIONS])
    # logits and logprobs differ by a constant, which the softmax cancels
    direct = standalone.probs_from_logits([5.0 + lp for lp in lps])
    assert [backend[k] for k, _ in standalone.OPTIONS] == pytest.approx(direct)
