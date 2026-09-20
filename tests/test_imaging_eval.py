"""Tests for the imaging evaluation harness (glassbox_md.imaging_eval).

Fully offline: the two network functions are monkeypatched with canned
responses, and the pipeline runs with an injected fake `llm_caller`, the
same way test_pipeline.py does it -- no OpenRouter key, no Hugging Face
access, no real images. `run_eval`'s loop tests use a stub graph instead
of the real one, so only the single end-to-end test pays for a real
six-agent run.
"""

import importlib.util
import json
import logging
from argparse import Namespace
from pathlib import Path

import numpy as np
import pydicom
import pytest

from glassbox_md import imaging_eval
from glassbox_md.agents.diagnostic_prediction import DifferentialCondition, ModelDifferentialResponse
from glassbox_md.agents.explainability import DISAGREEMENT_MARGIN
from glassbox_md.agents.medical_knowledge_rag import build_literature_collection
from glassbox_md.imaging_eval import (
    categorize_condition,
    collect_meta,
    completed_rows,
    evaluate_row,
    load_results,
    render_markdown,
    run_case,
    run_eval,
    sample_rows,
    summarize,
    wilson_interval,
    wrap_as_dicom,
)
from glassbox_md.pipeline import build_pipeline_graph
from glassbox_md.state import STAGE_NAMES

SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "eval_imaging.py"


# --- categorize_condition ------------------------------------------------------

@pytest.mark.parametrize(
    "text, expected",
    [
        # pneumonia
        ("Pneumonia", "pneumonia"),
        ("pneumonia", "pneumonia"),
        ("Bronchopneumonia", "pneumonia"),
        ("Lobar pneumonia", "pneumonia"),
        ("Community-acquired pneumonia", "pneumonia"),
        ("Right lower lobe consolidation", "pneumonia"),
        ("Right lower lobe infiltrate", "pneumonia"),
        ("Bilateral infiltrates", "pneumonia"),
        ("Focal airspace opacity", "pneumonia"),
        ("Viral bronchiolitis or mild viral pneumonia", "pneumonia"),  # names pneumonia explicitly
        ("Right lower lobe pneumonia without effusion", "pneumonia"),  # "without" comes AFTER the term
        ("Viral pneumonia, likely", "pneumonia"),
        ("Pneumonia not excluded", "pneumonia"),
        ("Rule out pneumonia", "pneumonia"),
        ("Normal heart size, lobar pneumonia", "pneumonia"),
        ("No pleural effusion but pneumonia", "pneumonia"),  # negation stops at the contrast word
        # normal
        ("Normal", "normal"),
        ("Normal chest X-ray", "normal"),
        ("No acute cardiopulmonary abnormality", "normal"),
        ("No acute findings", "normal"),
        ("Unremarkable chest radiograph", "normal"),
        ("Normal chest (no pneumonia)", "normal"),
        ("Normal chest, no consolidation", "normal"),
        # negated or hedged pneumonia is not pneumonia -- and not credited as normal either
        ("No pneumonia", "other"),
        ("no evidence of pneumonia", "other"),
        ("No acute or chronic pneumonia", "other"),
        ("Without consolidation", "other"),
        ("No focal consolidation", "other"),
        ("Negative for pneumonia", "other"),
        ("Pneumonia unlikely", "other"),
        ("Pneumonia is unlikely", "other"),
        ("Pneumonia (unlikely)", "other"),
        ("Pneumonia ruled out", "other"),
        ("Pneumonia excluded", "other"),
        ("Pneumonia not seen", "other"),
        ("Absence of bronchopneumonia", "other"),
        # found by independent review: the earlier 5-word window and comma
        # clause-break let all of these through as a pneumonia call
        ("No radiographic evidence of acute bacterial pneumonia", "other"),
        ("No evidence of focal airspace consolidation or pneumonia", "other"),
        ("No pleural effusion, pneumothorax, or pneumonia", "other"),
        ("Neither pneumonia nor effusion", "other"),
        ("Unlikely pneumonia", "other"),
        ("Low probability of pneumonia", "other"),
        ("Findings inconsistent with pneumonia", "other"),
        ("Lack of pneumonia", "other"),
        ("Non-pneumonia", "other"),
        ("Pneumonia, ruled out", "other"),
        ("Pneumonia, unlikely", "other"),
        ("Pneumonia, less likely", "other"),
        ("Pneumonia can be excluded", "other"),
        ("Pneumonia is not the diagnosis", "other"),
        # adjacent diagnoses are deliberately NOT credited as pneumonia
        ("Pneumonitis", "other"),
        ("Radiation pneumonitis", "other"),
        ("Hypersensitivity pneumonitis", "other"),
        ("Lower respiratory tract infection", "other"),
        ("Viral bronchiolitis", "other"),
        # not normal
        ("Abnormal chest radiograph", "other"),
        ("Not normal", "other"),
        ("Non-normal", "other"),
        ("Normal heart size with right pleural effusion", "other"),
        ("Normal lung volumes but pleural effusion", "other"),
        ("Normal cardiac silhouette with hyperinflation", "other"),
        # ... and the wording a model realistically uses for a normal film
        ("No abnormalities detected", "normal"),
        ("No active disease", "normal"),
        ("No significant abnormality", "normal"),
        ("No focal abnormality", "normal"),
        ("Clear lungs", "normal"),
        ("Lungs are clear", "normal"),
        ("Negative chest radiograph", "normal"),
        ("Normal pediatric chest variant with prominent thymus", "normal"),
        ("Normal chest, no effusion", "normal"),
        # everything else
        ("Pleural effusion", "other"),
        ("Atelectasis", "other"),
        ("Type 2 diabetes", "other"),
        ("No acute kidney injury", "other"),
        ("", "other"),
        (None, "other"),
    ],
)
def test_categorize_condition(text, expected):
    assert categorize_condition(text) == expected


