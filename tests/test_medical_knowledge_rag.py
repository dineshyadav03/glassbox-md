"""Tests for the Medical Knowledge RAG Agent.

PubMed E-utilities parsing is tested against static, hand-written XML/JSON
fixtures with the network call monkeypatched out -- the test suite
shouldn't depend on NCBI being reachable or PubMed's live content being
stable. ChromaDB indexing and retrieval use the real library against a
pytest tmp_path (no mocking) since that's fast, local, and exercises the
actual embedding + similarity search path.
"""

import json

import chromadb
import pytest

from glassbox_md.agents import medical_knowledge_rag as rag_module
from glassbox_md.agents.medical_knowledge_rag import (
    build_literature_collection,
    fetch_pubmed_abstracts,
    medical_knowledge_rag_agent,
    query_literature,
    search_pubmed_ids,
)
from glassbox_md.state import new_stage_status

_FAKE_ESEARCH_JSON = json.dumps({"esearchresult": {"idlist": ["12345678", "23456789"]}}).encode()

_FAKE_EFETCH_XML = b"""<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <PMID>12345678</PMID>
      <Article>
        <ArticleTitle>Glycemic control in type 2 diabetes</ArticleTitle>
        <Abstract>
          <AbstractText>This study examines glycemic control in patients with type 2 diabetes.</AbstractText>
        </Abstract>
      </Article>
    </MedlineCitation>
  </PubmedArticle>
  <PubmedArticle>
    <MedlineCitation>
      <PMID>23456789</PMID>
      <Article>
        <ArticleTitle>Editorial: a brief note</ArticleTitle>
      </Article>
    </MedlineCitation>
  </PubmedArticle>
</PubmedArticleSet>
"""


@pytest.fixture
def fake_eutils(monkeypatch):
    def _fake(endpoint, params):
        if endpoint == "esearch.fcgi":
            return _FAKE_ESEARCH_JSON
        if endpoint == "efetch.fcgi":
            return _FAKE_EFETCH_XML
        raise ValueError(f"unexpected endpoint in test: {endpoint}")

    monkeypatch.setattr(rag_module, "_eutils_request", _fake)


def _base_state(**overrides):
    state = {"structured_clinical_data": {}, "stage_status": new_stage_status(), "audit_log": []}
    state.update(overrides)
    return state


# --- PubMed E-utilities parsing (network mocked) ----------------------------

def test_search_pubmed_ids_parses_esearch_json(fake_eutils):
    ids = search_pubmed_ids('"type 2 diabetes"[Title/Abstract]', max_results=10)
    assert ids == ["12345678", "23456789"]


def test_fetch_pubmed_abstracts_parses_efetch_xml(fake_eutils):
    abstracts = fetch_pubmed_abstracts(["12345678", "23456789"])
    assert len(abstracts) == 1  # the editorial with no AbstractText is skipped
    assert abstracts[0]["pmid"] == "12345678"
    assert "glycemic control" in abstracts[0]["abstract"].lower()
    assert abstracts[0]["url"] == "https://pubmed.ncbi.nlm.nih.gov/12345678/"


def test_fetch_pubmed_abstracts_empty_id_list_returns_empty(fake_eutils):
    assert fetch_pubmed_abstracts([]) == []


# --- ChromaDB indexing + retrieval (real library, local tmp dir) -----------

def test_build_and_query_roundtrip(tmp_path):
    abstracts = [
        {
            "pmid": "111",
            "title": "Type 2 diabetes and glycemic control",
            "abstract": "Glucose management improves outcomes in type 2 diabetes patients.",
            "url": "https://pubmed.ncbi.nlm.nih.gov/111/",
        },
        {
            "pmid": "222",
            "title": "Coronary artery disease risk stratification",
            "abstract": "Risk factors for coronary artery disease include hypertension and hyperlipidemia.",
            "url": "https://pubmed.ncbi.nlm.nih.gov/222/",
        },
    ]
    collection = build_literature_collection(abstracts, persist_directory=str(tmp_path))

    citations = query_literature(collection, "glucose control in diabetes patients", n_results=1)

    assert len(citations) == 1
    assert citations[0]["source_id"] == "111"
    assert citations[0]["url"] == "https://pubmed.ncbi.nlm.nih.gov/111/"


def test_query_literature_on_empty_collection_returns_empty(tmp_path):
    client = chromadb.PersistentClient(path=str(tmp_path))
    collection = client.get_or_create_collection("empty_test")
    assert query_literature(collection, "anything") == []


def test_build_literature_collection_upsert_is_idempotent(tmp_path):
    v1 = [{"pmid": "111", "title": "V1 title", "abstract": "original text", "url": "https://pubmed.ncbi.nlm.nih.gov/111/"}]
    build_literature_collection(v1, persist_directory=str(tmp_path))

    v2 = [{"pmid": "111", "title": "V2 title", "abstract": "updated text", "url": "https://pubmed.ncbi.nlm.nih.gov/111/"}]
    collection = build_literature_collection(v2, persist_directory=str(tmp_path))

    assert collection.count() == 1
    fetched = collection.get(ids=["111"])
    assert fetched["metadatas"][0]["title"] == "V2 title"


# --- medical_knowledge_rag_agent (the LangGraph node) -----------------------

def test_agent_needs_review_with_no_structured_clinical_data():
    """No text to build a literature query with (e.g. an imaging-only
    case, no labs/history) is a degraded result, not a fatal one -- it
    must not halt the pipeline before Diagnostic Prediction gets a
    chance to reason over the image itself. See the module docstring."""
    result = medical_knowledge_rag_agent(_base_state())
    assert result["stage_status"]["medical_knowledge_rag"]["status"] == "needs_review"
    assert result["rag_literature_context"] == []


def test_agent_retrieves_citations_for_a_case(tmp_path):
    abstracts = [
        {
            "pmid": "111",
            "title": "Type 2 diabetes management",
            "abstract": "Glucose control strategies for type 2 diabetes patients.",
            "url": "https://pubmed.ncbi.nlm.nih.gov/111/",
        }
    ]
    collection = build_literature_collection(abstracts, persist_directory=str(tmp_path))
    state = _base_state(
        structured_clinical_data={
            "labs": {"glucose": {"value": 6.9, "unit": "mmol/L"}},
            "history_text": "Patient has type 2 diabetes.",
        }
    )

    result = medical_knowledge_rag_agent(state, collection=collection)

    assert result["stage_status"]["medical_knowledge_rag"]["status"] == "ok"
    assert len(result["rag_literature_context"]) == 1
    assert result["rag_literature_context"][0]["source_id"] == "111"


def test_agent_needs_review_when_collection_is_empty(tmp_path):
    client = chromadb.PersistentClient(path=str(tmp_path))
    collection = client.get_or_create_collection("empty")
    state = _base_state(structured_clinical_data={"history_text": "Patient has type 2 diabetes."})

    result = medical_knowledge_rag_agent(state, collection=collection)

    assert result["stage_status"]["medical_knowledge_rag"]["status"] == "needs_review"
    assert result["rag_literature_context"] == []


def test_agent_preserves_other_stages_status(tmp_path):
    collection = build_literature_collection(
        [{"pmid": "1", "title": "t", "abstract": "a", "url": "u"}], persist_directory=str(tmp_path)
    )
    state = _base_state(structured_clinical_data={"history_text": "diabetes"})
    state["stage_status"]["privacy_protection"] = {"status": "ok", "message": None}

    result = medical_knowledge_rag_agent(state, collection=collection)

    assert result["stage_status"]["privacy_protection"] == {"status": "ok", "message": None}
