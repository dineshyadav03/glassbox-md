"""Medical Knowledge RAG Agent.

Fourth in pipeline order. Populates `rag_literature_context` by querying a
ChromaDB collection of PubMed abstracts, built ahead of time (see
`scripts/build_literature_index.py`), against the patient's structured
clinical data -- not by fetching literature live on every pipeline run.

Scope: the same two conditions as the Data Preparation Agent (type 2
diabetes, coronary artery disease) -- retrieving literature for a
condition this MVP has no labs or terminology normalization for wouldn't
be useful context anyway.

V2: a real, checkable patient -> controlled vocabulary -> literature
match, not just the V1 flat vector search. The architecture critique's
3-tier graph recommendation named UMLS as the controlled-vocabulary
tier; this project doesn't have a UTS license, so it uses PubMed's own
MeSH indexing instead (public domain, and already present in every
EFetch response this module fetches -- see fetch_pubmed_abstracts's
mesh_ids parsing). controlled_vocabulary.py maps this project's 6
canonical clinical terms to their real MeSH Descriptor UIs (verified
live against NCBI, not typed from memory). `query_literature_by_concept`
retrieves literature genuinely MeSH-tagged under the same concept the
patient's data maps to -- real traceability, not embedding proximity --
and every citation records which canonical term produced it (or `None`
for a plain similarity match) via `Citation.matched_concept`.

Still not the full UMLS-backed graph the critique described: 6 terms,
not a real ontology; a Python-side linear scan over the whole corpus for
concept eligibility (fine at this MVP's few-thousand-abstract scale,
documented as a V3 scalability item -- a real inverted index would be
needed an order of magnitude up, same kind of explicit cap as
MAX_IMAGES_PER_CALL elsewhere in this codebase); and it degrades
gracefully to exactly the old flat-similarity behavior whenever a
patient's data names no known canonical term, or a stored abstract has
no MeSH tags yet (a very recent article, or an index built before this
change -- re-running build_literature_index.py, already idempotent via
upsert, backfills it). Every retrieved passage still carries its PMID,
title, and PubMed URL either way, so a citation can always be checked
against its actual source.

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
from .controlled_vocabulary import CANONICAL_TERM_MESH_IDS, match_canonical_terms

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
    mesh_ids: list[str]


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
            # Real MeSH indexing, when present -- an article too recent to
            # be MeSH-indexed yet naturally yields [], same "degrade
            # gracefully" treatment as everywhere else in this pipeline.
            mesh_ids = list(
                dict.fromkeys(
                    descriptor.get("UI", "")
                    for descriptor in article.findall(".//MeshHeadingList/MeshHeading/DescriptorName")
                    if descriptor.get("UI")
                )
            )

            if pmid and abstract:
                results.append(
                    PubMedAbstract(
                        pmid=pmid,
                        title=title,
                        abstract=abstract,
                        url=f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
                        mesh_ids=mesh_ids,
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
            metadatas=[
                {
                    "pmid": a["pmid"],
                    "title": a["title"],
                    "url": a["url"],
                    # Comma-joined: Chroma metadata values must be scalar.
                    # `.get()`, not `a["mesh_ids"]` -- pre-V2 callers (most
                    # test fixtures) pass raw dicts with no "mesh_ids" key
                    # at all, and must not KeyError here.
                    "mesh_ids": ",".join(a.get("mesh_ids") or []),
                }
                for a in abstracts
            ],
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
                matched_concept=None,
            )
        )
    return citations


def query_literature_by_concept(
    collection: Collection, query_text: str, concept_ids: dict[str, str], n_results: int = 5
) -> list[Citation]:
    """Tier-2-to-tier-3 retrieval: literature whose stored `mesh_ids`
    metadata contains at least one of the patient's matched concept IDs
    (`concept_ids`, canonical term -> real MeSH Descriptor UI -- see
    controlled_vocabulary.py), ranked by embedding similarity within
    that eligible subset. Every returned Citation's `matched_concept` is
    the canonical term it was retrieved for -- real, checkable
    traceability, not just "these embeddings are close."

    Two Chroma calls, not one: `where` has no substring-containment
    operator for the comma-joined `mesh_ids` string, so eligibility is
    found via a Python-side linear scan of the collection's metadata
    first (cheap at this MVP's scale -- a few thousand abstracts at
    most, per build_literature_index.py's own defaults; a real inverted
    index would be needed at 10x that, see this module's docstring).
    Ranking then reuses `collection.query(..., where={"pmid": {"$in":
    ...}})` -- `$in` on an exact scalar value IS a normal, stable part
    of Chroma's `where` DSL, unlike substring containment.

    Returns [] if the collection is empty, no concept_ids were given, no
    query text, or nothing in the corpus matches any of them.
    """
    count = collection.count()
    if count == 0 or not concept_ids or not query_text.strip():
        return []

    wanted_mesh_ids = set(concept_ids.values())
    term_by_mesh_id = {mesh_id: term for term, mesh_id in concept_ids.items()}

    all_metadata = collection.get(include=["metadatas"])["metadatas"]
    eligible_pmids: list[str] = []
    matched_term_by_pmid: dict[str, str] = {}
    for metadata in all_metadata:
        stored_mesh_ids = set(filter(None, (metadata.get("mesh_ids") or "").split(",")))
        hit = stored_mesh_ids & wanted_mesh_ids
        if hit:
            pmid = metadata["pmid"]
            eligible_pmids.append(pmid)
            # An abstract can be MeSH-tagged with more than one of the
            # patient's matched concepts -- label it with one,
            # deterministically, rather than an arbitrary set order.
            # Doesn't affect eligibility, only which term gets credited.
            matched_term_by_pmid[pmid] = term_by_mesh_id[sorted(hit)[0]]

    if not eligible_pmids:
        return []

    results = collection.query(
        query_texts=[query_text],
        n_results=min(n_results, len(eligible_pmids)),
        where={"pmid": {"$in": eligible_pmids}},
    )
    documents = results.get("documents") or [[]]
    metadatas = results.get("metadatas") or [[]]

    return [
        Citation(
            source_id=metadata["pmid"],
            title=metadata["title"],
            url=metadata["url"],
            passage=passage,
            matched_concept=matched_term_by_pmid[metadata["pmid"]],
        )
        for passage, metadata in zip(documents[0], metadatas[0])
    ]


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

    citations: list[Citation] = []
    concept_matched_count = 0
    if query_text.strip():
        matched_terms = match_canonical_terms(query_text)
        concept_ids = {term: CANONICAL_TERM_MESH_IDS[term] for term in matched_terms}
        if concept_ids:
            citations = query_literature_by_concept(collection, query_text, concept_ids, n_results=5)
            concept_matched_count = len(citations)

        # Top up to 5 with flat similarity search -- covers both "no
        # canonical term present at all" (concept_ids empty, full
        # fallback) and "concept match found fewer than 5" (a partial
        # top-up). Over-fetch by the number already found as a cheap
        # buffer against overlap; a slight shortfall of the 5-result cap
        # in a heavily-overlapping corpus is an acceptable MVP
        # imprecision, not worth a more elaborate top-up algorithm.
        remaining = 5 - len(citations)
        if remaining > 0:
            seen_ids = {c["source_id"] for c in citations}
            fallback = query_literature(collection, query_text, n_results=remaining + len(seen_ids))
            for citation in fallback:
                if citation["source_id"] not in seen_ids:
                    citations.append(citation)
                    seen_ids.add(citation["source_id"])
                if len(citations) >= 5:
                    break

    if not citations:
        message = (
            "no clinical text to query literature with" if not query_text.strip() else "no matching literature found for this case"
        )
        status = {"status": "needs_review", "message": message}
        summary = message
    else:
        status = {"status": "ok", "message": None}
        summary = f"retrieved {len(citations)} literature citation(s) ({concept_matched_count} concept-matched)"

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
