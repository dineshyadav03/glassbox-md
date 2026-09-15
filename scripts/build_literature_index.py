"""Fetches PubMed abstracts for the project's six target conditions and
builds the ChromaDB literature index the Medical Knowledge RAG Agent
queries at pipeline run time.

This is an offline build step, run deliberately, not part of the live
LangGraph pipeline -- you don't want to re-fetch PubMed on every patient
case. Re-running this script is safe: `build_literature_collection` uses
upsert, so existing PMIDs are updated in place, not duplicated.

Usage:
    python scripts/build_literature_index.py [--per-condition N]

Respects PUBMED_ENTREZ_EMAIL and CHROMA_PERSIST_DIR from .env if present
(NCBI asks for a contact email with E-utilities traffic, though it isn't
strictly required for the request volume this script makes).
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from dotenv import load_dotenv  # noqa: E402

from glassbox_md.agents.medical_knowledge_rag import (  # noqa: E402
    TARGET_CONDITION_QUERIES,
    build_literature_collection,
    fetch_pubmed_abstracts,
    search_pubmed_ids,
)


def main() -> None:
    load_dotenv()

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--per-condition",
        type=int,
        default=750,
        help="Max abstracts to fetch per condition (default 750 -- ~4500 total across all six).",
    )
    args = parser.parse_args()

    email = os.environ.get("PUBMED_ENTREZ_EMAIL") or None
    persist_dir = os.environ.get("CHROMA_PERSIST_DIR", "./data/literature/chroma")

    if not email:
        print(
            "Warning: PUBMED_ENTREZ_EMAIL is not set in .env. NCBI asks for a "
            "contact email with E-utilities traffic -- proceeding without one.",
            file=sys.stderr,
        )

    total = 0
    for condition, query in TARGET_CONDITION_QUERIES.items():
        print(f"[{condition}] searching PubMed for {query} ...")
        pmids = search_pubmed_ids(query, max_results=args.per_condition, email=email)
        print(f"[{condition}] found {len(pmids)} PMID(s), fetching abstracts ...")
        abstracts = fetch_pubmed_abstracts(pmids, email=email)
        print(f"[{condition}] fetched {len(abstracts)} abstract(s) with usable text, indexing ...")
        build_literature_collection(abstracts, persist_directory=persist_dir)
        total += len(abstracts)

    print(f"Done. Indexed {total} abstract(s) total into {persist_dir!r}.")


if __name__ == "__main__":
    main()
