"""The cath lab served from inside the Glassbox app: mounting ahead of Chainlit's catch-all,
the login gate, the path guard, and the start-menu message. A bare FastAPI app with its own
catch-all stands in for Chainlit, so these run without the UI."""

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from glassbox_md import cathlab

ROOT = Path(__file__).resolve().parent.parent


def _app() -> FastAPI:
    """Like Chainlit's server: a catch-all route that answers any path with the chat page."""
    app = FastAPI()

    @app.get("/{full_path:path}")
    def catch_all(full_path: str) -> dict[str, str]:
        return {"page": "chat", "path": full_path}

    return app


@pytest.fixture
def dist(tmp_path):
    folder = tmp_path / "dist"
    (folder / "assets").mkdir(parents=True)
    (folder / "index.html").write_text("<html>cathlab home</html>", encoding="utf-8")
    (folder / "assets" / "app.js").write_text("console.log('sim')", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("not for the web", encoding="utf-8")
    return folder


# --- is it built, and mounting ---------------------------------------------------------------

def test_a_missing_or_empty_folder_is_not_built(tmp_path):
    assert cathlab.is_built(tmp_path / "nope") is False
    (tmp_path / "empty").mkdir()
    assert cathlab.is_built(tmp_path / "empty") is False


def test_a_folder_with_an_index_is_built(dist):
    assert cathlab.is_built(dist) is True


def test_the_default_location_is_simulator_dist_at_the_repo_root():
    assert cathlab.default_dist_dir() == ROOT / "simulator" / "dist"


def test_nothing_is_mounted_and_nothing_changes_when_it_is_not_built(tmp_path):
    app = _app()
    before = list(app.router.routes)
    assert cathlab.mount_cathlab(app, tmp_path / "missing") is False
    assert app.router.routes == before
    assert TestClient(app).get("/cathlab/").json()["page"] == "chat"


def test_it_is_served_ahead_of_the_catch_all(dist):
    app = _app()
    assert cathlab.mount_cathlab(app, dist) is True
    client = TestClient(app)
    home = client.get("/cathlab/")
    assert home.status_code == 200 and "cathlab home" in home.text
    asset = client.get("/cathlab/assets/app.js")
    assert asset.status_code == 200 and "console.log" in asset.text


def test_everything_else_still_reaches_the_chat_page(dist):
    app = _app()
    cathlab.mount_cathlab(app, dist)
    client = TestClient(app)
    for path in ("/", "/login", "/some/deep/page", "/cathlabs", "/cath"):
        body = client.get(path).json()
        assert body["page"] == "chat", path


def test_the_path_without_a_trailing_slash_redirects_to_it(dist):
    app = _app()
    cathlab.mount_cathlab(app, dist)
    response = TestClient(app).get("/cathlab", follow_redirects=False)
    assert response.status_code in (301, 302, 307, 308)
    assert response.headers["location"].endswith("/cathlab/")


def test_the_bare_path_redirects_even_when_login_is_required_and_then_asks_for_login(dist):
    client = _gated(dist)
    first = client.get("/cathlab", follow_redirects=False)
    assert first.status_code == 307 and first.headers["location"] == "/cathlab/"
    assert client.get("/cathlab/", follow_redirects=False).headers["location"] == "/login"


def test_an_unknown_file_under_it_is_a_404_not_the_chat_page(dist):
    app = _app()
    cathlab.mount_cathlab(app, dist)
    response = TestClient(app).get("/cathlab/missing.js")
    assert response.status_code == 404


@pytest.mark.parametrize("path", ["/cathlab/../secret.txt", "/cathlab/%2e%2e/secret.txt", "/cathlab/..%2fsecret.txt", "/cathlab/assets/../../secret.txt"])
def test_it_cannot_be_used_to_read_files_outside_the_folder(dist, path):
    app = _app()
    cathlab.mount_cathlab(app, dist)
    response = TestClient(app).get(path)
    assert "not for the web" not in response.text


def test_only_one_of_the_two_login_arguments_is_an_error(dist):
    with pytest.raises(ValueError):
        cathlab.mount_cathlab(_app(), dist, token_from_cookies=lambda cookies: None)
    with pytest.raises(ValueError):
        cathlab.mount_cathlab(_app(), dist, is_valid=lambda token: True)


# --- the login gate ---------------------------------------------------------------------------

def _gated(dist, valid_tokens=("good",)):
    app = _app()
    cathlab.mount_cathlab(
        app,
        dist,
        token_from_cookies=lambda cookies: cookies.get("access_token"),
        is_valid=lambda token: token in valid_tokens,
    )
    return TestClient(app)


def test_without_a_login_cookie_a_page_request_goes_to_the_login_page(dist):
    response = _gated(dist).get("/cathlab/", follow_redirects=False)
    assert response.status_code == 302
    assert response.headers["location"] == "/login"
    assert "cathlab home" not in response.text


def test_without_a_login_cookie_nothing_inside_is_served_either(dist):
    response = _gated(dist).get("/cathlab/assets/app.js", follow_redirects=False)
    assert response.status_code == 302 and "console.log" not in response.text


def test_a_forged_or_expired_token_is_refused(dist):
    client = _gated(dist)
    client.cookies.set("access_token", "forged")
    assert client.get("/cathlab/", follow_redirects=False).status_code == 302


def test_a_valid_login_cookie_is_let_through(dist):
    client = _gated(dist)
    client.cookies.set("access_token", "good")
    assert "cathlab home" in client.get("/cathlab/").text
    assert client.get("/cathlab/assets/app.js").status_code == 200


def test_a_non_page_request_without_a_login_gets_401_not_a_redirect(dist):
    response = _gated(dist).post("/cathlab/", follow_redirects=False)
    assert response.status_code == 401


def test_a_validator_that_raises_counts_as_not_logged_in(dist):
    app = _app()

    def boom(token: str) -> bool:
        raise RuntimeError("bad signature")

    cathlab.mount_cathlab(app, dist, token_from_cookies=lambda c: c.get("access_token"), is_valid=boom)
    client = TestClient(app)
    client.cookies.set("access_token", "x")
    assert client.get("/cathlab/", follow_redirects=False).status_code == 302


def test_the_rest_of_the_app_is_not_gated_by_this(dist):
    assert _gated(dist).get("/login").json()["page"] == "chat"


def test_with_no_login_configured_it_is_open(dist):
    app = _app()
    cathlab.mount_cathlab(app, dist)
    assert "cathlab home" in TestClient(app).get("/cathlab/").text


# --- the start menu ------------------------------------------------------------------------------

def test_the_menu_links_to_the_simulator_and_says_what_it_is_when_it_is_mounted():
    text = cathlab.menu_message(True)
    assert "(/cathlab/)" in text
    assert "not clinical training or medical advice" in text
    assert "not connected to the diagnostic pipeline" in text


def test_the_menu_explains_how_to_build_it_when_it_is_not():
    text = cathlab.menu_message(False)
    assert "/cathlab/" not in text
    for needle in ("cd simulator", "npm install", "npm run build", "restart"):
        assert needle in text
    assert "not clinical training or medical advice" in text


# --- the two halves agree --------------------------------------------------------------------------

def test_the_simulator_is_built_for_the_path_this_module_serves_it_at():
    config = (ROOT / "simulator" / "vite.config.ts").read_text(encoding="utf-8")
    assert f"base: '{cathlab.CATHLAB_URL}'" in config


def test_the_simulators_own_disclaimer_and_this_notice_say_the_same_things():
    start = (ROOT / "simulator" / "src" / "ui" / "startContent.ts").read_text(encoding="utf-8").lower()
    for phrase in ("educational", "not clinical training", "not medical advice"):
        assert phrase in start, phrase
    notice = cathlab.CATHLAB_NOTICE.lower()
    for phrase in ("educational", "not clinical training or medical advice", "not connected to the diagnostic pipeline"):
        assert phrase in notice, phrase
