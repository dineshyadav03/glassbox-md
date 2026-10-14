"""The real built brain-surgery simulator, served the way the Glassbox app serves it.

Runs only when `neurolab/dist` exists (CI builds it first; locally: `cd neurolab && npm run build`). It guards
the failure a stand-in dist cannot: asset URLs that do not match the path the app mounts it at, which would
leave a blank page that every other test passes."""

import re
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from glassbox_md import labs, neurolab

DIST = neurolab.LAB.default_dist_dir()

pytestmark = pytest.mark.skipif(
    not labs.is_built(DIST),
    reason="neurolab/dist is not built (cd neurolab && npm install && npm run build)",
)


def _client() -> TestClient:
    app = FastAPI()

    @app.get("/{full_path:path}")
    def catch_all(full_path: str) -> dict[str, str]:
        return {"page": "chat", "path": full_path}

    assert neurolab.mount_neurolab(app, DIST) is True
    return TestClient(app)


def _asset_urls(html: str) -> list[str]:
    return re.findall(r'(?:src|href)="(/neurolab/assets/[^"]+)"', html)


def test_the_start_page_is_served_and_names_assets_under_the_mount_path():
    page = _client().get("/neurolab/")
    assert page.status_code == 200
    assert "Brain Surgery Simulator" in page.text
    assert _asset_urls(page.text), "index.html references no /neurolab/assets/ files: the build's base does not match the mount path"
    assert not re.search(r'(?:src|href)="/assets/', page.text), "an asset URL is missing the /neurolab/ prefix"


def test_every_asset_the_page_loads_is_served_with_a_sensible_type():
    client = _client()
    for url in _asset_urls(client.get("/neurolab/").text):
        response = client.get(url)
        assert response.status_code == 200, url
        assert len(response.content) > 100, url
        if url.endswith(".js"):
            assert "javascript" in response.headers["content-type"], url


def test_the_start_page_keeps_the_educational_disclaimer_in_its_script():
    client = _client()
    scripts = [u for u in _asset_urls(client.get("/neurolab/").text) if u.endswith(".js")]
    text = " ".join(client.get(u).text for u in scripts).lower()
    assert "not medical advice" in text and "not a medical device" in text


def test_the_lab_chunk_that_loads_when_someone_enters_is_served_too():
    client = _client()
    entry = next(u for u in _asset_urls(client.get("/neurolab/").text) if u.endswith(".js"))
    chunks = set(re.findall(r"labScreen-[\w-]+\.(?:js|css)", client.get(entry).text))
    assert chunks, "the start page's script does not reference the lab chunk"
    for name in chunks:
        response = client.get(f"/neurolab/assets/{name}")
        assert response.status_code == 200, name
        assert len(response.content) > 1000, name
