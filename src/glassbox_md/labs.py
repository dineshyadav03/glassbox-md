"""Mounting the educational simulators inside the Glassbox MD app.

Each simulator is a Vite + TypeScript app in its own folder, built to static files in `<folder>/dist/`.
This module serves any of them on Glassbox's own server at `/<slug>/`, so there is one app, one command
(`chainlit run app.py`), one URL and one origin, and the start menu can open them. A mount is added
ahead of Chainlit's catch-all route (which would otherwise answer every path with the chat page), and sits
behind the same login cookie when login is configured.

The simulators are part of this app but are not connected to the diagnostic pipeline: they simulate
procedures with invented physiology, read no case and write nothing. `cathlab.py` and `neurolab.py` each
describe one lab with a `Lab` and keep their own small, stable API on top of this module.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping

from starlette.requests import Request
from starlette.responses import PlainTextResponse, RedirectResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles
from starlette.types import ASGIApp, Receive, Scope, Send

LOGIN_PATH = "/login"


@dataclass(frozen=True)
class Lab:
    """One simulator: where its source lives, where it is mounted, and what the menu says about it."""

    slug: str  # URL segment, e.g. "cathlab" -> /cathlab/
    folder: str  # directory at the repository root holding the Vite app
    title: str  # e.g. "Cath lab simulator"
    notice: str  # the "educational only" wording shown with the menu entry

    @property
    def path(self) -> str:
        return f"/{self.slug}"

    @property
    def url(self) -> str:
        return self.path + "/"

    @property
    def build_commands(self) -> str:
        return f"cd {self.folder}\nnpm install\nnpm run build"

    def default_dist_dir(self) -> Path:
        """`<folder>/dist` at the repository root (this file is src/glassbox_md/labs.py)."""
        return Path(__file__).resolve().parents[2] / self.folder / "dist"


def is_built(dist: Path) -> bool:
    return (dist / "index.html").is_file()


class LoginGate:
    """Let a request through only if it carries a valid login cookie; otherwise send it to the login page.

    `token_from_cookies` and `is_valid` are injected so this has no Chainlit dependency and can
    be tested: in the app they are Chainlit's own `get_token_from_cookies` and a `decode_jwt`
    check, so every lab honours exactly the login the rest of the app does.
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


def mount_lab(
    lab: Lab,
    app,
    dist: Path | None = None,
    *,
    token_from_cookies: Callable[[Mapping[str, str]], str | None] | None = None,
    is_valid: Callable[[str], bool] | None = None,
) -> bool:
    """Serve the built lab at its path on `app`. Returns False (changing nothing) if it is not built.

    Pass both `token_from_cookies` and `is_valid` to require login; pass neither to leave it open
    (which is only acceptable when the whole app is, i.e. bound to loopback with no login).
    """
    if (token_from_cookies is None) != (is_valid is None):
        raise ValueError("pass both token_from_cookies and is_valid, or neither")
    directory = lab.default_dist_dir() if dist is None else dist
    if not is_built(directory):
        return False

    served: ASGIApp = StaticFiles(directory=directory, html=True)
    if token_from_cookies is not None and is_valid is not None:
        served = LoginGate(served, token_from_cookies, is_valid)

    # Ahead of everything else: Chainlit's catch-all route would otherwise answer /<slug>/ first.
    # A Starlette Mount matches /<slug>/... but not the bare /<slug>, which would fall through to
    # that catch-all and show the chat page, so the bare path gets its own redirect.
    async def to_slash(_request: Request) -> RedirectResponse:
        return RedirectResponse(lab.url, status_code=307)

    app.router.routes[0:0] = [
        Route(lab.path, to_slash, methods=["GET", "HEAD"], name=f"{lab.slug}-redirect"),
        Mount(lab.path, app=served, name=lab.slug),
    ]
    return True


def menu_message(lab: Lab, mounted: bool) -> str:
    """What the start menu says when the learner picks a simulator."""
    if mounted:
        return f"**{lab.title}** (educational)\n\n[Open the simulator]({lab.url}) in a new tab.\n\n{lab.notice}"
    return (
        f"**{lab.title}** (educational)\n\nIt has not been built on this machine yet. From the "
        f"project folder, once:\n\n```bash\n{lab.build_commands}\n```\n\nThen restart the app. It needs Node 20 or newer.\n\n"
        f"{lab.notice}"
    )
