"""The shared lab mounting (`labs.py`) and the brain-surgery lab on top of it: two simulators served side by
side ahead of a catch-all, each at its own path, behind the same login, with the right menu wording."""

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from glassbox_md import cathlab, labs, neurolab

ROOT = Path(__file__).resolve().parent.parent


def _app() -> FastAPI:
    app = FastAPI()

    @app.get("/{full_path:path}")
    def catch_all(full_path: str) -> dict[str, str]:
        return {"page": "chat", "path": full_path}

    return app


def _dist(base: Path, name: str) -> Path:
    folder = base / name / "dist"
    folder.mkdir(parents=True)
    (folder / "index.html").write_text(f"<html>{name} home</html>", encoding="utf-8")
    return folder


def test_each_lab_lives_in_its_own_folder_and_path():
    assert cathlab.LAB.path == "/cathlab" and cathlab.LAB.folder == "simulator"
    assert neurolab.LAB.path == "/neurolab" and neurolab.LAB.folder == "neurolab"
    assert neurolab.LAB.default_dist_dir() == ROOT / "neurolab" / "dist"
    assert neurolab.NEUROLAB_URL == "/neurolab/"


def test_two_labs_are_served_side_by_side_ahead_of_the_catch_all(tmp_path):
    app = _app()
    assert cathlab.mount_cathlab(app, _dist(tmp_path, "cath")) is True
    assert neurolab.mount_neurolab(app, _dist(tmp_path, "neuro")) is True
    client = TestClient(app)
    assert "cath home" in client.get("/cathlab/").text
    assert "neuro home" in client.get("/neurolab/").text
    assert client.get("/neurolab", follow_redirects=False).headers["location"] == "/neurolab/"
    assert client.get("/something-else").json()["page"] == "chat"


def test_an_unbuilt_lab_changes_nothing(tmp_path):
    app = _app()
    before = list(app.router.routes)
    assert neurolab.mount_neurolab(app, tmp_path / "missing") is False
    assert app.router.routes == before


def test_the_login_gate_covers_the_new_lab_and_needs_both_hooks(tmp_path):
    app = _app()
    neurolab.mount_neurolab(
        app, _dist(tmp_path, "neuro"), token_from_cookies=lambda c: c.get("t"), is_valid=lambda t: t == "good"
    )
    client = TestClient(app)
    refused = client.get("/neurolab/", follow_redirects=False)
    assert refused.status_code == 302 and refused.headers["location"] == labs.LOGIN_PATH
    assert "neuro home" in client.get("/neurolab/", cookies={"t": "good"}).text
    with pytest.raises(ValueError):
        neurolab.mount_neurolab(_app(), _dist(tmp_path, "other"), is_valid=lambda t: True)


def test_the_menu_entry_links_when_built_and_says_how_to_build_when_not():
    built = neurolab.menu_message(True)
    assert "(/neurolab/)" in built and "Brain surgery simulator" in built
    missing = neurolab.menu_message(False)
    assert "cd neurolab" in missing and "npm run build" in missing


def test_the_menu_entry_carries_the_educational_notice_either_way():
    for mounted in (True, False):
        text = neurolab.menu_message(mounted)
        for phrase in ("Educational demonstration only", "not clinical training", "not a medical device", "not medical advice"):
            assert phrase in text


def test_the_cath_lab_keeps_its_own_wording():
    assert "Cath lab simulator" in cathlab.menu_message(True)
    assert "cd simulator" in cathlab.menu_message(False)