# --- wilson_interval -----------------------------------------------------------

@pytest.mark.parametrize(
    "successes, trials, low, high",
    [
        # Hand-computed from the closed form
        # (2k + z^2 -/+ z*sqrt(z^2 + 4k(n-k)/n)) / (2(n + z^2)), z = 1.96.
        (3, 4, 0.3006, 0.9544),
        (5, 10, 0.2366, 0.7634),
        (0, 10, 0.0, 0.2775),  # z^2/(n+z^2) exactly, and the lower bound is clamped at 0
        (10, 10, 0.7225, 1.0),
        (9, 12, 0.4677, 0.9111),
        (20, 24, 0.6415, 0.9332),
    ],
)
def test_wilson_interval_matches_hand_computed_values(successes, trials, low, high):
    lower, upper = wilson_interval(successes, trials)
    assert lower == pytest.approx(low, abs=5e-5)
    assert upper == pytest.approx(high, abs=5e-5)


def test_wilson_interval_has_no_answer_without_trials():
    assert wilson_interval(0, 0) is None


def test_wilson_interval_rejects_impossible_counts():
    with pytest.raises(ValueError):
        wilson_interval(5, 4)


def test_wilson_interval_stays_inside_zero_one_and_brackets_the_point_estimate():
    for trials in (1, 2, 7, 24, 100):
        for successes in range(trials + 1):
            lower, upper = wilson_interval(successes, trials)
            assert 0.0 <= lower <= successes / trials <= upper <= 1.0


# --- summarize -----------------------------------------------------------------

def _rec(row_idx, true, top1, confidence, *, top3=None, flagged=False, abstained=False, error=None, **extra):
    return {
        "row_idx": row_idx,
        "true_label": true,
        "top1_condition": top1,
        "top1_likelihood": 0.5,
        "overall_confidence": confidence,
        "top3": top3 if top3 is not None else [top1],
        "abstained": abstained,
        "disagreement_flagged": flagged,
        "stage_status": {},
        "error": error,
        "wall_seconds": 2.0,
        "model_name": "fake-model",
        **extra,
    }


def _hand_computed_results():
    return [
        # PNEUMONIA: two hits, one "other" (with pneumonia in its top 3), one "normal", one abstained
        _rec(1, "PNEUMONIA", "Pneumonia", 0.8),
        _rec(2, "PNEUMONIA", "Bronchopneumonia", 0.7),
        _rec(3, "PNEUMONIA", "Pleural effusion", 0.5, top3=["Pleural effusion", "Lobar pneumonia", "Atelectasis"], flagged=True),
        _rec(4, "PNEUMONIA", "Normal chest X-ray", 0.9, top3=["Normal chest X-ray", "Atelectasis"]),
        _rec(5, "PNEUMONIA", "Pneumonia", 0.2, flagged=True, abstained=True),
        # NORMAL: three hits, one false positive, one errored
        _rec(6, "NORMAL", "Normal chest", 0.9),
        _rec(7, "NORMAL", "No acute cardiopulmonary abnormality", 0.6, flagged=True),
        _rec(8, "NORMAL", "Pneumonia", 0.8),
        _rec(9, "NORMAL", "Unremarkable chest radiograph", 0.5, flagged=True),
        _rec(10, "NORMAL", None, None, error="diagnostic_prediction failed: timeout", flagged=None),
    ]


