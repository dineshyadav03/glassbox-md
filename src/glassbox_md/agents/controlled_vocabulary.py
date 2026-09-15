"""Controlled-vocabulary tier (tier 2) of the patient -> controlled
vocabulary -> literature graph described in medical_knowledge_rag.py's
module docstring.

Maps this project's own 8 canonical clinical terms (the values of
data_preparation.TERMINOLOGY_MAP) to their real PubMed MeSH Descriptor
UIs. Every ID below was resolved live against NCBI's E-utilities during
development -- either by reading the actual `DescriptorName UI` off a
real on-topic PubMed article's MeshHeadingList, or, for terms narrow
enough that no sampled article happened to show them, by querying
`db=mesh` directly and cross-checking the returned `ds_meshui` against
its own entry-term list -- never typed from memory or invented. No
UMLS/UTS license needed: MeSH is public domain, and it's the exact
vocabulary PubMed already indexes every fetched abstract against (see
fetch_pubmed_abstracts's MeshHeadingList parsing), so this tier adds no
separate ontology client or API key.

Deliberately no import of data_preparation.TERMINOLOGY_MAP here to
auto-derive this dict's keys -- no agent module in this project imports
another (each only imports from ..audit / ..state). Kept explicit and
guarded instead: test_controlled_vocabulary.py asserts this dict's keys
exactly match TERMINOLOGY_MAP's values, so the two can't silently drift
apart.
"""

from __future__ import annotations

import re

CANONICAL_TERM_MESH_IDS: dict[str, str] = {
    "type 2 diabetes": "D003924",  # Diabetes Mellitus, Type 2
    "coronary artery disease": "D003324",  # Coronary Artery Disease
    "myocardial infarction": "D009203",  # Myocardial Infarction
    "hypertension": "D006973",  # Hypertension
    "hyperlipidemia": "D006949",  # Hyperlipidemias
    "hemoglobin a1c": "D006442",  # Glycated Hemoglobin
    "chronic kidney disease": "D051436",  # Renal Insufficiency, Chronic --
    # the real MeSH preferred heading; "Chronic Kidney Disease" is an
    # entry-term synonym under it, not the descriptor name itself (same
    # situation as "hyperlipidemia" above, whose real heading is plural,
    # "Hyperlipidemias"). Confirmed live against NCBI: esearch on "Chronic
    # Kidney Disease" resolves to this exact descriptor.
    "hypothyroidism": "D007037",  # Hypothyroidism
}

_CANONICAL_TERM_PATTERN = re.compile(
    r"\b(?:" + "|".join(re.escape(t) for t in sorted(CANONICAL_TERM_MESH_IDS, key=len, reverse=True)) + r")\b",
    re.IGNORECASE,
)


def match_canonical_terms(text: str) -> list[str]:
    """Every canonical term from CANONICAL_TERM_MESH_IDS present in
    `text`, deduplicated, in first-appearance order. Expects `text` to
    have already passed through data_preparation.normalize_terminology()
    -- this matches canonical forms only, not the abbreviations/synonyms
    TERMINOLOGY_MAP maps them from (that normalization already happens
    upstream, in Data Preparation, before this agent ever runs)."""
    if not text:
        return []
    seen: list[str] = []
    for match in _CANONICAL_TERM_PATTERN.finditer(text):
        term = match.group(0).lower()
        if term not in seen:
            seen.append(term)
    return seen
