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
from glassbox_md.agents.controlled_vocabulary import CANONICAL_TERM_MESH_IDS
from glassbox_md.agents.medical_knowledge_rag import (
    build_literature_collection,
    fetch_pubmed_abstracts,
    medical_knowledge_rag_agent,
    query_literature,
    query_literature_by_concept,
    search_pubmed_ids,
)
from glassbox_md.state import new_stage_status

_FAKE_ESEARCH_JSON = json.dumps({"esearchresult": {"idlist": ["12345678", "23456789"]}}).encode()

_T2D_MESH_ID = CANONICAL_TERM_MESH_IDS["type 2 diabetes"]

# PMID 12345678 carries a real-shaped MeshHeadingList (the "Diabetes
# Mellitus, Type 2" descriptor); PMID 23456789 has none -- its own
# article has no AbstractText either, so it's excluded from results
# regardless, but this also stands in for "an article with no MeSH
# indexing yet" for the mesh_ids-specific tests below.
_FAKE_EFETCH_XML = f"""<?xml version="1.0"?>
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
      <MeshHeadingList>
        <MeshHeading>
          <DescriptorName UI="{_T2D_MESH_ID}">Diabetes Mellitus, Type 2</DescriptorName>
        </MeshHeading>
      </MeshHeadingList>
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
""".encode()