def test_summarize_matches_hand_computed_values():
    s = summarize(_hand_computed_results())

    # accounting: nothing silently dropped
    assert (s["n"], s["n_errored"], s["n_abstained"], s["n_scored"]) == (10, 1, 1, 8)
    assert s["coverage"] == pytest.approx(0.8)
    assert s["by_true_label"] == {
        "PNEUMONIA": {"n": 5, "errored": 0, "abstained": 1, "scored": 4},
        "NORMAL": {"n": 5, "errored": 1, "abstained": 0, "scored": 4},
    }

    # correct = rows 1, 2, 6, 7, 9
    assert s["n_correct"] == 5
    assert s["accuracy"] == pytest.approx(5 / 8)
    assert s["accuracy_ci95"] == pytest.approx(list(wilson_interval(5, 8)))
    assert s["accuracy_all_cases"] == pytest.approx(0.5)  # 5 of all 10, errored/abstained counted wrong

    assert (s["n_pneumonia_scored"], s["n_pneumonia_hit"]) == (4, 2)
    assert s["sensitivity"] == pytest.approx(0.5)
    assert s["sensitivity_ci95"] == pytest.approx(list(wilson_interval(2, 4)))

    assert (s["n_normal_scored"], s["n_normal_hit"]) == (4, 3)
    assert s["specificity"] == pytest.approx(0.75)
    assert s["specificity_ci95"] == pytest.approx([0.3006, 0.9544], abs=5e-5)

    # rows 1, 2 and 3 (pneumonia only in its top 3) -- row 4 has none
    assert s["n_pneumonia_top3_hit"] == 3
    assert s["top3_sensitivity"] == pytest.approx(0.75)

    assert s["confusion"] == {
        "PNEUMONIA": {"pneumonia": 2, "normal": 1, "other": 1},
        "NORMAL": {"pneumonia": 1, "normal": 3, "other": 0},
    }

    assert s["mean_confidence_correct"] == pytest.approx((0.8 + 0.7 + 0.9 + 0.6 + 0.5) / 5)
    assert s["mean_confidence_incorrect"] == pytest.approx((0.5 + 0.9 + 0.8) / 3)

    # All three flag shares use the scored cases (8 here: 5 correct + 3
    # incorrect) as their denominator, so they decompose: (2 + 1) / 8. The
    # abstained case is excluded from every one of them.
    assert s["flagged_share_of_scored"] == pytest.approx(3 / 8)
    assert s["flagged_share_of_correct"] == pytest.approx(2 / 5)
    assert s["flagged_share_of_incorrect"] == pytest.approx(1 / 3)
    assert s["median_wall_seconds"] == pytest.approx(2.0)


def test_summarize_is_json_serializable():
    json.dumps(summarize(_hand_computed_results()))


def test_summarize_with_nothing_scored_does_not_divide_by_zero():
    s = summarize([_rec(1, "NORMAL", None, None, error="boom"), _rec(2, "PNEUMONIA", "Pneumonia", 0.1, abstained=True)])
    assert (s["n"], s["n_errored"], s["n_abstained"], s["n_scored"]) == (2, 1, 1, 0)
    assert s["accuracy"] is None and s["accuracy_ci95"] is None
    assert s["sensitivity"] is None and s["specificity"] is None
    assert s["mean_confidence_correct"] is None
    assert s["accuracy_all_cases"] == 0.0

    report = render_markdown(s, collect_meta([]))
    # the one abstained case still has a top-1, so the headline view exists;
    # only the committed-only view is empty
    assert "Headline: what the model's top-1 says" in report
    assert "Every answered case was abstained, so nothing was committed." in report


def test_summarize_reports_abstention_and_a_view_that_ignores_it():
    """The situation the two views exist for, seen in the first real run: most
    image-only cases abstain, so the committed-only view rests on a handful
    of cases while the model's own top-1 is judged on all of them."""
    results = [
        _rec(1, "NORMAL", "Normal chest", 0.2, abstained=True),
        _rec(2, "NORMAL", "Community-acquired pneumonia", 0.2, abstained=True),
        _rec(3, "PNEUMONIA", "Pneumonia", 0.3, abstained=True),
        _rec(4, "PNEUMONIA", "Congenital heart disease", 0.3, abstained=True),
        _rec(5, "NORMAL", "Normal chest", 0.8),
        _rec(6, "PNEUMONIA", None, None, error="boom"),
    ]

    s = summarize(results)

    assert (s["n"], s["n_completed"], s["n_abstained"], s["n_scored"], s["n_errored"]) == (6, 5, 4, 1, 1)
    assert s["abstention_rate"] == pytest.approx(4 / 5)
    assert s["abstention_rate_ci95"] == pytest.approx(wilson_interval(4, 5))
    # committed-only: the single non-abstained case
    assert s["committed"]["n"] == 1 and s["committed"]["n_correct"] == 1
    assert s["accuracy"] == 1.0
    # ignoring abstention: 5 answered cases; rows 1, 3, 5 are correct
    ia = s["ignoring_abstention"]
    assert ia["n"] == 5 and ia["n_correct"] == 3
    assert ia["accuracy"] == pytest.approx(3 / 5)
    assert (ia["n_normal"], ia["n_normal_hit"]) == (3, 2)
    assert (ia["n_pneumonia"], ia["n_pneumonia_hit"]) == (2, 1)
    # the pessimistic companion counts every abstained AND errored case as
    # wrong: only the one committed, correct case survives -> 1 of 6
    assert s["accuracy_all_cases"] == pytest.approx(1 / 6)

    report = render_markdown(s, collect_meta([]))
    assert "abstained (overall confidence below its threshold) on 4 of 5 answered cases" in report
    assert "Neither view alone is the honest picture" in report
    json.dumps(s)  # both views stay JSON-serializable


def test_summarize_rescores_from_raw_strings_so_categorizer_fixes_apply_retroactively():
    # the stored record carries the model's raw text, never our category for it
    record = _rec(1, "NORMAL", "No pneumonia", 0.7)
    assert "category" not in record
    assert summarize([record])["confusion"]["NORMAL"]["other"] == 1


