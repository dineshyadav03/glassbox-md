"""Markdown for the final report, as a pure function (no Chainlit import) so
it is unit-testable and so a freshly-run case and a reopened past case
(case_store.py) render through exactly the same code.

The wording here is deliberate. What the pipeline can honestly claim is
narrower than "explainable": the reasoning shown is the model's own account
of itself, its confidence is self-reported and was not calibrated (the
imaging evaluation found it no higher on correct answers than on wrong
ones), the literature is retrieved rather than verified to support any
claim, and the SHAP figures come from a public dataset, not from this case.
Each label below says so at the point where it could be misread. Internal
field names (`final_explainable_report`, `shap_reference`, ...) are left
alone -- they are persisted in saved cases.
"""

from __future__ import annotations

from typing import Any

from .agents.diagnostic_prediction import CONFIDENCE_THRESHOLD, DEFAULT_MODEL_NAME

# The upper band is a UI-only judgment call (nothing in the backend treats
# 0.7 as meaningful) -- the lower band is not: it's the exact threshold
# diagnostic_prediction.py uses to decide abstention, imported rather than
# duplicated as a literal so this badge can never silently drift out of
# sync with what "low confidence" actually triggers.
CONFIDENCE_HIGH_BAND = 0.7


def confidence_badge(confidence: float) -> str:
    if confidence < CONFIDENCE_THRESHOLD:
        return "🔴"
    if confidence < CONFIDENCE_HIGH_BAND:
        return "🟡"
    return "🟢"


def _answered_by(prediction: dict[str, Any]) -> str | None:
    name = prediction.get("model_name")
    if not name:
        return None
    if name == DEFAULT_MODEL_NAME:
        return f"`{name}` (a router alias -- the model that actually answered was not recorded)"
    return f"`{name}`"


def build_report_markdown(report: dict[str, Any], prediction: dict[str, Any]) -> str:
    lines: list[str] = []

    if prediction.get("abstained") and not prediction.get("differential"):
        # Nothing to tabulate -- the narrative is already just one clean
        # sentence for this case (see app.py's module docstring).
        lines.append(report["narrative"])
    else:
        lines.append("### Ranked differential")
        lines.append("")
        lines.append("| | Condition | Likelihood | Supporting evidence |")
        lines.append("|---|---|---|---|")
        differential = sorted(
            prediction.get("differential", []), key=lambda c: c["likelihood"], reverse=True
        )
        for condition in differential:
            evidence = "; ".join(condition.get("supporting_evidence", [])) or "(none given)"
            lines.append(
                f"| {confidence_badge(condition['likelihood'])} "
                f"| {condition['condition']} "
                f"| {condition['likelihood']:.2f} "
                f"| {evidence} |"
            )
        reasoning_notes = prediction.get("reasoning_notes")
        if reasoning_notes:
            lines.append("")
            lines.append(f"**Model's self-reported reasoning:** {reasoning_notes}")
            lines.append("")
            lines.append(
                "*This is the model describing its own reasoning. It is not a verified explanation "
                "of how it reached this answer.*"
            )

    lines.append("")
    lines.append(
        "**Overall confidence (self-reported by the model, not calibrated):** "
        f"{confidence_badge(report['confidence'])} {report['confidence']:.2f}"
    )

    answered_by = _answered_by(prediction)
    if answered_by:
        lines.append("")
        lines.append(f"**Answered by:** {answered_by}")

    if report["citations"]:
        lines.append("")
        lines.append("**Retrieved literature** (real PubMed records; nothing here verifies that they support the answer):")
        for citation in report["citations"]:
            lines.append(f"- [{citation['title']}]({citation['url']})")

    if report["disagreement_flagged"]:
        lines.append("")
        lines.append(
            "⚠️ **Flagged for review** -- low confidence and/or a close "
            "differential. Treat as inconclusive, not a settled result."
        )

    if report["shap_reference"]:
        lines.append("")
        lines.append("---")
        lines.append(
            "**Not about this case -- SHAP demo:** this ran on a public dataset (scikit-learn's diabetes "
            "data) to show the technique. It says nothing about why the model answered this patient the "
            f"way it did. {report['shap_reference']}"
        )

    return "\n".join(lines)
