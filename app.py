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
clicking this button does. It's durable now, not just a chat message:
confirming calls `case_store.confirm_case`, which records a real
timestamp in `data/cases/cases.db` and is what a reopened past case's
`clinician_confirmed` flag actually reflects.

Case persistence + browse: every completed case is saved via
`case_store.save_case` right where its report is first shown (only the
already-redacted report/prediction/audit-log, never raw or
pre-anonymization fields -- see case_store.py's own docstring for the
full allow-list and why). `on_chat_start` now offers a choice --
upload a new case, or browse recent past cases -- before falling
through to the existing upload flow. Both the live and the
reopened-past-case path render through the same `report_format.build_report_markdown`
so there's exactly one place that knows how to format a report, not two
copies that can drift.

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
actually means in this pipeline (see report_format.py, which also states
where the model's reasoning and confidence are self-reported rather than
verified).
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent / "src"))

import chainlit as cl
from dotenv import load_dotenv

from chainlit.config import config as chainlit_config
from chainlit.server import app as chainlit_server_app

from glassbox_md import auth, case_store
from glassbox_md.case_store import CaseRecord
from glassbox_md.origin_guard import OriginGuard
from glassbox_md.disclaimer import INTENDED_USE_DISCLAIMER
from glassbox_md.pipeline import build_pipeline_graph
from glassbox_md.report_format import build_report_markdown
from glassbox_md.state import new_stage_status

load_dotenv()

# Fails at startup, before anything is served, if the server is bound to a
# non-loopback host without login or login is half-configured (see auth.py).
_auth_settings = auth.enforce_deployment_safety()

# Chainlit's `allow_origins` only reaches plain HTTP; its websocket (where all
# real traffic goes) accepted any Origin -- verified against a running
# instance. This closes that for both, using the same allow-list. Login is
# still the actual access control (see origin_guard.py).
chainlit_server_app.add_middleware(OriginGuard, allowed_origins=chainlit_config.project.allow_origins)

if _auth_settings.enabled:

    @cl.password_auth_callback
    def _authenticate(username: str, password: str) -> cl.User | None:
        if auth.check_credentials(username, password, _auth_settings):
            return cl.User(identifier=username)
        return None

else:
    print(
        "WARNING: login is not configured, so this app is open to anyone who can reach it. That is "
        "acceptable only bound to 127.0.0.1 (the default). See README 'Deployment checklist'.",
        file=sys.stderr,
    )

STAGE_TITLES = {
    "document_parser": "1 · Document Parser",
    "privacy_protection": "2 · Privacy Protection",
    "data_preparation": "3 · Data Preparation",
    "medical_knowledge_rag": "4 · Medical Knowledge RAG",
    "diagnostic_prediction": "5 · Diagnostic Prediction",
    "explainability": "6 · Report Assembly",
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

    choice = await cl.AskActionMessage(
        content="Start a new case, or look at a past one?",
        actions=[
            cl.Action(name="upload_new", payload={}, label="📤 Upload a new case"),
            cl.Action(name="view_past", payload={}, label="📋 Browse past cases"),
        ],
        timeout=90,
    ).send()

    # None on timeout (raise_on_timeout defaults to False) -- treated the
    # same as explicitly choosing to upload, not as an error.
    if choice and choice["name"] == "view_past":
        opened = await _browse_past_cases()
        if opened:
            return

    await _start_new_case_upload()


async def _browse_past_cases() -> bool:
    """Offer recent cases to reopen. Returns True if one was actually
    opened (caller should stop there), False to fall through to the
    upload flow (empty store, timeout, or the explicit "start new"
    escape hatch)."""
    cases = await asyncio.to_thread(case_store.list_recent_cases, 20)
    if not cases:
        await cl.Message(content="No past cases yet -- upload one to get started.").send()
        return False

    actions = [
        cl.Action(
            name="select_case",
            payload={"case_id": case["case_id"]},
            label=_case_summary_label(case),
        )
        for case in cases
    ]
    actions.append(
        cl.Action(name="select_case", payload={"case_id": None}, label="Start a new case instead")
    )

    picked = await cl.AskActionMessage(
        content="Recent cases (newest first):", actions=actions, timeout=90
    ).send()

    if not picked or picked["payload"].get("case_id") is None:
        return False

    case = await asyncio.to_thread(case_store.get_case, picked["payload"]["case_id"])
    if case is None:
        await cl.Message(content="That case no longer exists -- starting a new one instead.").send()
        return False

    await _render_case(case)
    return True


def _case_summary_label(case: CaseRecord) -> str:
    report = case["final_explainable_report"]
    prediction = case["diagnostic_prediction_result"]
    differential = prediction.get("differential") or []
    top = max(differential, key=lambda c: c["likelihood"])["condition"] if differential else "no differential"
    confirmed_marker = "✅" if case["confirmed"] else "⬜"
    when = case["created_at"][:16].replace("T", " ")  # YYYY-MM-DD HH:MM, no seconds/offset
    return f"{confirmed_marker} {when} -- {top} ({report['confidence']:.2f})"


async def _start_new_case_upload() -> None:
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

    report = state.get("final_explainable_report")
    if not report:
        await cl.Message(
            content=(
                "Pipeline stopped before producing a report -- check the failed step "
                "above for why. No output is available to review."
            )
        ).send()
        return

    case_id = await asyncio.to_thread(case_store.save_case, state)
    cl.user_session.set("case_id", case_id)
    await _render_report(report, state.get("diagnostic_prediction_result") or {}, confirmed=False)


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


async def _render_report(report: dict[str, Any], prediction: dict[str, Any], *, confirmed: bool) -> None:
    """Send the report, with the right action: a live Confirm button for
    an unconfirmed case, or a static notice for one that's already
    confirmed -- confirmation is one immutable fact, not a re-clickable
    toggle (see case_store.confirm_case's idempotency for the DB-level
    half of that same rule)."""
    content = build_report_markdown(report, prediction)
    if confirmed:
        await cl.Message(content=content).send()
        await cl.Message(content="✅ Already confirmed reviewed by clinician.").send()
    else:
        await cl.Message(
            content=content,
            actions=[
                cl.Action(name="confirm_reviewed", payload={}, label="✅ Confirm reviewed by clinician")
            ],
        ).send()


async def _render_case(case: CaseRecord) -> None:
    cl.user_session.set("case_id", case["case_id"])
    await _render_report(
        case["final_explainable_report"], case["diagnostic_prediction_result"], confirmed=case["confirmed"]
    )


@cl.action_callback("confirm_reviewed")
async def on_confirm_reviewed(action: cl.Action) -> None:
    """The only place `clinician_confirmed` becomes true in spirit -- no
    agent sets it in the pipeline itself (see explainability.py); this
    is the human action the report exists to require before anything is
    treated as final. Durable now: `case_store.confirm_case` records a
    real timestamp in `data/cases/cases.db`, not just a chat message that
    vanishes with the session."""
    case_id = cl.user_session.get("case_id")
    if not case_id:
        await cl.Message(
            content="Could not find this case to confirm -- try reopening it from Browse past cases."
        ).send()
        await action.remove()
        return

    confirmed_at = await asyncio.to_thread(case_store.confirm_case, case_id)
    if confirmed_at is None:
        await cl.Message(content="This case no longer exists in the case store.").send()
        await action.remove()
        return

    await cl.Message(
        content=f"Confirmed: a clinician has reviewed this report (recorded {confirmed_at}).\n\n"
        + INTENDED_USE_DISCLAIMER
    ).send()
    await action.remove()
