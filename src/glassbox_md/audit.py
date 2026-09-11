"""Builds a single AuditEntry. Every agent appends at least one of these per
run (see `audit_log` in state.py) -- this is the one place that formats
them, so the timestamp format and entry shape can't drift agent to agent.
"""

from __future__ import annotations

from datetime import datetime, timezone

from .state import AuditEntry


def audit_entry(stage: str, summary: str) -> AuditEntry:
    return {
        "stage": stage,
        "summary": summary,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
