"""Test isolation from the developer's local model settings.

Several test modules call `load_dotenv()`, so whatever a developer keeps in `.env`
ends up in `os.environ`. Once `.env` can point the app at a local model
(`LLM_BASE_URL`, `OPENROUTER_MODEL=medgemma1.5:4b`) or an evidence-check judge
(`DECISION_BASE_URL`), that leaks into tests that assume the defaults: a CLI test
that expects "no API key" to refuse to start passed only when no local URL was set,
and the "live OpenRouter" smoke test would have quietly called a local model
instead. Every test starts from the defaults; a test that needs a setting sets it.
"""

import pytest

_LOCAL_MODEL_SETTINGS = (
    "LLM_BASE_URL",
    "LLM_API_KEY",
    "LLM_TIMEOUT_SECONDS",
    "DECISION_BASE_URL",
    "DECISION_MODEL",
    "DECISION_API_KEY",
    "DECISION_TIMEOUT_SECONDS",
)


@pytest.fixture(autouse=True)
def _isolate_from_local_model_settings(monkeypatch):
    for name in _LOCAL_MODEL_SETTINGS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("OPENROUTER_MODEL", "openrouter/free")
