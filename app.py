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

UI polish pass: the differential renders as an actual Markdown table
(condition, likelihood, evidence), read directly from
`diagnostic_prediction_result` in state rather than re-parsed out of
`final_explainable_report["narrative"]` -- that narrative string is a
flattened, pre-formatted version of the same data, built for the case
where a UI has nowhere better to put it. This UI does, so it reads the
structured data directly and only falls back to the narrative string for
the abstained case, where it's already just one clean sentence with
nothing to tabulate. Confidence gets a color badge (🟢/🟡/🔴) using the
same `CONFIDENCE_THRESHOLD` the backend abstention logic itself uses, so
the visual cue can't drift out of sync with what "low confidence"
actually means in this pipeline.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent / "src"))

import chainlit as cl
from dotenv import load_dotenv

from glassbox_md.agents.diagnostic_prediction import CONFIDENCE_THRESHOLD
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

# The upper band is a UI-only judgment call (nothing in the backend treats
# 0.7 as meaningful) -- the lower band is not: it's the exact threshold
# diagnostic_prediction.py uses to decide abstention, imported rather than
# duplicated as a literal so this badge can never silently drift out of
# sync with what "low confidence" actually triggers.
_CONFIDENCE_HIGH_BAND = 0.7


def _confidence_badge(confidence: float) -> str:
    if confidence < CONFIDENCE_THRESHOLD:
        return "🔴"
    if confidence < _CONFIDENCE_HIGH_BAND:
        return "🟡"
    return "🟢"

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

    await cl.Message(
        content=(
            "Running the 6-agent pipeline. Steps 1-4 are usually done in a couple of "
            "seconds; if the case reaches step 5, that's a real call to a free-tier "
            "model and can take up to ~90 seconds -- that's expected, not a hang."
        ),
        author="System",
    ).send()

    await run_pipeline([f.path for f in files if f.path])


async def run_pipeline(paths: list[str]) -> None:
    state = _new_state(paths)

    try:
        # astream(), not stream() -- stream() is LangGraph's SYNC API, and
        # Diagnostic Prediction's real OpenRouter call
        # (_default_caller in diagnostic_prediction.py) is a blocking
        # `OpenAI` client call that can run 60-180s. Iterating stream()
        # here froze this whole async handler -- and with it Chainlit's
        # asyncio event loop -- for the entire call, starving the
        # Socket.IO keepalive ping until the browser decided the server
        # was unreachable, even though the backend call was still working
        # and eventually succeeded. astream() runs each node's plain sync
        # function through a thread-pool executor instead of inline on
        # this loop, so a slow node no longer blocks it. Found live: a
        # real upload's UI showed "Could not reach the server" while the
        # server logs showed the OpenRouter call return HTTP 200 a few
        # seconds later. See test_astream_keeps_the_event_loop_responsive_
        # during_a_slow_llm_call in tests/test_pipeline.py.
        async for chunk in _pipeline.astream(state):
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

    prediction = state.get("diagnostic_prediction_result") or {}
    lines: list[str] = []

    if prediction.get("abstained") and not prediction.get("differential"):
        # Nothing to tabulate -- the narrative is already just one clean
        # sentence for this case (see module docstring).
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
                f"| {_confidence_badge(condition['likelihood'])} "
                f"| {condition['condition']} "
                f"| {condition['likelihood']:.2f} "
                f"| {evidence} |"
            )
        reasoning_notes = prediction.get("reasoning_notes")
        if reasoning_notes:
            lines.append("")
            lines.append(f"**Model's self-reported reasoning:** {reasoning_notes}")

    lines.append("")
    lines.append(f"**Overall confidence:** {_confidence_badge(report['confidence'])} {report['confidence']:.2f}")

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
