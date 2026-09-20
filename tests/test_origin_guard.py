"""OriginGuard: the browser-side protection Chainlit's own websocket lacks.

Driven as a bare ASGI app so the tests exercise exactly what the server
sees, with an inner app that records whether it was ever reached."""

import asyncio

import pytest

from glassbox_md.origin_guard import OriginGuard

ALLOWED = ["http://localhost:8000", "http://127.0.0.1:8000"]


class _Inner:
    def __init__(self):
        self.calls = 0

    async def __call__(self, scope, receive, send):
        self.calls += 1


def _scope(kind, *, origin=None, host="127.0.0.1:8000"):
    headers = [(b"host", host.encode())]
    if origin is not None:
        headers.append((b"origin", origin.encode()))
    return {"type": kind, "headers": headers}


def _run(guard, scope):
    sent = []

    async def send(message):
        sent.append(message)

    asyncio.run(guard(scope, None, send))
    return sent


@pytest.mark.parametrize("kind", ["http", "websocket"])
def test_a_request_with_no_origin_passes_through(kind):
    inner = _Inner()
    assert _run(OriginGuard(inner, ALLOWED), _scope(kind)) == [] and inner.calls == 1


@pytest.mark.parametrize("origin", ["http://localhost:8000", "http://127.0.0.1:8000", "HTTP://LocalHost:8000/"])
def test_listed_origins_pass_regardless_of_case_and_trailing_slash(origin):
    inner = _Inner()
    _run(OriginGuard(inner, ALLOWED), _scope("websocket", origin=origin))
    assert inner.calls == 1


def test_same_origin_on_any_port_passes_by_comparing_with_the_host_header():
    """So running on a port that isn't in the list still works for the page
    the server itself served."""
    inner = _Inner()
    _run(OriginGuard(inner, ALLOWED), _scope("websocket", origin="http://127.0.0.1:8013", host="127.0.0.1:8013"))
    _run(OriginGuard(inner, ALLOWED), _scope("http", origin="http://localhost:8013", host="localhost:8013"))
    assert inner.calls == 2


def test_a_deployed_hostname_works_once_it_is_listed_and_not_before():
    listed = ALLOWED + ["https://demo.example.org"]

    inner = _Inner()
    _run(OriginGuard(inner, listed), _scope("http", origin="https://demo.example.org", host="demo.example.org"))
    _run(OriginGuard(inner, listed), _scope("websocket", origin="https://demo.example.org", host="demo.example.org"))
    _run(OriginGuard(inner, listed), _scope("http", host="demo.example.org:443"))  # same-origin GET: no Origin
    assert inner.calls == 3

    unlisted = _Inner()
    _run(OriginGuard(unlisted, ALLOWED), _scope("http", origin="https://demo.example.org", host="demo.example.org"))
    assert unlisted.calls == 0


@pytest.mark.parametrize("kind", ["http", "websocket"])
def test_dns_rebinding_is_blocked_even_though_origin_and_host_match(kind):
    """An attacker's domain re-resolved to 127.0.0.1 sends Host AND Origin
    for that domain, which are 'same origin' to each other. Comparing them
    alone let this through (verified); the Host itself must be trusted."""
    inner = _Inner()

    _run(OriginGuard(inner, ALLOWED), _scope(kind, origin="http://evil.example:8000", host="evil.example:8000"))

    assert inner.calls == 0


@pytest.mark.parametrize("kind", ["http", "websocket"])
def test_rebinding_is_blocked_for_a_same_origin_get_that_carries_no_origin_header(kind):
    """Browsers omit Origin on a same-origin GET, so the Host check has to
    stand on its own."""
    inner = _Inner()

    _run(OriginGuard(inner, ALLOWED), _scope(kind, host="evil.example:8000"))

    assert inner.calls == 0


@pytest.mark.parametrize(
    "host",
    ["127.0.0.1:8000", "localhost:8000", "LOCALHOST", "localhost", "[::1]:8000", "127.0.0.1:1"],
)
def test_loopback_hosts_are_trusted_with_or_without_a_port(host):
    inner = _Inner()
    _run(OriginGuard(inner, ALLOWED), _scope("http", host=host))
    assert inner.calls == 1


