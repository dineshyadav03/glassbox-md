"""Medical Knowledge RAG Agent.

Fourth in pipeline order. Populates `rag_literature_context` by querying a
ChromaDB collection of PubMed abstracts, built ahead of time (see
`scripts/build_literature_index.py`), against the patient's structured
clinical data -- not by fetching literature live on every pipeline run.

Scope: the same two conditions as the Data Preparation Agent (type 2
diabetes, coronary artery disease) -- retrieving literature for a
condition this MVP has no labs or terminology normalization for wouldn't
be useful context anyway.

MVP design, not yet MedGraphRAG-style: flat vector similarity over roughly
500-2,000 PubMed abstracts, per the roadmap's phased plan. The 3-tier
graph (patient -> literature -> UMLS) the architecture critique
recommended is a V2 item. What this agent does do, as a partial,
honestly-scoped step toward that traceability goal even in the flat
version: every retrieved passage carries its PMID, title, and PubMed URL,
so a citation can be checked against its actual source rather than just
trusted -- see `rag_literature_context`'s `Citation` shape in state.py.

Two dependency swaps from the roadmap's original plan, both for the same
reason as earlier phases -- real functionality, smaller footprint:

  - PubMed fetching uses the E-utilities REST API directly (stdlib
    urllib + xml.etree + json), not biopython. Biopython's Entrez module
    is a thin wrapper over the same two HTTP endpoints (esearch, efetch);
    calling them directly avoids a dependency for two URLs.
  - Embeddings use ChromaDB's bundled `DefaultEmbeddingFunction` -- an
    ONNX all-MiniLM-L6-v2 model run via onnxruntime, which chromadb
    already installs -- instead of sentence-transformers. Both are
    "local embeddings, no per-call API cost"; chromadb's version gets
    there without adding torch as a second ML runtime.

Abstracts are short enough (typically a few hundred words) to embed as
one chunk each for this MVP -- no sliding-window chunking. A V2 indexing
full-text articles instead of abstracts would need real chunking.

A case with no lab values or history text (imaging alone -- an MRI or
X-ray with nothing else attached) never hard-fails here. An earlier
version of this agent returned `failed` when it had no text to build a
literature query from, which -- per the pipeline's conditional routing --
halted the entire graph before the Diagnostic Prediction agent ever got
a chance to reason over the image itself, silently defeating the whole
multimodal design for imaging-only cases. "Nothing to retrieve" is now
treated the same as "retrieved and found nothing": `needs_review` with
an empty citation list, which lets the pipeline continue.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from typing import Any, TypedDict

import chromadb
from chromadb import Collection

from ..audit import audit_entry
from ..state import Citation, MedicalPipelineState, update_stage_status

STAGE_NAME = "medical_knowledge_rag"

_EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
_TOOL_NAME = "glassbox-md"
_NCBI_RATE_LIMIT_DELAY_SECONDS = 0.34  # stays under 3 req/sec without an API key

DEFAULT_COLLECTION_NAME = "medical_literature"

# The same two conditions Data Preparation and the Privacy agent's
# terminology map are scoped to. PubMed's [Title/Abstract] field tag
# keeps the search reasonably precise without requiring exact MeSH term
# validation, which would add another moving part for an MVP corpus.
TARGET_CONDITION_QUERIES = {
    "type_2_diabetes": '"type 2 diabetes"[Title/Abstract]',
    "coronary_artery_disease": '"coronary artery disease"[Title/Abstract]',
}


class PubMedAbstract(TypedDict):
    pmid: str
    title: str
    abstract: str
    url: str


def _eutils_request(endpoint: str, params: dict[str, str]) -> bytes:
    query = urllib.parse.urlencode({**params, "tool": _TOOL_NAME})
    url = f"{_EUTILS_BASE}/{endpoint}?{query}"
    with urllib.request.urlopen(url, timeout=30) as response:  # noqa: S310 -- fixed, hardcoded NCBI host
        return response.read()


def search_pubmed_ids(query: str, max_results: int, email: str | None = None) -> list[str]:
    """ESearch: resolve a PubMed query to a list of PMIDs."""
    params = {"db": "pubmed", "term": query, "retmax": str(max_results), "retmode": "json"}
    if email:
        params["email"] = email
    body = _eutils_request("esearch.fcgi", params)
    data = json.loads(body)
    return data.get("esearchresult", {}).get("idlist", [])


def fetch_pubmed_abstracts(
    pmids: list[str], email: str | None = None, batch_size: int = 200
) -> list[PubMedAbstract]:
    """EFetch: pull title + abstract for a list of PMIDs, batched per
    NCBI's guidance (a few hundred IDs per call, not one call per ID).
    A PMID with no abstract text (common for editorials, letters) is
    skipped -- there's nothing to embed or cite."""
    results: list[PubMedAbstract] = []
    for i in range(0, len(pmids), batch_size):
        batch = pmids[i : i + batch_size]
        params = {"db": "pubmed", "id": ",".join(batch), "rettype": "abstract", "retmode": "xml"}
        if email:
            params["email"] = email
        body = _eutils_request("efetch.fcgi", params)
        root = ET.fromstring(body)

        for article in root.findall(".//PubmedArticle"):
            pmid_el = article.find(".//PMID")
            title_el = article.find(".//ArticleTitle")
            abstract_parts = article.findall(".//AbstractText")

            pmid = pmid_el.text.strip() if pmid_el is not None and pmid_el.text else ""
            title = "".join(title_el.itertext()).strip() if title_el is not None else ""
            abstract = " ".join("".join(part.itertext()) for part in abstract_parts).strip()

            if pmid and abstract:
                results.append(
                    PubMedAbstract(
                        pmid=pmid,
                        title=title,
                        abstract=abstract,
                        url=f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
                    )
                )

        if i + batch_size < len(pmids):
            time.sleep(_NCBI_RATE_LIMIT_DELAY_SECONDS)

    return results


