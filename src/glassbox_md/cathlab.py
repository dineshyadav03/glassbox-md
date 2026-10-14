"""The cath-lab simulator, served from inside the Glassbox MD app.

The simulator (`simulator/`, a Vite + TypeScript app) is built to static files in `simulator/dist/` and
mounted at `/cathlab/` by the shared mounting code in `labs.py`. The mount is added ahead of Chainlit's
catch-all route, and sits behind the same login cookie when login is configured.

What "merged" does and does not mean. The simulator is part of this app, but it is not
connected to the diagnostic pipeline: it simulates a procedure with invented physiology,
reads no case, and writes nothing. The pipeline reasons about documents; mixing the two
would blur what each one claims. So the start menu opens the simulator, and no patient
report links to it or suggests a procedure.

If `simulator/dist/` has not been built (a fresh clone, or no Node), nothing is mounted
and the menu entry says how to build it, instead of leading to a 404.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, Mapping

from glassbox_md import labs
from glassbox_md.labs import LOGIN_PATH, LoginGate, is_built  # noqa: F401 -- re-exported, tests import them from here

CATHLAB_NOTICE = (
    "Educational demonstration only: a simplified teaching simulation with invented numbers. It is not "
    "clinical training or medical advice, and it is not connected to the diagnostic pipeline or to any case."
)

LAB = labs.Lab(slug="cathlab", folder="simulator", title="Cath lab simulator", notice=CATHLAB_NOTICE)

CATHLAB_PATH = LAB.path
CATHLAB_URL = LAB.url
BUILD_COMMANDS = LAB.build_commands


def default_dist_dir() -> Path:
    """`simulator/dist` at the repository root."""
    return LAB.default_dist_dir()


def mount_cathlab(
    app,
    dist: Path | None = None,
    *,
    token_from_cookies: Callable[[Mapping[str, str]], str | None] | None = None,
    is_valid: Callable[[str], bool] | None = None,
) -> bool:
    """Serve the built simulator at /cathlab/ on `app`. Returns False (changing nothing) if it is not built."""
    return labs.mount_lab(LAB, app, dist, token_from_cookies=token_from_cookies, is_valid=is_valid)


def menu_message(mounted: bool) -> str:
    """What the start menu says when the learner picks the simulator."""
    return labs.menu_message(LAB, mounted)
