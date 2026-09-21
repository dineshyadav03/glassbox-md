"""Paired comparison of two evaluation arms: the arithmetic, the pairing
rules, and that the report says what it should and no more."""

import math

import pytest

from glassbox_md import imaging_compare as ic


def rec(row, label, top1, conf=0.9, *, abstained=False, error=None, wall=50.0, model="m", attempts=1, invalid=0):
    return {
        "row_idx": row,
        "true_label": label,
        "top1_condition": top1,
        "overall_confidence": conf,
        "abstained": abstained,
        "error": error,
        "wall_seconds": wall,
        "model_name": model,
        "model_attempts": attempts,
        "invalid_responses": invalid,
    }


N, P = "NORMAL", "PNEUMONIA"


def test_mcnemar_is_one_with_no_discordant_rows():
    assert ic.mcnemar_exact(0, 0) == 1.0


def test_mcnemar_known_values():
    assert ic.mcnemar_exact(5, 5) == pytest.approx(1.0)
    # 0 vs 10: two-sided exact p = 2 * (1/1024)
    assert ic.mcnemar_exact(0, 10) == pytest.approx(2 / 1024)
    assert ic.mcnemar_exact(10, 0) == pytest.approx(2 / 1024)
    assert ic.mcnemar_exact(1, 2) == pytest.approx(1.0)


def test_mcnemar_is_symmetric_and_never_above_one():
    for a in range(8):
        for b in range(8):
            assert ic.mcnemar_exact(a, b) == ic.mcnemar_exact(b, a)
            assert 0 < ic.mcnemar_exact(a, b) <= 1.0


def test_calibration_perfectly_calibrated_certain_answers():
    rows = [rec(1, N, "Normal chest X-ray", 1.0), rec(2, P, "Pneumonia", 1.0)]
    c = ic.calibration(rows)
    assert c["brier"] == 0.0 and c["ece"] == 0.0 and c["n_high_confidence_wrong"] == 0


def test_calibration_counts_confident_wrong_answers():
    rows = [rec(1, N, "Pneumonia", 0.95), rec(2, N, "Normal chest X-ray", 0.95), rec(3, P, "Normal chest X-ray", 0.3)]
    c = ic.calibration(rows)
    assert c["n_high_confidence"] == 2 and c["n_high_confidence_wrong"] == 1
    assert c["brier"] == pytest.approx(((0.95 - 0) ** 2 + (0.95 - 1) ** 2 + (0.3 - 0) ** 2) / 3)


def test_calibration_ignores_errored_and_confidence_less_records():
    rows = [rec(1, N, None, None, error="x"), rec(2, N, "Normal chest X-ray", None)]
    assert ic.calibration(rows) == {"n": 0}


def test_ece_is_a_weighted_gap_between_confidence_and_accuracy_per_bin():
    # two answers in the top bin, both confidence 1.0, one right: gap 0.5
    rows = [rec(1, N, "Normal chest X-ray", 1.0), rec(2, N, "Pneumonia", 1.0)]
    assert ic.calibration(rows)["ece"] == pytest.approx(0.5)


def test_json_validity_separates_first_try_from_eventually_answered():
    rows = [
        rec(1, N, "Normal chest X-ray", attempts=1, invalid=0),
        rec(2, N, "Normal chest X-ray", attempts=3, invalid=2),
        rec(3, N, None, None, error="model call failed", attempts=3, invalid=3),
    ]
    j = ic.json_validity(rows)
    assert j["n_tracked"] == 3 and j["n_clean_first_time"] == 1
    assert j["n_answered"] == 2
    assert j["invalid_answers_total"] == 5


def test_json_validity_leaves_untracked_records_out_of_the_first_try_figure():
    old = rec(1, N, "Normal chest X-ray")
    old["model_attempts"] = None
    old["invalid_responses"] = None
    j = ic.json_validity([old])
    assert j["n_tracked"] == 0 and j["clean_rate"] is None and j["n_answered"] == 1


