"""Reject cross-origin and DNS-rebinding browser requests, including
websocket handshakes.

Why this exists: Chainlit's `allow_origins` setting is applied through
FastAPI's CORSMiddleware, which only covers plain HTTP. Every real action in
this app (uploads, running the pipeline, "Browse past cases") travels over
the socket.io websocket, and its server is built with `cors_allowed_origins=[]`
-- which python-engineio treats as "do not check". Verified empirically
against a running instance: a websocket handshake carrying
`Origin: http://evil.example` was accepted and got a live session. That is
cross-site WebSocket hijacking: any web page open in the same browser could
drive a locally running copy of this app and read its saved cases.

Two checks close it:

1. **Host must be trusted.** Only loopback names (`localhost`, `127.0.0.1`,
   `::1`) and the hostnames listed in `allow_origins` are accepted. This is
   what stops DNS rebinding: an attacker's domain re-resolved to 127.0.0.1
   sends `Host: evil.example` *and* `Origin: http://evil.example`, which
   match each other, so a "same origin" comparison alone waves it through
   (verified: it did, before this check existed). Applies to every request,
   with or without an Origin header, since a same-origin GET carries none.
2. **Origin, if present, must be same-origin or listed.** Browsers always send
   Origin on a websocket handshake and on cross-origin XHR/POST. Same-origin
   is decided against the (already trusted) Host header, so any port works
   without listing it.

A request with no Origin header is still let through once its Host is
trusted: a non-browser client can set any header it likes, so this is not
authentication -- it is the missing browser-side protection. Use login
(auth.py) for actual access control. An explicit `"*"` in `allow_origins`
disables both checks, as that setting always meant.
"""

from __future__ import annotations

from typing import Iterable
from urllib.parse import urlsplit

_LOOPBACK_HOSTNAMES = frozenset({"localhost", "127.0.0.1", "::1"})


def _normalise(origin: str) -> str:
    return origin.strip().rstrip("/").lower()


def _hostname(netloc_or_host: str | None) -> str | None:
    """Lower-cased hostname without port or IPv6 brackets, or None."""
    if not netloc_or_host or "@" in netloc_or_host or any(c.isspace() for c in netloc_or_host.strip()):
        return None  # userinfo ("trusted@evil") or stray whitespace: never a real Host
    try:
        return urlsplit("//" + netloc_or_host.strip()).hostname
    except ValueError:
        return None


class OriginGuard:
    def __init__(self, app, allowed_origins: Iterable[str]):
        self.app = app
        allowed = {_normalise(origin) for origin in allowed_origins}
        self.allow_all = "*" in allowed
        self.allowed = allowed - {"*"}
        listed_hosts = {_hostname(urlsplit(origin).netloc) for origin in self.allowed}
        self.trusted_hostnames = _LOOPBACK_HOSTNAMES | {h for h in listed_hosts if h}

    def _host_trusted(self, host: str | None) -> bool:
        hostname = _hostname(host)
        return hostname is not None and hostname in self.trusted_hostnames

    def _origin_permitted(self, origin: str, host: str | None) -> bool:
        normalised = _normalise(origin)
        if normalised in self.allowed:
            return True
        if normalised == "null":  # sandboxed iframe, file:// -- never same-origin
            return False
        parts = urlsplit(normalised)
        return bool(host) and parts.scheme in ("http", "https") and parts.netloc == host.strip().lower()

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket") and not self.allow_all:
            # Every occurrence, not a dict of the last one: Starlette's header
            # lookup returns the FIRST, so a guard that read the last would
            # disagree with its own backend about what "the" Host is.
            header_list = scope.get("headers", [])
            hosts = [value for name, value in header_list if name == b"host"]
            origins = [value for name, value in header_list if name == b"origin"]
            host = hosts[0].decode("latin-1") if len(hosts) == 1 else None  # none or several: untrusted
            if not self._host_trusted(host) or any(
                not self._origin_permitted(origin.decode("latin-1"), host) for origin in origins
            ):
                await self._reject(scope, send)
                return
        await self.app(scope, receive, send)

    @staticmethod
    async def _reject(scope, send) -> None:
        if scope["type"] == "websocket":
            # Closing before accepting turns the handshake into an HTTP 403.
            await send({"type": "websocket.close", "code": 1008})
            return
        body = b"Origin not allowed"
        await send(
            {
                "type": "http.response.start",
                "status": 403,
                "headers": [(b"content-type", b"text/plain; charset=utf-8"), (b"content-length", str(len(body)).encode())],
            }
        )
        await send({"type": "http.response.body", "body": body})