def build_literature_collection(
    abstracts: list[PubMedAbstract],
    persist_directory: str,
    collection_name: str = DEFAULT_COLLECTION_NAME,
) -> Collection:
    """Embed and upsert abstracts into a persisted ChromaDB collection.
    Upsert (not add) so re-running the index build is idempotent --
    fetching the same PMID twice updates its entry instead of duplicating it.
    """
    client = chromadb.PersistentClient(path=persist_directory)
    collection = client.get_or_create_collection(collection_name)
    if abstracts:
        collection.upsert(
            ids=[a["pmid"] for a in abstracts],
            documents=[f"{a['title']}\n{a['abstract']}" for a in abstracts],
            metadatas=[{"pmid": a["pmid"], "title": a["title"], "url": a["url"]} for a in abstracts],
        )
    return collection


def query_literature(collection: Collection, query_text: str, n_results: int = 5) -> list[Citation]:
    """Similarity search against an already-built collection. Returns []
    on an empty collection rather than letting chromadb raise -- an
    unbuilt index is a configuration issue for the caller to surface, not
    a crash in the retrieval path."""
    count = collection.count()
    if count == 0 or not query_text.strip():
        return []

    results = collection.query(query_texts=[query_text], n_results=min(n_results, count))
    documents = results.get("documents") or [[]]
    metadatas = results.get("metadatas") or [[]]

    citations: list[Citation] = []
    for passage, metadata in zip(documents[0], metadatas[0]):
        citations.append(
            Citation(
                source_id=metadata["pmid"],
                title=metadata["title"],
                url=metadata["url"],
                passage=passage,
            )
        )
    return citations


def _build_query_text(structured_clinical_data: dict[str, Any]) -> str:
    """Turn structured labs + normalized history text into one query
    string for similarity search."""
    parts: list[str] = []
    history = structured_clinical_data.get("history_text", "")
    if history:
        parts.append(history)
    for name, lab in (structured_clinical_data.get("labs") or {}).items():
        parts.append(f"{name.replace('_', ' ')} {lab['value']} {lab['unit']}")
    return "; ".join(parts)


def medical_knowledge_rag_agent(
    state: MedicalPipelineState, collection: Collection | None = None
) -> dict[str, Any]:
    """The LangGraph node. `collection` is injectable (an in-memory or
    fixture collection instead of the persisted literature index) --
    this agent's job is building the query and shaping results, not
    owning the collection's lifecycle or its build process.
    """
    structured = state.get("structured_clinical_data") or {}
    query_text = _build_query_text(structured)

    # No text to search literature with is a degraded result, not a fatal
    # one -- a case with imaging but no labs/history (an MRI or X-ray
    # alone) has nothing for THIS agent to retrieve, but that must not
    # block the Diagnostic Prediction agent from reasoning over the image
    # itself. Skip the query and fall through to the same "no citations
    # found" needs_review path used when a real search comes back empty,
    # rather than hard-failing and halting the whole pipeline here.
    if collection is None:
        collection = _default_collection()

    citations = query_literature(collection, query_text, n_results=5) if query_text.strip() else []

    if not citations:
        message = (
            "no clinical text to query literature with" if not query_text.strip() else "no matching literature found for this case"
        )
        status = {"status": "needs_review", "message": message}
        summary = message
    else:
        status = {"status": "ok", "message": None}
        summary = f"retrieved {len(citations)} literature citation(s)"

    return {
        "rag_literature_context": citations,
        "stage_status": update_stage_status(state, STAGE_NAME, status),
        "audit_log": [audit_entry(STAGE_NAME, summary)],
    }


def _default_collection() -> Collection:
    import os

    persist_dir = os.environ.get("CHROMA_PERSIST_DIR", "./data/literature/chroma")
    client = chromadb.PersistentClient(path=persist_dir)
    return client.get_or_create_collection(DEFAULT_COLLECTION_NAME)
