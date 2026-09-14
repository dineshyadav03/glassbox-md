"""Chainlit UI for Glassbox MD.

Each of the six pipeline agents renders as its own step in the trace,
streamed live as the graph runs (`graph.stream()`, not `.invoke()`) --
this is the reason Chainlit was picked over Streamlit/Gradio in the
first place (see the project brief and README): the point of this
project is showing HOW a differential was reached, not just displaying
a final chat bubble.

Disclaimer: sent as the first message of every new chat (`on_chat_start`
below) AND pinned as a persistent banner via custom CSS
(`public/banner.css`, wired in through `.chainlit/config.toml`'s
`custom_css`) -- so it's visible before a user does anything and stays
visible for the rest of the session, not just a message that scrolls
out of view once the trace fills the screen.

Clinician confirmation: the final report always ships with a
"Confirm reviewed" action and nothing else. No agent sets
`clinician_confirmed` itself (see `explainability.py`) -- only a person
clicking this button does.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent / "src"))

import chainlit as cl
from dotenv import load_dotenv

from glassbox_md.disclaimer import INTENDED_USE_DISCLAIMER
from glassbox_md.pipeline import build_pipeline_graph
from glassbox_md.state import new_stage_status

load_dotenv()

STAGE_TITLES = {
    "document_parser": "1 · Document Parser",
    "privacy_protection": "2 · Privacy Protection",
    "data_preparation": "3 · Data Preparation",
    "medical_knowledge_rag": "4 · Medical Knowledge RAG",
    "diagnostic_prediction": "5 · Diagnostic Prediction",
    "explainability": "6 · Explainability",
}
STATUS_ICONS = {"ok": "✅", "needs_review": "⚠️", "failed": "❌"}

# Built once at import time -- both llm_caller and rag_collection default
# to None, which resolves to the real OpenRouter call and the real
# persisted ChromaDB index (see pipeline.py). Tests inject fakes for
# both instead; this module never does.
_pipeline = build_pipeline_graph()


def _new_state(paths: list[str]) -> dict[str, Any]:
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


@cl.on_chat_start
async def start() -> None:
    await cl.Message(content=INTENDED_USE_DISCLAIMER, author="System").send()

    files = await cl.AskFileMessage(
        content=(
            "Upload one or more patient documents to run through the pipeline: "
            "a lab-report/history PDF and/or a DICOM imaging file.\n\n"
            "**Synthetic or de-identified test data only -- never real patient records.**"
        ),
        accept={"application/pdf": [".pdf"], "application/dicom": [".dcm"]},
        max_files=5,
        max_size_mb=25,
        timeout=300,
    ).send()

    if not files:
        await cl.Message(content="No files received -- refresh the page to try again.").send()
        return

    await run_pipeline([f.path for f in files if f.path])


async def run_pipeline(paths: list[str]) -> None:
    state = _new_state(paths)

    try:
        for chunk in _pipeline.stream(state):
            for stage_name, update in chunk.items():
                state = {**state, **update}
                await _render_stage_step(stage_name, update)
    except Exception as exc:  # a bug in the pipeline itself, not a per-agent failure -- those are already handled
        await cl.Message(content=f"Pipeline crashed unexpectedly: {exc}").send()
        return

    await _render_final_report(state)


async def _render_stage_step(stage_name: str, update: dict[str, Any]) -> None:
    title = STAGE_TITLES.get(stage_name, stage_name)
    status = (update.get("stage_status") or {}).get(stage_name, {})
    icon = STATUS_ICONS.get(status.get("status"), "•")

    audit_entries = update.get("audit_log") or []
    summary = audit_entries[0]["summary"] if audit_entries else "(no summary recorded)"

    async with cl.Step(name=f"{icon} {title}", type="tool") as step:
        output = summary
        if status.get("message"):
            output += f"\n\nNote: {status['message']}"
        step.output = output


async def _render_final_report(state: dict[str, Any]) -> None:
    report = state.get("final_explainable_report")
    if not report:
        await cl.Message(
            content=(
                "Pipeline stopped before producing a report -- check the failed step "
                "above for why. No output is available to review."
            )
        ).send()
        return

    lines = [report["narrative"], "", f"**Confidence:** {report['confidence']:.2f}"]

    if report["citations"]:
        lines.append("")
        lines.append("**Cited literature:**")
        for citation in report["citations"]:
            lines.append(f"- [{citation['title']}]({citation['url']})")

    if report["shap_reference"]:
        lines.append("")
        lines.append(f"**SHAP demo (public data, not this case):** {report['shap_reference']}")

    if report["disagreement_flagged"]:
        lines.append("")
        lines.append(
            "⚠️ **Flagged for review** -- low confidence and/or a close "
            "differential. Treat as inconclusive, not a settled result."
        )

    await cl.Message(
        content="\n".join(lines),
        actions=[
            cl.Action(name="confirm_reviewed", payload={}, label="✅ Confirm reviewed by clinician")
        ],
    ).send()


@cl.action_callback("confirm_reviewed")
async def on_confirm_reviewed(action: cl.Action) -> None:
    """The only place `clinician_confirmed` becomes true in spirit -- no
    agent sets it in the pipeline itself (see explainability.py); this
    is the human action the report exists to require before anything is
    treated as final."""
    await cl.Message(
        content="Confirmed: a clinician has reviewed this report.\n\n" + INTENDED_USE_DISCLAIMER
    ).send()
    await action.remove()