def test_pairing_counts_discordant_rows_and_excludes_errors():
    a = [rec(1, N, "Normal chest X-ray"), rec(2, P, "Pneumonia"), rec(3, P, "Normal chest X-ray"), rec(4, N, None, error="x")]
    b = [rec(1, N, "Normal chest X-ray"), rec(2, P, "Normal chest X-ray"), rec(3, P, "Pneumonia"), rec(4, N, "Normal chest X-ray")]
    p = ic.pair(a, b)
    assert p["n_shared_rows"] == 4 and p["n_paired"] == 3 and p["n_unpaired_errors"] == 1
    assert (p["both_correct"], p["only_a_correct"], p["only_b_correct"], p["neither_correct"]) == (1, 1, 1, 0)
    assert p["mcnemar_p"] == 1.0


def test_pairing_only_uses_rows_present_in_both_arms():
    a = [rec(1, N, "Normal chest X-ray"), rec(2, N, "Normal chest X-ray")]
    b = [rec(2, N, "Normal chest X-ray"), rec(9, N, "Normal chest X-ray")]
    assert ic.pair(a, b)["n_shared_rows"] == 1


def test_a_wrong_wording_counts_as_wrong_not_as_a_missing_row():
    assert ic.is_correct(rec(1, N, "Pleural effusion")) is False
    assert ic.is_correct(rec(1, P, "Lobar pneumonia")) is True


def test_repeat_stability_needs_at_least_two_passes():
    assert ic.repeat_stability([[rec(1, N, "Normal chest X-ray")]]) is None


def test_repeat_stability_counts_category_flips_and_served_model_changes():
    p1 = [rec(1, N, "Normal chest X-ray", model="x"), rec(2, P, "Pneumonia", model="x"), rec(3, P, "Pneumonia")]
    p2 = [rec(1, N, "Normal chest X-ray", model="y"), rec(2, P, "Normal chest X-ray", model="x"), rec(3, P, None, error="q")]
    s = ic.repeat_stability([p1, p2])
    assert s["n_rows_in_all_passes"] == 2  # row 3 errored in pass 2
    assert s["n_same_top1_category"] == 1
    assert s["n_correctness_changed"] == 1
    assert s["n_served_model_changed"] == 1


def test_latency_quartiles_and_empty_case():
    assert ic.latency([rec(1, N, None, error="x")]) == {"n": 0}
    lat = ic.latency([rec(i, N, "Normal chest X-ray", wall=float(i)) for i in range(1, 9)])
    assert lat["median"] == 4.5 and lat["max"] == 8.0 and lat["q1"] < lat["median"] < lat["q3"]


def test_compare_uses_the_first_pass_for_the_headline_only():
    a1 = [rec(1, N, "Normal chest X-ray"), rec(2, P, "Pneumonia")]
    a2 = [rec(1, N, "Pneumonia"), rec(2, P, "Pneumonia")]
    b = [rec(1, N, "Normal chest X-ray"), rec(2, P, "Pneumonia")]
    r = ic.compare([a1, a2], [b])
    assert r["a"]["n"] == 2 and r["pairing"]["n_paired"] == 2
    assert r["stability_a"]["n_passes"] == 2 and r["stability_b"] is None


def test_report_renders_every_section_and_labels():
    a = [rec(1, N, "Normal chest X-ray"), rec(2, P, "Pneumonia", abstained=True, conf=0.2)]
    b = [rec(1, N, "Pneumonia"), rec(2, P, "Pneumonia")]
    text = ic.render_markdown(ic.compare([a], [b]), "Hosted", "Local", ["one note"])
    for needle in ("Hosted vs Local", "McNemar", "Calibration", "JSON schema validity", "Abstention rate", "one note", "## Caveats"):
        assert needle in text
    assert "nan" not in text.lower()


def test_report_handles_an_arm_with_no_answers_without_crashing():
    a = [rec(1, N, None, None, error="quota")]
    b = [rec(1, N, "Normal chest X-ray")]
    text = ic.render_markdown(ic.compare([a], [b]), "A", "B")
    assert "n/a" in text and "nan" not in text.lower()
    assert not math.isnan(ic.compare([a], [b])["pairing"]["mcnemar_p"])
