"""Explainability Agent.

Sixth and last in pipeline order. Assembles `final_explainable_report`:
a citation-grounded narrative built from the Diagnostic Prediction
Agent's self-reported reasoning plus the RAG agent's retrieved
literature, and a genuinely separate SHAP demonstration on a real
trained tabular model -- never SHAP applied to the closed multimodal LLM
call itself, which the architecture critique flagged as not well-defined
(no stable feature space to perturb, no gradient/weight access, and
50-200x the API cost per case even if it were).

Two independent, honestly-labeled explanation channels, not one:

  1. Citation-grounded narrative. The Diagnostic Prediction Agent's
     `supporting_evidence` bullets already reference literature by
     bracketed source_id (see its `SYSTEM_INSTRUCTION`); this agent
     resolves those references against `rag_literature_context` into
     real `Citation` objects (title, url, passage) and assembles a
     narrative that traces each claim back to a specific source --
     explicitly labeled as the model's self-report, not a mechanistic
     explanation. A closed API has no internals to expose; this project
     doesn't pretend otherwise.

  2. SHAP demonstration. A RandomForestClassifier trained, in-process,
     on scikit-learn's built-in `load_diabetes` dataset (no network
     fetch -- consistent with this project's preference for offline-
     testable dependencies over another external call), with the
     continuous progression score binarized at the median into
     "elevated risk" / "not elevated." SHAP's TreeExplainer runs against
     a held-out sample from that same public dataset.

     This is deliberately NOT applied to the current patient's own lab
     values, and the report says so explicitly. `load_diabetes`'s ten
     features are mean-centered and unit-variance scaled by scikit-learn
     with no exposed inverse transform -- silently substituting this
     patient's real mmol/L lab values into that feature space would
     produce SHAP numbers that look precise but mean nothing, which is
     exactly the "technically incorrect but authoritative-looking"
     failure mode this whole project exists to avoid. Training on this
     project's own lab panel instead of borrowing a public dataset's
     feature space is a V2 item, not attempted here.

Disagreement flagging (`disagreement_flagged`) is a real, self-contained
signal, not a placeholder: it's True when the model's own top two
differential hypotheses sit within `DISAGREEMENT_MARGIN` of each other --
the model itself not really distinguishing between them -- or when the
Diagnostic Prediction Agent already abstained. It is deliberately NOT a
comparison between the SHAP demo and the patient's differential: those
run over incompatible feature spaces on unrelated data, and manufacturing
a cross-check between them would itself be a technically-incorrect
comparison dressed up as insight.

An optional third channel, off unless configured: `decision_layer.py` asks a small
judge model whether each supporting-evidence claim is supported by the case text
and the retrieved passages, and adds an `evidence_checks` section and, on a
contradiction or an unconfirmed top condition, a flag. It is advisory: it never
alters the differential and a failure in it never sinks the report.

Clinician confirmation (`clinician_confirmed`) always starts False here.
This agent produces a report for review, not a released result --
setting it True is a UI/human action (Phase 8), never something an agent
decides for itself, per the clinical-safety critique's human-in-the-loop
requirement.
"""

from __future__ import annotations

import re
from typing import Any

import numpy as np
import shap
from sklearn.datasets import load_diabetes
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split

from .. import decision_layer
from ..audit import audit_entry
from ..state import Citation, ExplainableReport, MedicalPipelineState, update_stage_status

STAGE_NAME = "explainability"

# How close the top two differential likelihoods need to be to count as
# the model itself being unable to distinguish between them.
DISAGREEMENT_MARGIN = 0.15

_CITATION_REF_PATTERN = re.compile(r"\[([^\[\]]+)\]")


def _resolve_cited_sources(
    differential: list[dict[str, Any]], rag_literature_context: list[Citation]
) -> list[Citation]:
    """Find every bracketed [source_id] referenced in the model's
    supporting_evidence bullets and resolve it against the actual
    retrieved literature, in first-referenced order -- so the
    narrative's citations are real Citation objects, not just text a
    reader has to take on faith."""
    by_id = {citation["source_id"]: citation for citation in rag_literature_context}
    resolved: list[Citation] = []
    seen: set[str] = set()
    for condition in differential:
        for bullet in condition.get("supporting_evidence", []):
            for source_id in _CITATION_REF_PATTERN.findall(bullet):
                if source_id in by_id and source_id not in seen:
                    seen.add(source_id)
                    resolved.append(by_id[source_id])
    return resolved


def _build_narrative(prediction: dict[str, Any], resolved_citations: list[Citation]) -> str:
    lines: list[str]
    if prediction.get("abstained"):
        lines = [
            f"Insufficient evidence for a reliable differential "
            f"(model confidence {prediction.get('overall_confidence', 0.0):.2f}, "
            "below the reporting threshold)."
        ]
    else:
        lines = ["Ranked differential (model's self-reported reasoning, not a mechanistic explanation):"]
        for condition in prediction.get("differential", []):
            evidence = "; ".join(condition.get("supporting_evidence", []))
            lines.append(f"- {condition['condition']} (likelihood {condition['likelihood']:.2f}): {evidence}")

    if resolved_citations:
        lines.append("")
        lines.append("Cited literature:")
        for citation in resolved_citations:
            lines.append(f"- [{citation['source_id']}] {citation['title']} ({citation['url']})")

    notes = prediction.get("reasoning_notes")
    if notes:
        lines.append("")
        lines.append(f"Model's self-reported reasoning: {notes}")

    return "\n".join(lines)


