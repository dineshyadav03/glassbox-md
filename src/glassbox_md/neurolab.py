"""The brain-surgery simulator (aneurysm clipping), served from inside the Glassbox MD app at `/neurolab/`.

Same arrangement as the cath lab (see `labs.py`): the Vite app in `neurolab/` is built to `neurolab/dist/`,
mounted ahead of Chainlit's catch-all route and behind the same login. It is educational only and is not
connected to the diagnostic pipeline. If it has not been built, nothing is mounted and the menu says how.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, Mapping

from glassbox_md import labs

NEUROLAB_NOTICE = (
    "Educational demonstration only: a simplified teaching simulation with procedural shapes and invented "
    "numbers. It is not clinical training, not a medical device and not medical advice, and it is not "
    "connected to the diagnostic pipeline or to any case."
)

LAB = labs.Lab(slug="neurolab", folder="neurolab", title="Brain surgery simulator", notice=NEUROLAB_NOTICE)

NEUROLAB_PATH = LAB.path
NEUROLAB_URL = LAB.url


def mount_neurolab(
    app,
    dist: Path | None = None,
    *,
    token_from_cookies: Callable[[Mapping[str, str]], str | None] | None = None,
    is_valid: Callable[[str], bool] | None = None,
) -> bool:
    """Serve the built simulator at /neurolab/ on `app`. Returns False (changing nothing) if it is not built."""
    return labs.mount_lab(LAB, app, dist, token_from_cookies=token_from_cookies, is_valid=is_valid)


def menu_message(mounted: bool) -> str:
    """What the start menu says when the learner picks the simulator."""
    return labs.menu_message(LAB, mounted)