# --- sampling ------------------------------------------------------------------

TOTAL_ROWS = 250


def _canned_label(idx):
    # Deliberately NOT one contiguous block per class, so nothing can pass
    # by hard-coding a class boundary.
    return 1 if idx % 3 == 0 else 0


@pytest.fixture
def canned_rows_api(monkeypatch):
    calls = []

    def fake_fetch_rows_page(offset, length):
        calls.append((offset, length))
        stop = min(offset + min(length, 100), TOTAL_ROWS)
        return {
            "num_rows_total": TOTAL_ROWS,
            "rows": [
                {
                    "row_idx": idx,
                    "row": {"image": {"src": f"https://cdn.invalid/{idx}?sig=abc"}, "label": _canned_label(idx)},
                }
                for idx in range(offset, stop)
            ],
        }

    monkeypatch.setattr(imaging_eval, "fetch_rows_page", fake_fetch_rows_page)
    return calls


def test_fetch_label_map_pages_through_the_whole_split_100_at_a_time(canned_rows_api):
    labels = imaging_eval.fetch_label_map()

    assert canned_rows_api == [(0, 100), (100, 100), (200, 100)]
    assert len(labels) == TOTAL_ROWS
    assert all(labels[idx] == ("PNEUMONIA" if _canned_label(idx) else "NORMAL") for idx in labels)


def test_fetch_label_map_rejects_an_unknown_label(monkeypatch):
    monkeypatch.setattr(
        imaging_eval,
        "fetch_rows_page",
        lambda offset, length: {"num_rows_total": 1, "rows": [{"row_idx": 0, "row": {"label": 7}}]},
    )
    with pytest.raises(ValueError, match="unexpected label"):
        imaging_eval.fetch_label_map()


def test_sample_rows_is_deterministic_balanced_and_uses_the_real_labels(canned_rows_api):
    labels = imaging_eval.fetch_label_map()

    first = sample_rows(labels, n_per_class=12, seed=0)
    assert first == sample_rows(labels, n_per_class=12, seed=0)
    assert first != sample_rows(labels, n_per_class=12, seed=1)

    assert len(first) == 24 and len({idx for idx, _ in first}) == 24
    assert all(label == labels[idx] for idx, label in first)
    assert sum(label == "NORMAL" for _, label in first) == 12
    # interleaved, so a run cut short is still balanced
    assert [label for _, label in first[:4]] == ["NORMAL", "PNEUMONIA", "NORMAL", "PNEUMONIA"]


def test_growing_the_sample_extends_it_so_resume_keeps_earlier_results(canned_rows_api):
    labels = imaging_eval.fetch_label_map()

    small = {idx for idx, _ in sample_rows(labels, n_per_class=5, seed=3)}
    large = {idx for idx, _ in sample_rows(labels, n_per_class=20, seed=3)}

    assert small < large


def test_sample_rows_refuses_more_than_the_class_has(canned_rows_api):
    labels = imaging_eval.fetch_label_map()
    n_pneumonia = sum(label == "PNEUMONIA" for label in labels.values())

    with pytest.raises(ValueError, match="PNEUMONIA"):
        sample_rows(labels, n_per_class=n_pneumonia + 1, seed=0)


# --- image -> DICOM --------------------------------------------------------------

def _synthetic_image(rows=12, columns=10):
    return (np.arange(rows * columns, dtype=np.uint32).reshape(rows, columns) * 2 % 256).astype(np.uint8)


def test_wrap_as_dicom_produces_a_readable_file_with_matching_pixels(tmp_path):
    pixels = _synthetic_image(rows=12, columns=10)

    path = wrap_as_dicom(pixels, tmp_path / "row-7.dcm", row_idx=7)
    dataset = pydicom.dcmread(path)

    assert (dataset.Rows, dataset.Columns) == (12, 10)
    assert dataset.pixel_array.shape == (12, 10)
    assert np.array_equal(dataset.pixel_array, pixels)
    assert dataset.PatientID == "EVAL-ROW-7" and dataset.PatientName == "EVAL-ROW-7"
    assert dataset.Modality == "MR"
    assert dataset.PhotometricInterpretation == "MONOCHROME2"
    assert (dataset.BitsAllocated, dataset.BitsStored, dataset.HighBit) == (8, 8, 7)
    assert dataset.file_meta.TransferSyntaxUID == pydicom.uid.ExplicitVRLittleEndian


@pytest.mark.parametrize(
    "bad",
    [np.zeros((4, 4), dtype=np.uint16), np.zeros((4, 4, 3), dtype=np.uint8), np.zeros(16, dtype=np.uint8)],
)
def test_wrap_as_dicom_rejects_anything_but_2d_uint8(tmp_path, bad):
    with pytest.raises(ValueError):
        wrap_as_dicom(bad, tmp_path / "bad.dcm", row_idx=0)


