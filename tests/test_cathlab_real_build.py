"""The real built simulator, served the way the Glassbox app serves it.

Runs only when `simulator/dist` exists (CI builds it first; locally: `cd simulator && npm run build`).
It guards the failure the stand-in dist in test_cathlab.py cannot: a build whose asset URLs do not
match the path the app mounts it at, which would leave a blank page that every other test passes."""

import re
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from glassbox_md import cathlab

DIST = cathlab.default_dist_dir()

pytestmark = pytest.mark.skipif(
    not cathlab.is_built(DIST),
    reason="simulator/dist is not built (cd simulator && npm install && npm run build)",
)


def _client() -> TestClient:
    app = FastAPI()

    @app.get("/{full_path:path}")
    def catch_all(full_path: str) -> dict[str, str]:
        return {"page": "chat", "path": full_path}

    assert cathlab.mount_cathlab(app, DIST) is True
    return TestClient(app)


def _asset_urls(html: str) -> list[str]:
    return re.findall(r'(?:src|href)="(/cathlab/assets/[^"]+)"', html)


def test_the_start_page_is_served_and_names_assets_under_the_mount_path():
    client = _client()
    page = client.get("/cathlab/")
    assert page.status_code == 200
    assert "Cath Lab" in page.text
    urls = _asset_urls(page.text)
    assert urls, "index.html references no /cathlab/assets/ files: the build's base does not match the mount path"
    assert not re.search(r'(?:src|href)="/assets/', page.text), "an asset URL is missing the /cathlab/ prefix"


def test_every_asset_the_page_loads_is_served_with_a_sensible_type():
    client = _client()
    for url in _asset_urls(client.get("/cathlab/").text):
        response = client.get(url)
        assert response.status_code == 200, url
        assert len(response.content) > 100, url
        kind = response.headers["content-type"]
        if url.endswith(".js"):
            assert "javascript" in kind, url
        if url.endswith(".css"):
            assert "css" in kind, url


def test_the_lab_chunk_that_loads_when_someone_enters_is_served_too():
    client = _client()
    entry = next(u for u in _asset_urls(client.get("/cathlab/").text) if u.endswith(".js"))
    script = client.get(entry).text
    chunks = set(re.findall(r"labScreen-[\w-]+\.(?:js|css)", script))
    assert chunks, "the start page's script does not reference the lab chunk"
    for name in chunks:
        response = client.get(f"/cathlab/assets/{name}")
        assert response.status_code == 200, name
        assert len(response.content) > 1000, name


def test_the_start_page_keeps_the_educational_disclaimer_in_its_script():
    client = _client()
    scripts = [u for u in _asset_urls(client.get("/cathlab/").text) if u.endswith(".js")]
    text = " ".join(client.get(u).text for u in scripts)
    assert "not medical advice" in text.lower()


def test_the_built_folder_is_what_the_app_would_use_by_default():
    assert DIST == Path(__file__).resolve().parent.parent / "simulator" / "dist"