# A second article, with an abstract but genuinely no MeshHeadingList --
# the "too recent to be MeSH-indexed yet" case.
_FAKE_EFETCH_XML_NO_MESH = b"""<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <PMID>99999999</PMID>
      <Article>
        <ArticleTitle>A very recent preprint-adjacent article</ArticleTitle>
        <Abstract>
          <AbstractText>Not yet indexed against any controlled vocabulary.</AbstractText>
        </Abstract>
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


def test_fetch_pubmed_abstracts_parses_mesh_ids(fake_eutils):
    abstracts = fetch_pubmed_abstracts(["12345678", "23456789"])
    assert abstracts[0]["mesh_ids"] == [_T2D_MESH_ID]


def test_fetch_pubmed_abstracts_defaults_to_empty_mesh_ids_when_absent(monkeypatch):
    monkeypatch.setattr(rag_module, "_eutils_request", lambda endpoint, params: _FAKE_EFETCH_XML_NO_MESH)
    abstracts = fetch_pubmed_abstracts(["99999999"])
    assert abstracts[0]["mesh_ids"] == []


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


def test_build_literature_collection_stores_mesh_ids_metadata(tmp_path):
    abstracts = [
        {
            "pmid": "111",
            "title": "T2D",
            "abstract": "a",
            "url": "https://pubmed.ncbi.nlm.nih.gov/111/",
            "mesh_ids": [_T2D_MESH_ID, CANONICAL_TERM_MESH_IDS["hypertension"]],
        }
    ]
    collection = build_literature_collection(abstracts, persist_directory=str(tmp_path))

    fetched = collection.get(ids=["111"])
    assert fetched["metadatas"][0]["mesh_ids"] == f"{_T2D_MESH_ID},{CANONICAL_TERM_MESH_IDS['hypertension']}"


def test_build_literature_collection_handles_missing_mesh_ids_key(tmp_path):
    # A raw dict literal exactly like the ~20 existing test fixtures
    # elsewhere in this suite, predating the mesh_ids field -- must not
    # KeyError.
    abstracts = [{"pmid": "111", "title": "t", "abstract": "a", "url": "u"}]
    collection = build_literature_collection(abstracts, persist_directory=str(tmp_path))

    fetched = collection.get(ids=["111"])
    assert fetched["metadatas"][0]["mesh_ids"] == ""


# --- query_literature_by_concept (concept-eligible, similarity-ranked) -----

def _abstract(pmid, title, abstract, mesh_ids=None):
    return {
        "pmid": pmid,
        "title": title,
        "abstract": abstract,
        "url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
        "mesh_ids": mesh_ids or [],
    }


def test_query_literature_by_concept_returns_matched_citations_with_label(tmp_path):
    t2d_id = CANONICAL_TERM_MESH_IDS["type 2 diabetes"]
    abstracts = [
        _abstract("111", "T2D management", "Glucose control strategies.", mesh_ids=[t2d_id]),
        _abstract("222", "Unrelated topic", "Something about knee surgery outcomes."),
    ]
    collection = build_literature_collection(abstracts, persist_directory=str(tmp_path))

    citations = query_literature_by_concept(
        collection, "glucose control", {"type 2 diabetes": t2d_id}, n_results=5
    )

    assert len(citations) == 1
    assert citations[0]["source_id"] == "111"
    assert citations[0]["matched_concept"] == "type 2 diabetes"


def test_query_literature_by_concept_empty_for_empty_concept_ids(tmp_path):
    collection = build_literature_collection(
        [_abstract("111", "t", "a")], persist_directory=str(tmp_path)
    )
    assert query_literature_by_concept(collection, "anything", {}, n_results=5) == []


def test_query_literature_by_concept_empty_when_no_abstract_matches(tmp_path):
    abstracts = [_abstract("111", "t", "a", mesh_ids=[CANONICAL_TERM_MESH_IDS["hypertension"]])]
    collection = build_literature_collection(abstracts, persist_directory=str(tmp_path))

    t2d_id = CANONICAL_TERM_MESH_IDS["type 2 diabetes"]
    citations = query_literature_by_concept(collection, "diabetes", {"type 2 diabetes": t2d_id}, n_results=5)
    assert citations == []


def test_query_literature_by_concept_empty_on_empty_collection(tmp_path):
    client = chromadb.PersistentClient(path=str(tmp_path))
    collection = client.get_or_create_collection("empty_concept_test")
    t2d_id = CANONICAL_TERM_MESH_IDS["type 2 diabetes"]
    assert query_literature_by_concept(collection, "diabetes", {"type 2 diabetes": t2d_id}, n_results=5) == []


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


# --- medical_knowledge_rag_agent: MeSH concept matching (V2) ---------------

def test_agent_labels_concept_matched_citation(tmp_path):
    t2d_id = CANONICAL_TERM_MESH_IDS["type 2 diabetes"]
    abstracts = [_abstract("111", "T2D management", "Glucose control strategies.", mesh_ids=[t2d_id])]
    collection = build_literature_collection(abstracts, persist_directory=str(tmp_path))
    # "type 2 diabetes" -- the canonical form, as normalize_terminology()
    # would already have produced upstream in Data Preparation.
    state = _base_state(structured_clinical_data={"history_text": "Patient has type 2 diabetes."})

    result = medical_knowledge_rag_agent(state, collection=collection)

    assert result["stage_status"]["medical_knowledge_rag"]["status"] == "ok"
    assert len(result["rag_literature_context"]) == 1
    assert result["rag_literature_context"][0]["matched_concept"] == "type 2 diabetes"
    assert "1 concept-matched" in result["audit_log"][0]["summary"]


def test_agent_tops_up_with_similarity_when_concept_matches_fall_short_of_n_results(tmp_path):
    t2d_id = CANONICAL_TERM_MESH_IDS["type 2 diabetes"]
    abstracts = [
        _abstract("111", "T2D management", "Glucose control strategies for diabetes.", mesh_ids=[t2d_id]),
        _abstract("222", "General diabetes overview", "A broad overview of diabetes care."),
        _abstract("333", "Diabetes and diet", "Nutrition strategies relevant to diabetes."),
    ]
    collection = build_literature_collection(abstracts, persist_directory=str(tmp_path))
    state = _base_state(structured_clinical_data={"history_text": "Patient has type 2 diabetes."})

    result = medical_knowledge_rag_agent(state, collection=collection)

    citations = result["rag_literature_context"]
    assert len(citations) <= 5
    assert any(c["matched_concept"] == "type 2 diabetes" for c in citations)
    assert len({c["source_id"] for c in citations}) == len(citations)  # no duplicates


def test_agent_falls_back_to_flat_similarity_when_no_canonical_term_present(tmp_path):
    # Names a condition entirely outside the 6 canonical terms -- proves
    # V1 behavior (flat similarity, no concept traceability) still holds
    # unchanged for anything outside this project's small vocabulary.
    abstracts = [
        _abstract("111", "Knee osteoarthritis", "Management of knee osteoarthritis in older adults.")
    ]
    collection = build_literature_collection(abstracts, persist_directory=str(tmp_path))
    state = _base_state(structured_clinical_data={"history_text": "Patient has knee osteoarthritis."})

    result = medical_knowledge_rag_agent(state, collection=collection)

    citations = result["rag_literature_context"]
    assert len(citations) == 1
    assert citations[0]["matched_concept"] is None
    assert "0 concept-matched" in result["audit_log"][0]["summary"]