def test_load_grayscale_array_decodes_to_2d_uint8():
    import io

    Image = pytest.importorskip("PIL.Image")
    buffer = io.BytesIO()
    Image.fromarray(np.full((6, 9, 3), 200, dtype=np.uint8), mode="RGB").save(buffer, format="PNG")

    array = imaging_eval.load_grayscale_array(buffer.getvalue())

    assert array.shape == (6, 9) and array.dtype == np.uint8


def test_prepare_dicom_refetches_a_fresh_url_downloads_and_wraps(monkeypatch, tmp_path):
    requested = {}

    def fake_fetch_rows_page(offset, length):
        requested["page"] = (offset, length)
        return {
            "num_rows_total": TOTAL_ROWS,
            "rows": [{"row_idx": offset, "row": {"image": {"src": "https://cdn.invalid/fresh?sig=new"}, "label": 1}}],
        }

    def fake_download_image(url):
        requested["url"] = url
        return b"jpeg-bytes"

    monkeypatch.setattr(imaging_eval, "fetch_rows_page", fake_fetch_rows_page)
    monkeypatch.setattr(imaging_eval, "download_image", fake_download_image)
    monkeypatch.setattr(imaging_eval, "load_grayscale_array", lambda data: _synthetic_image())

    path = imaging_eval.prepare_dicom(42, "PNEUMONIA", tmp_path)

    assert requested == {"page": (42, 1), "url": "https://cdn.invalid/fresh?sig=new"}
    assert pydicom.dcmread(path).PatientID == "EVAL-ROW-42"


def test_prepare_dicom_refuses_a_row_whose_label_changed(monkeypatch, tmp_path):
    monkeypatch.setattr(
        imaging_eval,
        "fetch_rows_page",
        lambda offset, length: {"rows": [{"row_idx": offset, "row": {"image": {"src": "u"}, "label": 0}}]},
    )
    monkeypatch.setattr(imaging_eval, "download_image", lambda url: pytest.fail("must not download"))

    with pytest.raises(RuntimeError, match="now labelled NORMAL"):
        imaging_eval.prepare_dicom(3, "PNEUMONIA", tmp_path)


# --- run_case: end to end through the real six-agent graph -------------------------

def _fake_caller_factory(differential, confidence=0.7, calls=None):
    def caller(prompt, image_paths):
        if calls is not None:
            calls.append((prompt, list(image_paths)))
        return ModelDifferentialResponse(
            differential=[
                DifferentialCondition(condition=name, likelihood=likelihood, supporting_evidence=["from the image"])
                for name, likelihood in differential
            ],
            overall_confidence=confidence,
            reasoning_notes="test reasoning",
        )

    return caller


@pytest.fixture
def empty_rag_collection(tmp_path):
    # An imaging-only case never queries the index, but an injected one
    # keeps this test from opening ./data/literature/chroma.
    return build_literature_collection([], persist_directory=str(tmp_path / "chroma"))


@pytest.fixture
def dicom_path(tmp_path):
    return wrap_as_dicom(_synthetic_image(32, 24), tmp_path / "row-5.dcm", row_idx=5)


def test_run_case_populates_every_record_field_through_the_real_pipeline(
    monkeypatch, dicom_path, empty_rag_collection
):
    monkeypatch.setenv("OPENROUTER_MODEL", "fake-model")
    calls = []
    # deliberately out of likelihood order: top-1 must be the highest likelihood, as app.py ranks it
    caller = _fake_caller_factory(
        [("Normal chest X-ray", 0.3), ("Pneumonia", 0.6), ("Pleural effusion", 0.1)], confidence=0.7, calls=calls
    )
    graph = build_pipeline_graph(llm_caller=caller, rag_collection=empty_rag_collection)

    record = run_case(graph, dicom_path, row_idx=5, true_label="PNEUMONIA")

    assert record["error"] is None
    assert record["row_idx"] == 5 and record["true_label"] == "PNEUMONIA"
    assert record["top1_condition"] == "Pneumonia"
    assert record["top1_likelihood"] == pytest.approx(0.6)
    assert record["top3"] == ["Pneumonia", "Normal chest X-ray", "Pleural effusion"]
    assert record["overall_confidence"] == pytest.approx(0.7)
    assert record["abstained"] is False
    assert record["model_name"] == "fake-model"
    assert record["wall_seconds"] >= 0
    # 0.6 vs 0.3 is a wide enough margin that the explainability agent does not flag it
    assert record["disagreement_flagged"] is ((0.6 - 0.3) < DISAGREEMENT_MARGIN)
    assert set(record["stage_status"]) == set(STAGE_NAMES)
    assert record["stage_status"]["diagnostic_prediction"] == "ok"
    assert all(status in ("ok", "needs_review") for status in record["stage_status"].values())

    # the DICOM really reached the model call, alone -- no labs, history or literature
    (prompt, image_paths), = calls
    assert image_paths == [str(dicom_path)]
    assert "(none provided)" in prompt and "(none retrieved)" in prompt

    # and a record is one JSON line
    json.dumps(record)