def _differential_disagreement(differential: list[dict[str, Any]]) -> bool:
    """True when the model's own top two hypotheses are close enough in
    likelihood that it isn't really distinguishing between them."""
    if len(differential) < 2:
        return False
    likelihoods = sorted((condition["likelihood"] for condition in differential), reverse=True)
    return (likelihoods[0] - likelihoods[1]) < DISAGREEMENT_MARGIN


_shap_demo_cache: dict[str, Any] | None = None


def _build_shap_demo() -> dict[str, Any]:
    """Train the demo model and compute SHAP values for one held-out
    sample. Cached at module level: training takes milliseconds on this
    dataset, but there's no reason to repeat it every pipeline run."""
    global _shap_demo_cache
    if _shap_demo_cache is not None:
        return _shap_demo_cache

    data = load_diabetes()
    target = (data.target > np.median(data.target)).astype(int)
    x_train, x_test, y_train, _ = train_test_split(data.data, target, test_size=0.2, random_state=0)

    model = RandomForestClassifier(n_estimators=100, random_state=0)
    model.fit(x_train, y_train)

    explainer = shap.TreeExplainer(model)
    shap_values = explainer.shap_values(x_test[:1])

    # shap_values shape varies by shap/sklearn version for binary
    # classifiers: a list of per-class arrays, or one (n, features, 2)
    # array. Normalize to the 1D per-feature values for the positive
    # ("elevated risk") class.
    if isinstance(shap_values, list):
        values = shap_values[1][0]
    elif shap_values.ndim == 3:
        values = shap_values[0, :, 1]
    else:
        values = shap_values[0]

    top_features = sorted(zip(data.feature_names, values), key=lambda pair: abs(pair[1]), reverse=True)[:3]

    _shap_demo_cache = {
        "dataset": "sklearn.datasets.load_diabetes (public, offline, not this patient's data)",
        "model": "RandomForestClassifier (100 trees), elevated-progression-risk binarized at the median",
        "top_features": [
            {"feature": name, "shap_value": round(float(value), 4)} for name, value in top_features
        ],
    }
    return _shap_demo_cache


def explainability_agent(
    state: MedicalPipelineState, decision_backend: decision_layer.DecisionBackend | None = None
) -> dict[str, Any]:
    """The LangGraph node. Reads `diagnostic_prediction_result` and
    `rag_literature_context`, writes `final_explainable_report`.

    `decision_backend` is the optional evidence-check judge (decision_layer.py);
    None falls back to whatever the environment configures, which is nothing by
    default. It can add a flag and an `evidence_checks` section to the report; it
    never changes the differential, and a failure in it never sinks the report."""
    prediction = state.get("diagnostic_prediction_result")
    if not prediction:
        return {
            "stage_status": update_stage_status(
                state, STAGE_NAME, {"status": "failed", "message": "no diagnostic prediction to explain"}
            ),
            "audit_log": [audit_entry(STAGE_NAME, "failed: no diagnostic prediction to explain")],
        }

    rag_context = state.get("rag_literature_context") or []
    differential = prediction.get("differential", [])
    resolved_citations = _resolve_cited_sources(differential, rag_context)
    narrative = _build_narrative(prediction, resolved_citations)
    disagreement = _differential_disagreement(differential) or bool(prediction.get("abstained"))

    try:
        demo = _build_shap_demo()
        feature_summary = ", ".join(f"{f['feature']} ({f['shap_value']:+.3f})" for f in demo["top_features"])
        shap_reference = f"{demo['model']} on {demo['dataset']}; top features: {feature_summary}"
    except Exception:
        # A failed demo shouldn't sink the report -- the narrative and
        # citations are the load-bearing part of this agent's output.
        shap_reference = None

    backend = decision_backend if decision_backend is not None else decision_layer.backend_from_env()
    evidence: dict[str, Any] | None = None
    if backend is not None and differential:
        try:
            evidence = decision_layer.run_evidence_check(dict(state), prediction, backend)
        except Exception as exc:  # noqa: BLE001 -- run_evidence_check never raises; belt and braces
            evidence = {
                "checker": getattr(backend, "name", "decision model"),
                "checked": [], "counts": decision_layer._tally([]), "flagged": False, "flag_reasons": [],
                "note": decision_layer.ADVISORY_NOTE, "error": f"{type(exc).__name__}: {exc}",
            }
    evidence_flagged = bool(evidence and evidence["flagged"])

    report: ExplainableReport = {
        "narrative": narrative,
        "citations": resolved_citations,
        "confidence": prediction.get("overall_confidence", 0.0),
        "shap_reference": shap_reference,
        "disagreement_flagged": disagreement,
        "clinician_confirmed": False,
    }
    if evidence is not None:
        report["evidence_checks"] = evidence

    messages = []
    if disagreement:
        messages.append("differential shows low separation between top hypotheses, or upstream abstention")
    if evidence_flagged:
        messages.append("evidence check: " + "; ".join(evidence["flag_reasons"]))
    status = {
        "status": "needs_review" if (disagreement or evidence_flagged) else "ok",
        "message": " | ".join(messages) if messages else None,
    }
    summary = (
        f"assembled explainable report; {len(resolved_citations)} citation(s) resolved"
        + ("; disagreement flagged" if disagreement else "")
        + (f"; {decision_layer.summarize(evidence)}" if evidence is not None else "")
    )

    return {
        "final_explainable_report": report,
        "stage_status": update_stage_status(state, STAGE_NAME, status),
        "audit_log": [audit_entry(STAGE_NAME, summary)],
    }