@pytest.mark.parametrize(
    "host",
    [
        "evil.example",
        "127.0.0.1@evil.example",
        "evil.example@127.0.0.1",  # userinfo trick: parses as host 127.0.0.1
        "localhost evil.example",
        "localhost.evil.example",
        "127.0.0.1.evil.example:8000",
        "",
    ],
)
def test_malformed_or_lookalike_hosts_are_rejected(host):
    inner = _Inner()
    _run(OriginGuard(inner, ALLOWED), _scope("http", host=host))
    assert inner.calls == 0


def test_a_request_with_no_host_header_at_all_is_rejected():
    inner = _Inner()
    _run(OriginGuard(inner, ALLOWED), {"type": "http", "headers": []})
    assert inner.calls == 0


@pytest.mark.parametrize(
    "origin",
    [
        "http://evil.example",
        "https://evil.example:8000",
        "http://localhost:9999",  # right host, wrong port
        "http://localhost:8000.evil.example",
        "http://evil.example/http://localhost:8000",
        "null",
        "",
        "file://",
    ],
)
def test_a_cross_origin_websocket_handshake_is_closed_before_it_is_accepted(origin):
    inner = _Inner()

    sent = _run(OriginGuard(inner, ALLOWED), _scope("websocket", origin=origin))

    assert inner.calls == 0
    assert sent == [{"type": "websocket.close", "code": 1008}]


def test_a_cross_origin_http_request_gets_a_403_and_never_reaches_the_app():
    inner = _Inner()

    sent = _run(OriginGuard(inner, ALLOWED), _scope("http", origin="http://evil.example"))

    assert inner.calls == 0
    assert sent[0]["type"] == "http.response.start" and sent[0]["status"] == 403
    assert sent[1] == {"type": "http.response.body", "body": b"Origin not allowed"}


def test_a_host_that_only_looks_like_the_origin_is_not_same_origin():
    inner = _Inner()
    _run(OriginGuard(inner, ALLOWED), _scope("websocket", origin="http://evil.example", host="evil.example.attacker.net"))
    assert inner.calls == 0


def test_missing_host_header_does_not_make_an_unlisted_origin_pass():
    inner = _Inner()
    scope = {"type": "websocket", "headers": [(b"origin", b"http://evil.example")]}
    _run(OriginGuard(inner, ALLOWED), scope)
    assert inner.calls == 0


def test_an_explicit_wildcard_still_means_allow_everything():
    inner = _Inner()
    _run(OriginGuard(inner, ["*"]), _scope("websocket", origin="http://evil.example"))
    assert inner.calls == 1


def test_scopes_that_are_not_http_or_websocket_are_untouched():
    inner = _Inner()
    _run(OriginGuard(inner, ALLOWED), {"type": "lifespan"})
    assert inner.calls == 1


@pytest.mark.parametrize("hosts", [[b"127.0.0.1:8000", b"evil.example"], [b"evil.example", b"127.0.0.1:8000"], [b"127.0.0.1:8000", b"127.0.0.1:8000"]])
def test_more_than_one_host_header_is_rejected_whatever_the_order(hosts):
    """Starlette reads the first Host and a naive guard the last; any
    disagreement is a way around the check, so duplicates are refused."""
    inner = _Inner()
    scope = {"type": "http", "headers": [(b"host", h) for h in hosts]}
    _run(OriginGuard(inner, ALLOWED), scope)
    assert inner.calls == 0


@pytest.mark.parametrize(
    "origins, reaches_app",
    [
        ([b"http://evil.example", b"http://127.0.0.1:8000"], False),
        ([b"http://127.0.0.1:8000", b"http://evil.example"], False),
        ([b"http://127.0.0.1:8000", b"http://localhost:8000"], True),
    ],
)
def test_every_origin_header_must_be_acceptable_not_just_the_first_or_last(origins, reaches_app):
    inner = _Inner()
    scope = {"type": "websocket", "headers": [(b"host", b"127.0.0.1:8000")] + [(b"origin", o) for o in origins]}
    _run(OriginGuard(inner, ALLOWED), scope)
    assert (inner.calls == 1) is reaches_app