def test_run_case_records_an_abstention_without_calling_it_an_error(dicom_path, empty_rag_collection):
    caller = _fake_caller_factory([("Pneumonia", 0.5), ("Normal chest X-ray", 0.4)], confidence=0.2)
    graph = build_pipeline_graph(llm_caller=caller, rag_collection=empty_rag_collection)

    record = run_case(graph, dicom_path, row_idx=5, true_label="NORMAL")

    assert record["error"] is None
    assert record["abstained"] is True
    assert record["disagreement_flagged"] is True
    assert record["top1_condition"] == "Pneumonia"


def test_run_case_turns_a_failed_stage_into_an_error(dicom_path, empty_rag_collection):
    def broken_caller(prompt, image_paths):
        raise TimeoutError("model timed out")

    graph = build_pipeline_graph(llm_caller=broken_caller, rag_collection=empty_rag_collection)

    record = run_case(graph, dicom_path, row_idx=5, true_label="NORMAL")

    assert record["error"].startswith("diagnostic_prediction failed")
    assert "model timed out" in record["error"]
    assert record["top1_condition"] is None
    assert record["stage_status"]["diagnostic_prediction"] == "failed"


def test_run_case_never_raises_when_the_graph_itself_blows_up(dicom_path):
    class ExplodingGraph:
        def invoke(self, state):
            raise RuntimeError("graph exploded")

    record = run_case(ExplodingGraph(), dicom_path, row_idx=9, true_label="NORMAL")

    assert record["error"] == "RuntimeError: graph exploded"
    assert record["row_idx"] == 9 and record["wall_seconds"] is not None


def test_run_case_flags_a_pipeline_that_ends_with_no_report_and_no_failed_stage(dicom_path):
    class SilentGraph:
        def invoke(self, state):
            return {**state, "final_explainable_report": None}

    record = run_case(SilentGraph(), dicom_path, row_idx=1, true_label="NORMAL")

    assert record["error"] == "pipeline finished without a final report"


def test_run_case_refuses_to_score_a_case_whose_image_cannot_reach_the_model(tmp_path, dicom_path):
    """The agent silently drops an unconvertible DICOM and calls the model
    text-only; scored like a normal case, that would look like a valid
    image-based result. A truncated file is the failure this guards."""
    truncated = tmp_path / "truncated.dcm"
    truncated.write_bytes(Path(dicom_path).read_bytes()[:-200])

    class MustNotRun:
        def invoke(self, state):
            raise AssertionError("graph must not run for an unconvertible image")

    record = run_case(MustNotRun(), truncated, row_idx=3, true_label="PNEUMONIA")

    assert record["error"].startswith("image could not be converted for the model")
    assert record["top1_condition"] is None


# --- the run loop, results file, resume ---------------------------------------------

class StubGraph:
    """Returns a canned final state: enough for the loop tests without
    paying for the real six agents on every case."""

    def __init__(self, condition="Pneumonia"):
        self.condition = condition
        self.seen_paths = []

    def invoke(self, state):
        self.seen_paths.append(state["raw_input_paths"][0])
        return {
            **state,
            "stage_status": {stage: {"status": "ok", "message": None} for stage in STAGE_NAMES},
            "diagnostic_prediction_result": {
                "differential": [{"condition": self.condition, "likelihood": 0.9, "supporting_evidence": []}],
                "overall_confidence": 0.9,
                "abstained": False,
                "model_name": "stub-model",
            },
            "final_explainable_report": {"disagreement_flagged": False},
        }


def _fake_prepare(fail_on=()):
    def prepare(row_idx, true_label, work_dir):
        if row_idx in fail_on:
            raise OSError("download failed")
        return wrap_as_dicom(_synthetic_image(), Path(work_dir) / f"row-{row_idx}.dcm", row_idx)

    return prepare


SAMPLE = [(10, "NORMAL"), (11, "PNEUMONIA"), (12, "NORMAL")]


def test_evaluate_row_folds_a_download_failure_into_the_record(tmp_path):
    record = evaluate_row(4, "NORMAL", graph=StubGraph(), work_dir=tmp_path, prepare=_fake_prepare(fail_on={4}))

    assert record["error"] == "image preparation failed: OSError: download failed"
    assert record["top1_condition"] is None


def test_evaluate_row_removes_the_dicom_after_the_case(tmp_path):
    graph = StubGraph()

    record = evaluate_row(4, "NORMAL", graph=graph, work_dir=tmp_path, prepare=_fake_prepare())

    assert record["error"] is None and record["top1_condition"] == "Pneumonia"
    assert len(graph.seen_paths) == 1
    assert not Path(graph.seen_paths[0]).exists()


def test_run_eval_survives_a_failing_case_and_appends_each_record(tmp_path):
    out = tmp_path / "nested" / "results.jsonl"
    pauses = []

    ran = run_eval(
        SAMPLE,
        out,
        graph=StubGraph(),
        sleep_seconds=3.0,
        tags={"seed": 0, "n_per_class": 2},
        prepare=_fake_prepare(fail_on={11}),
        sleep=pauses.append,
        log=lambda message: None,
    )

    assert ran == 3
    lines = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
    assert [r["row_idx"] for r in lines] == [10, 11, 12]
    assert [bool(r["error"]) for r in lines] == [False, True, False]  # one failure did not stop the rest
    assert all(r["seed"] == 0 and r["n_per_class"] == 2 and r["run_at"] for r in lines)
    assert pauses == [3.0, 3.0]  # between cases, not after the last one


