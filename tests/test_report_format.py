"""The report's wording is part of the product's honesty, so it is tested:
the labels that stop a reader mistaking the model's account of itself, an
uncalibrated confidence number, retrieved (not verified) citations, or an
unrelated SHAP demo for a case-level explanation."""

from glassbox_md.agents.diagnostic_prediction import CONFIDENCE_THRESHOLD, DEFAULT_MODEL_NAME
from glassbox_md.report_format import CONFIDENCE_HIGH_BAND, build_report_markdown, confidence_badge

SHAP_TEXT = "RandomForestClassifier (100 trees); top features: bmi (+0.244), bp (+0.053)"


def _report(**overrides):
    report = {
        "narrative": "Insufficient evidence.",
        "citations": [{"source_id": "1", "title": "A real paper", "url": "https://pubmed.ncbi.nlm.nih.gov/1/", "passage": "p"}],
        "confidence": 0.55,
        "shap_reference": SHAP_TEXT,
        "disagreement_flagged": False,
        "clinician_confirmed": False,
    }
    report.update(overrides)
    return report


def _prediction(**overrides):
    prediction = {
        "differential": [
            {"condition": "less likely", "likelihood": 0.2, "supporting_evidence": ["a"]},
            {"condition": "more likely", "likelihood": 0.6, "supporting_evidence": ["b", "c"]},
        ],
        "overall_confidence": 0.55,
        "reasoning_notes": "Because of the image.",
        "abstained": False,
        "model_name": "some-provider/some-model:free",
    }
    prediction.update(overrides)
    return prediction


def test_differential_is_a_table_sorted_by_likelihood():
    text = build_report_markdown(_report(), _prediction())

    assert text.index("more likely") < text.index("less likely")
    assert "| 🟡 | more likely | 0.60 | b; c |" in text


def test_reasoning_is_labelled_as_the_models_own_account_not_a_verified_explanation():
    text = build_report_markdown(_report(), _prediction())

    assert "**Model's self-reported reasoning:** Because of the image." in text
    assert "not a verified explanation" in text


def test_confidence_is_labelled_self_reported_and_uncalibrated():
    text = build_report_markdown(_report(confidence=0.55), _prediction())

    assert "self-reported by the model, not calibrated" in text
    assert "0.55" in text


def test_the_model_that_answered_is_shown():
    text = build_report_markdown(_report(), _prediction(model_name="nex-agi/nex-n2.5-pro:free"))

    assert "**Answered by:** `nex-agi/nex-n2.5-pro:free`" in text


def test_a_router_alias_is_flagged_as_not_identifying_the_model():
    text = build_report_markdown(_report(), _prediction(model_name=DEFAULT_MODEL_NAME))

    assert f"`{DEFAULT_MODEL_NAME}` (a router alias" in text
    assert "was not recorded" in text


def test_a_case_saved_without_a_model_name_shows_no_answered_by_line():
    prediction = _prediction()
    del prediction["model_name"]

    assert "Answered by" not in build_report_markdown(_report(), prediction)


def test_citations_are_labelled_retrieved_not_verified():
    text = build_report_markdown(_report(), _prediction())

    assert "**Retrieved literature**" in text
    assert "nothing here verifies that they support the answer" in text
    assert "- [A real paper](https://pubmed.ncbi.nlm.nih.gov/1/)" in text
    assert "Cited literature" not in text


def test_no_citation_section_when_there_are_none():
    assert "Retrieved literature" not in build_report_markdown(_report(citations=[]), _prediction())


def test_shap_demo_is_a_separated_footer_that_says_it_is_not_about_this_case():
    text = build_report_markdown(_report(disagreement_flagged=True), _prediction())

    body, _, footer = text.partition("\n---\n")
    assert "Not about this case -- SHAP demo" in footer
    assert "says nothing about why the model answered this patient" in footer
    assert SHAP_TEXT in footer
    # it comes last: after the review flag, never mixed into the case's own content
    assert "Flagged for review" in body
    assert "SHAP" not in body


def test_shap_text_never_appears_when_there_is_none():
    text = build_report_markdown(_report(shap_reference=None), _prediction())

    assert "SHAP" not in text
    assert "\n---\n" not in text


def test_an_abstained_case_with_no_differential_shows_the_narrative_and_the_confidence():
    text = build_report_markdown(
        _report(narrative="Not enough evidence to produce a differential.", confidence=0.0),
        _prediction(abstained=True, differential=[], reasoning_notes=None),
    )

    assert text.startswith("Not enough evidence to produce a differential.")
    assert "### Ranked differential" not in text
    assert "not calibrated" in text


def test_flagged_cases_say_inconclusive():
    text = build_report_markdown(_report(disagreement_flagged=True), _prediction())

    assert "Treat as inconclusive, not a settled result." in text


def test_confidence_badge_bands_track_the_backends_abstention_threshold():
    assert confidence_badge(CONFIDENCE_THRESHOLD - 0.01) == "🔴"
    assert confidence_badge(CONFIDENCE_THRESHOLD) == "🟡"
    assert confidence_badge(CONFIDENCE_HIGH_BAND - 0.01) == "🟡"
    assert confidence_badge(CONFIDENCE_HIGH_BAND) == "🟢"
