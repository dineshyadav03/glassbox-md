"""Wires the six agents into one LangGraph `StateGraph`.

Phases 1-6 built and tested each agent as a standalone function; this
module is the first place they're actually connected into one pipeline.
Nothing about any individual agent changes here -- this is integration,
not new agent logic.

Conditional routing, uniformly applied: after every stage, if that
stage's own `stage_status[stage]["status"]` came back `"failed"`, the
graph routes straight to `END` instead of continuing. `"needs_review"` is
deliberately NOT treated as a failure here -- it means a stage produced
real, usable output that a human should look at (a low-confidence
differential, an implausible lab value, a close-call differential), not
that the stage produced nothing. Continuing past `needs_review` lets
those flags accumulate into the final report instead of silently
truncating the pipeline over something that isn't actually broken.

Retry and timeout around the one external, rate-limited call (the
Diagnostic Prediction Agent's OpenRouter request) live inside
`diagnostic_prediction.py` itself (`_call_openrouter`), not here.
LangGraph's own per-node `retry_policy` triggers on a node raising an
exception, but every agent in this pipeline deliberately never raises --
Phases 1-6 all convert failures into a recorded `stage_status` entry
instead, specifically so a bad case degrades to a routable status rather
than crashing the graph. Retrying at the graph level would therefore
never fire; retrying inside the one call that can transiently fail is
the design that actually engages.

`llm_caller` and `rag_collection` are injectable, mirroring the pattern
already used by `diagnostic_prediction_agent` and
`medical_knowledge_rag_agent` individually -- so an end-to-end test of
the whole graph can run offline, without a real API key or a pre-built
literature index, exactly like every other phase's test suite does.
"""

from __future__ import annotations

from functools import partial
from typing import Any

from langgraph.graph import END, StateGraph

from .agents.data_preparation import STAGE_NAME as PREP_STAGE
from .agents.data_preparation import data_preparation_agent
from .agents.diagnostic_prediction import STAGE_NAME as PREDICTION_STAGE
from .agents.diagnostic_prediction import LLMCaller, diagnostic_prediction_agent
from .agents.document_parser import STAGE_NAME as PARSER_STAGE
from .agents.document_parser import document_parser_agent
from .agents.explainability import STAGE_NAME as EXPLAIN_STAGE
from .agents.explainability import explainability_agent
from .agents.medical_knowledge_rag import STAGE_NAME as RAG_STAGE
from .agents.medical_knowledge_rag import medical_knowledge_rag_agent
from .agents.privacy_protection import STAGE_NAME as PRIVACY_STAGE
from .agents.privacy_protection import privacy_protection_agent
from .state import MedicalPipelineState

# Pipeline order -- also the order every earlier phase's roadmap and
# README describe: Documents -> Parser -> Privacy -> Prep -> RAG ->
# Prediction -> Explainable Diagnosis & Reasoning.
STAGE_ORDER = (PARSER_STAGE, PRIVACY_STAGE, PREP_STAGE, RAG_STAGE, PREDICTION_STAGE, EXPLAIN_STAGE)


def _route_on_failure(stage_name: str, next_stage: str):
    """Build a conditional-edge function for `stage_name`: continue to
    `next_stage` unless that stage's own status is `"failed"`, in which
    case go straight to END."""

    def router(state: MedicalPipelineState) -> str:
        status = (state.get("stage_status") or {}).get(stage_name, {})
        return END if status.get("status") == "failed" else next_stage

    return router


def build_pipeline_graph(
    llm_caller: LLMCaller | None = None, rag_collection: Any | None = None
):
    """Compile the six-agent pipeline. `llm_caller` and `rag_collection`
    are forwarded to the Diagnostic Prediction and Medical Knowledge RAG
    agents respectively -- pass fakes here for a fully offline test of
    the whole graph, or leave both None to use the real OpenRouter call
    and the real persisted ChromaDB index.
    """
    graph = StateGraph(MedicalPipelineState)

    nodes = {
        PARSER_STAGE: document_parser_agent,
        PRIVACY_STAGE: privacy_protection_agent,
        PREP_STAGE: data_preparation_agent,
        RAG_STAGE: partial(medical_knowledge_rag_agent, collection=rag_collection),
        PREDICTION_STAGE: partial(diagnostic_prediction_agent, llm_caller=llm_caller),
        EXPLAIN_STAGE: explainability_agent,
    }
    for name, fn in nodes.items():
        graph.add_node(name, fn)

    graph.set_entry_point(PARSER_STAGE)

    for stage_name, next_stage in zip(STAGE_ORDER, STAGE_ORDER[1:]):
        graph.add_conditional_edges(
            stage_name, _route_on_failure(stage_name, next_stage), path_map=[next_stage, END]
        )
    graph.add_edge(EXPLAIN_STAGE, END)

    return graph.compile()