def test_resume_skips_rows_already_in_the_file(tmp_path):
    out = tmp_path / "results.jsonl"
    run_eval(SAMPLE[:2], out, graph=StubGraph(), prepare=_fake_prepare(), sleep=lambda s: None, log=lambda m: None)
    assert completed_rows(out) == {10, 11}

    graph = StubGraph()
    ran = run_eval(
        SAMPLE, out, graph=graph, skip=completed_rows(out), prepare=_fake_prepare(), sleep=lambda s: None, log=lambda m: None
    )

    assert ran == 1
    assert len(graph.seen_paths) == 1 and graph.seen_paths[0].endswith("row-12.dcm")
    assert [r["row_idx"] for r in load_results(out)] == [10, 11, 12]


def test_retry_errors_reruns_only_failed_rows_and_the_new_result_wins(tmp_path):
    out = tmp_path / "results.jsonl"
    run_eval(
        SAMPLE, out, graph=StubGraph(), prepare=_fake_prepare(fail_on={11}), sleep=lambda s: None, log=lambda m: None
    )
    assert completed_rows(out) == {10, 11, 12}
    assert completed_rows(out, retry_errors=True) == {10, 12}

    ran = run_eval(
        SAMPLE,
        out,
        graph=StubGraph(),
        skip=completed_rows(out, retry_errors=True),
        prepare=_fake_prepare(),
        sleep=lambda s: None,
        log=lambda m: None,
    )

    assert ran == 1
    results = {r["row_idx"]: r for r in load_results(out)}
    assert len(results) == 3
    assert results[11]["error"] is None and results[11]["top1_condition"] == "Pneumonia"
    assert len(out.read_text(encoding="utf-8").splitlines()) == 4  # the failed attempt is still on disk


def test_completed_rows_of_a_missing_file_is_empty(tmp_path):
    assert completed_rows(tmp_path / "nope.jsonl") == set()


def test_run_eval_survives_progress_output_that_cannot_be_encoded(tmp_path):
    """Found by review: with stdout redirected on Windows (cp1252), a model
    condition containing e.g. an arrow made print() raise AFTER the record
    was saved, and the uncaught error aborted the whole unattended run."""
    out = tmp_path / "results.jsonl"
    messages = []

    def cp1252_like(message):
        if "→" in message:
            raise UnicodeEncodeError("charmap", message, 0, 1, "character maps to <undefined>")
        messages.append(message)

    ran = run_eval(
        SAMPLE[:2],
        out,
        graph=StubGraph(condition="Pneumonia → viral"),
        prepare=_fake_prepare(),
        sleep=lambda s: None,
        log=cp1252_like,
    )

    assert ran == 2  # the second case still ran
    assert [r["row_idx"] for r in load_results(out)] == [10, 11]
    assert len(messages) == 2 and all("not printable" in m for m in messages)


def test_a_write_cut_off_inside_a_multibyte_character_is_skipped_not_fatal(tmp_path, caplog):
    """Records are stored with ensure_ascii=False, so an interrupted write
    can end mid-character. That used to raise UnicodeDecodeError out of
    load_results, and so out of both `--resume` and `report`."""
    out = tmp_path / "results.jsonl"
    imaging_eval.append_result(out, _rec(1, "NORMAL", "Normal", 0.9))
    with out.open("ab") as handle:
        handle.write(b'{"row_idx": 2, "top1_condition": "Pneumonia \xe2')  # first byte of an em dash, then cut

    with caplog.at_level(logging.WARNING):
        results = load_results(out)

    assert [r["row_idx"] for r in results] == [1]
    assert "skipping unparseable line" in caplog.text
    imaging_eval.append_result(out, _rec(3, "PNEUMONIA", "Pneumonia", 0.8))  # next append is not glued on
    assert [r["row_idx"] for r in load_results(out)] == [1, 3]


def test_provider_account_ids_are_scrubbed_before_a_record_reaches_the_results_file(tmp_path):
    """OpenRouter error bodies carry the caller's account id. The results
    file is committed, so it must never be written there."""
    out = tmp_path / "results.jsonl"
    record = _rec(1, "NORMAL", None, None, error="model call failed: {'error': {'code': 400}, 'user_id': 'user_3JDzXsmC3bJ'}")

    imaging_eval.append_result(out, record)

    written = out.read_text(encoding="utf-8")
    assert "user_3JDzXsmC3bJ" not in written
    assert "'user_id': '<redacted>'" in written
    assert record["error"].count("user_3JDzXsmC3bJ") == 1  # the caller's record is not mutated


