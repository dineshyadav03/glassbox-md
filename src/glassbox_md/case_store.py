"""Local persistence for a completed case: the final report, plus whether
and when a clinician confirmed it.

Before this module, "Confirm reviewed by clinician" (see app.py) sent a
chat message and nothing else -- each chat session was one ephemeral run,
and `ExplainableReport.clinician_confirmed` (state.py) existed in the
schema but nothing ever set it. This closes that gap with the smallest
real thing that works: stdlib `sqlite3` (zero new dependency, matching
every other "reuse what's already there" decision in this project --
pdfplumber not Marker, raw E-utilities not biopython, MeSH not UMLS),
one table, four functions.

Path is `CASE_STORE_PATH` if set, else `./data/cases/cases.db` -- the
same env-var-with-a-data/-default convention `CHROMA_PERSIST_DIR` uses
in medical_knowledge_rag.py.

What gets persisted, deliberately minimal: `final_explainable_report`,
`diagnostic_prediction_result`, and `audit_log` only -- every
`audit_entry()` summary across all six agents is a count/category
string, never raw content, so this is genuinely safe to store. Never
`raw_input_paths`, `extracted_document_content` (still pre-redaction at
that point in the pipeline), `anonymized_patient_data`, or
`structured_clinical_data` -- even though the latter two are already
de-identified, minimizing what's persisted at all is the more
conservative privacy-by-design choice, and none of it is needed to
redisplay a confirmed report. `save_case` also calls
`assert_privacy_boundary_respected` on the full state before writing
anything -- the second production call site that guard has ever had; its
own docstring has recommended exactly this ("call this... before the
two nodes that call an external service") since Phase 0, and nothing
outside the Privacy Protection Agent's own self-check ever did until now.

Scope limit, stated plainly: one local SQLite file is enough for this
MVP's single-user local demo. It is not a concurrent-multi-writer store
-- that would need a real client-server database, the same class of
explicit V3-scale cap as the RAG agent's linear concept-matching scan or
MAX_IMAGES_PER_CALL elsewhere in this codebase.

Connections are opened, used, and closed within each function call --
never cached at module scope. `sqlite3.Connection` defaults to
`check_same_thread=True`; a connection cached at import time would be
bound to whichever thread first imported this module and raise on any
call from a different one, which app.py's `asyncio.to_thread(...)`
wrapping around every call here makes a real possibility, not a
hypothetical. `_default_collection()` in medical_knowledge_rag.py
already established this same per-call-connection pattern for the same
reason.
"""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any, TypedDict

from .state import MedicalPipelineState, assert_privacy_boundary_respected

DB_PATH_ENV_VAR = "CASE_STORE_PATH"
DEFAULT_DB_PATH = "./data/cases/cases.db"


class CaseRecord(TypedDict):
    case_id: str
    created_at: str
    confirmed: bool
    confirmed_at: str | None
    final_explainable_report: dict[str, Any]
    diagnostic_prediction_result: dict[str, Any]
    audit_log: list[dict[str, Any]]


def _resolve_db_path(db_path: str | None) -> str:
    return db_path or os.environ.get(DB_PATH_ENV_VAR, DEFAULT_DB_PATH)


def _connect(db_path: str | None) -> sqlite3.Connection:
    resolved = _resolve_db_path(db_path)
    parent = os.path.dirname(resolved)
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(resolved)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS cases (
            case_id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            confirmed INTEGER NOT NULL,
            confirmed_at TEXT,
            report_json TEXT NOT NULL
        )
        """
    )
    return conn


def _row_to_case_record(row: tuple[str, str, int, str | None, str]) -> CaseRecord:
    case_id, created_at, confirmed, confirmed_at, report_json = row
    blob = json.loads(report_json)
    report = dict(blob["final_explainable_report"])
    # The stored blob is written once, unconfirmed, at save_case time and
    # never rewritten -- the `confirmed` column is the authoritative
    # value, patched in here on every read, so a confirmed-and-reopened
    # case can never render as unconfirmed.
    report["clinician_confirmed"] = bool(confirmed)
    return CaseRecord(
        case_id=case_id,
        created_at=created_at,
        confirmed=bool(confirmed),
        confirmed_at=confirmed_at,
        final_explainable_report=report,
        diagnostic_prediction_result=blob["diagnostic_prediction_result"],
        audit_log=blob["audit_log"],
    )


def save_case(state: MedicalPipelineState, *, db_path: str | None = None) -> str:
    """Persist a completed case. Fail-closed: the privacy-boundary check
    runs before any database connection is even opened, so a violating
    state writes zero bytes to disk, not a partial row later rolled back.
    """
    assert_privacy_boundary_respected(state)

    report = state.get("final_explainable_report")
    if report is None:
        raise ValueError("save_case requires a completed final_explainable_report")

    case_id = uuid.uuid4().hex
    created_at = datetime.now(timezone.utc).isoformat()
    blob = json.dumps(
        {
            "final_explainable_report": report,
            "diagnostic_prediction_result": state.get("diagnostic_prediction_result") or {},
            "audit_log": state.get("audit_log") or [],
        }
    )

    conn = _connect(db_path)
    try:
        with conn:
            conn.execute(
                "INSERT INTO cases (case_id, created_at, confirmed, confirmed_at, report_json) "
                "VALUES (?, ?, 0, NULL, ?)",
                (case_id, created_at, blob),
            )
    finally:
        conn.close()

    return case_id


def confirm_case(case_id: str, *, db_path: str | None = None) -> str | None:
    """Mark a case confirmed. Idempotent: a case already confirmed keeps
    its original confirmed_at (COALESCE), so a double-click, two
    sessions, or reconfirming a reopened case can never overwrite the
    true first-confirmation time. Returns that confirmed_at, or None if
    no case with this id exists."""
    confirmed_at = datetime.now(timezone.utc).isoformat()

    conn = _connect(db_path)
    try:
        with conn:
            conn.execute(
                "UPDATE cases SET confirmed = 1, confirmed_at = COALESCE(confirmed_at, ?) WHERE case_id = ?",
                (confirmed_at, case_id),
            )
        row = conn.execute(
            "SELECT confirmed_at FROM cases WHERE case_id = ?", (case_id,)
        ).fetchone()
    finally:
        conn.close()

    return row[0] if row else None


def get_case(case_id: str, *, db_path: str | None = None) -> CaseRecord | None:
    conn = _connect(db_path)
    try:
        row = conn.execute(
            "SELECT case_id, created_at, confirmed, confirmed_at, report_json FROM cases WHERE case_id = ?",
            (case_id,),
        ).fetchone()
    finally:
        conn.close()

    return _row_to_case_record(row) if row else None


def list_recent_cases(limit: int = 20, *, db_path: str | None = None) -> list[CaseRecord]:
    conn = _connect(db_path)
    try:
        rows = conn.execute(
            "SELECT case_id, created_at, confirmed, confirmed_at, report_json FROM cases "
            "ORDER BY created_at DESC, rowid DESC LIMIT ?",
            (limit,),
        ).fetchall()
    finally:
        conn.close()

    return [_row_to_case_record(row) for row in rows]
