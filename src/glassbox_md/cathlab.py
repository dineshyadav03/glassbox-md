"""The cath-lab simulator, served from inside the Glassbox MD app.

The simulator (`simulator/`, a Vite + TypeScript app) is built to static files in
`simulator/dist/`. This module mounts those files on Glassbox's own server at `/cathlab/`,
so there is one app, one command (`chainlit run app.py`), one URL and one origin, and the
start menu can open it. The mount is added ahead of Chainlit's catch-all route (which
would otherwise answer every path with the chat page), and sits behind the same login
cookie when login is configured.

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

from starlette.requests import Request
from starlette.responses import PlainTextResponse, RedirectResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles
from starlette.types import ASGIApp, Receive, Scope, Send

CATHLAB_PATH = "/cathlab"
CATHLAB_URL = CATHLAB_PATH + "/"
LOGIN_PATH = "/login"

CATHLAB_NOTICE = (
    "Educational demonstration only: a simplified teaching simulation with invented numbers. It is not "
    "clinical training or medical advice, and it is not connected to the diagnostic pipeline or to any case."
)

BUILD_COMMANDS = "cd simulator\nnpm install\nnpm run build"


def default_dist_dir() -> Path:
    """`simulator/dist` at the repository root (this file is src/glassbox_md/cathlab.py)."""
    return Path(__file__).resolve().parents[2] / "simulator" / "dist"


def is_built(dist: Path) -> bool:
    return (dist / "index.html").is_file()


class LoginGate:
    """Let a request through only if it carries a valid login cookie; otherwise send it to the login page.

    `token_from_cookies` and `is_valid` are injected so this has no Chainlit dependency and can
    be tested: in the app they are Chainlit's own `get_token_from_cookies` and a `decode_jwt`
    check, so the cath lab honours exactly the login the rest of the app does.
    """

    def __init__(
        self,
        app: ASGIApp,
        token_from_cookies: Callable[[Mapping[str, str]], str | None],
        is_valid: Callable[[str], bool],
    ) -> None:
        self.app = app
        self._token_from_cookies = token_from_cookies
        self._is_valid = is_valid

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        token = self._token_from_cookies(Request(scope).cookies)
        valid = False
        if token:
            try:
                valid = bool(self._is_valid(token))
            except Exception:  # noqa: BLE001 -- an unreadable or forged token is simply not valid
                valid = False
        if valid:
            await self.app(scope, receive, send)
            return
        if scope["method"] in ("GET", "HEAD"):
            response = RedirectResponse(LOGIN_PATH, status_code=302)
        else:
            response = PlainTextResponse("Login required", status_code=401)
        await response(scope, receive, send)


def mount_cathlab(
    app,
    dist: Path | None = None,
    *,
    token_from_cookies: Callable[[Mapping[str, str]], str | None] | None = None,
    is_valid: Callable[[str], bool] | None = None,
) -> bool:
    """Serve the built simulator at /cathlab/ on `app`. Returns False (changing nothing) if it is not built.

    Pass both `token_from_cookies` and `is_valid` to require login; pass neither to leave it open
    (which is only acceptable when the whole app is, i.e. bound to loopback with no login).
    """
    if (token_from_cookies is None) != (is_valid is None):
        raise ValueError("pass both token_from_cookies and is_valid, or neither")
    directory = default_dist_dir() if dist is None else dist
    if not is_built(directory):
        return False

    served: ASGIApp = StaticFiles(directory=directory, html=True)
    if token_from_cookies is not None and is_valid is not None:
        served = LoginGate(served, token_from_cookies, is_valid)

    # Ahead of everything else: Chainlit's catch-all route would otherwise answer /cathlab/ first.
    # A Starlette Mount matches /cathlab/... but not the bare /cathlab, which would fall through to
    # that catch-all and show the chat page, so the bare path gets its own redirect.
    async def to_slash(_request: Request) -> RedirectResponse:
        return RedirectResponse(CATHLAB_URL, status_code=307)

    app.router.routes[0:0] = [
        Route(CATHLAB_PATH, to_slash, methods=["GET", "HEAD"], name="cathlab-redirect"),
        Mount(CATHLAB_PATH, app=served, name="cathlab"),
    ]
    return True


def menu_message(mounted: bool) -> str:
    """What the start menu says when the learner picks the simulator."""
    if mounted:
        return (
            f"**Cath lab simulator** (educational)\n\n[Open the simulator]({CATHLAB_URL}) in a new tab.\n\n"
            f"{CATHLAB_NOTICE}"
        )
    return (
        "**Cath lab simulator** (educational)\n\nIt has not been built on this machine yet. From the "
        f"project folder, once:\n\n```bash\n{BUILD_COMMANDS}\n```\n\nThen restart the app. It needs Node 20 or newer.\n\n"
        f"{CATHLAB_NOTICE}"
    )