def test_resume_refuses_a_different_seed_instead_of_pooling_two_samples(tmp_path):
    out = tmp_path / "results.jsonl"
    run_eval(
        SAMPLE[:2], out, graph=StubGraph(), tags={"seed": 0, "n_per_class": 1},
        prepare=_fake_prepare(), sleep=lambda s: None, log=lambda m: None,
    )

    assert imaging_eval.resume_seed_conflict(out, seed=0) is None
    message = imaging_eval.resume_seed_conflict(out, seed=1)
    assert message and "[0]" in message and "--seed 1" in message
    assert imaging_eval.resume_seed_conflict(tmp_path / "missing.jsonl", seed=1) is None


@pytest.mark.parametrize("bad", [0, -1])
def test_sample_rows_rejects_a_non_positive_class_size(bad):
    """A negative n used to slice pool[:n] and return nearly the whole class."""
    with pytest.raises(ValueError, match="at least 1"):
        sample_rows({1: "NORMAL", 2: "PNEUMONIA"}, bad, seed=0)


def test_a_write_cut_off_mid_line_does_not_corrupt_the_next_record(tmp_path, caplog):
    out = tmp_path / "results.jsonl"
    imaging_eval.append_result(out, _rec(1, "NORMAL", "Normal", 0.9))
    with out.open("a", encoding="utf-8") as handle:
        handle.write('{"row_idx": 2, "true_la')  # simulated interruption: no closing brace, no newline

    imaging_eval.append_result(out, _rec(3, "NORMAL", "Normal", 0.9))

    with caplog.at_level(logging.WARNING):
        results = load_results(out)
    assert [r["row_idx"] for r in results] == [1, 3]
    assert "skipping unparseable line 2" in caplog.text


# --- render_markdown -----------------------------------------------------------------

def test_render_markdown_reports_the_numbers_and_the_caveats():
    results = [{**r, "seed": 0, "n_per_class": 5, "run_at": "2026-01-01T00:00:00+00:00"} for r in _hand_computed_results()]

    text = render_markdown(summarize(results), collect_meta(results))

    assert "| Accuracy | 62.5% |" in text
    assert "5 / 8" in text
    assert "30.1% to 95.4%" in text  # the 3/4 specificity interval
    assert "sample seed 0" in text and "`fake-model`" in text
    assert "10" in text and "Abstained" in text and "Errored" in text
    for caveat in ("Single dataset", "pediatric", "router", "Not clinical validation", "Wilson"):
        assert caveat in text
    assert text.isascii()  # safe to print on a Windows console


def test_collect_meta_reads_provenance_from_the_records():
    results = [
        _rec(1, "NORMAL", "Normal", 0.9, seed=0, n_per_class=12, run_at="2026-02-02T00:00:00+00:00"),
        _rec(2, "NORMAL", "Normal", 0.9, seed=0, n_per_class=12, run_at="2026-01-01T00:00:00+00:00"),
    ]

    assert collect_meta(results) == {
        "seeds": [0],
        "n_per_class": [12],
        "model_names": ["fake-model"],
        "first_run_at": "2026-01-01T00:00:00+00:00",
        "last_run_at": "2026-02-02T00:00:00+00:00",
    }


# --- CLI (scripts/eval_imaging.py), without any network ----------------------------------

@pytest.fixture(scope="module")
def cli():
    spec = importlib.util.spec_from_file_location("eval_imaging_cli", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_args(out, **overrides):
    args = dict(n_per_class=2, seed=0, out=str(out), resume=False, retry_errors=False, sleep=0.0, dry_run=False)
    args.update(overrides)
    return Namespace(**args)


def test_cli_run_refuses_to_start_without_an_api_key(cli, monkeypatch, tmp_path, capsys):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setattr(imaging_eval, "fetch_rows_page", lambda *a: pytest.fail("must not touch the network"))

    assert cli.cmd_run(_run_args(tmp_path / "out.jsonl")) == 2

    assert "OPENROUTER_API_KEY is not set" in capsys.readouterr().err


def test_cli_run_refuses_to_append_to_an_existing_file_without_resume(cli, monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("OPENROUTER_API_KEY", "not-a-real-key")
    monkeypatch.setattr(imaging_eval, "fetch_rows_page", lambda *a: pytest.fail("must not touch the network"))
    out = tmp_path / "out.jsonl"
    imaging_eval.append_result(out, _rec(1, "NORMAL", "Normal", 0.9))

    assert cli.cmd_run(_run_args(out)) == 2

    assert "--resume" in capsys.readouterr().err


def test_cli_dry_run_prints_the_sample_without_a_key(cli, monkeypatch, tmp_path, capsys, canned_rows_api):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)

    assert cli.cmd_run(_run_args(tmp_path / "out.jsonl", dry_run=True)) == 0

    output = capsys.readouterr().out
    assert output.count("row ") == 4 and "NORMAL" in output and "PNEUMONIA" in output


def test_cli_report_writes_markdown_from_a_results_file(cli, tmp_path, capsys):
    source = tmp_path / "results.jsonl"
    for record in _hand_computed_results():
        imaging_eval.append_result(source, record)
    target = tmp_path / "docs" / "report.md"

    assert cli.cmd_report(Namespace(input=str(source), md=str(target))) == 0

    assert "| Accuracy | 62.5% |" in target.read_text(encoding="utf-8")
    assert "8 scored" in capsys.readouterr().out
