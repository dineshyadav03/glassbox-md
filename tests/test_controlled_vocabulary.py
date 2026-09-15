"""Tests for the controlled-vocabulary tier (tier 2) of the patient ->
controlled vocabulary -> literature graph -- see controlled_vocabulary.py's
module docstring for why this exists and where its MeSH IDs came from.
"""

from glassbox_md.agents.controlled_vocabulary import CANONICAL_TERM_MESH_IDS, match_canonical_terms
from glassbox_md.agents.data_preparation import TERMINOLOGY_MAP


def test_canonical_term_mesh_ids_covers_every_terminology_map_value():
    """Drift guard: this module deliberately doesn't import TERMINOLOGY_MAP
    to auto-derive its key set (see controlled_vocabulary.py's docstring),
    so this test is what actually catches the two dicts drifting apart if
    either one is edited without the other."""
    assert set(CANONICAL_TERM_MESH_IDS) == set(TERMINOLOGY_MAP.values())


def test_match_canonical_terms_finds_present_terms_in_order():
    text = "Patient has hypertension and type 2 diabetes."
    assert match_canonical_terms(text) == ["hypertension", "type 2 diabetes"]


def test_match_canonical_terms_case_insensitive():
    assert match_canonical_terms("TYPE 2 DIABETES") == ["type 2 diabetes"]


def test_match_canonical_terms_word_boundary():
    # "hypertensiontype" is not a real word boundary match for "hypertension"
    assert match_canonical_terms("hypertensiontypething") == []


def test_match_canonical_terms_deduplicates():
    text = "History of type 2 diabetes. Follow-up for type 2 diabetes."
    assert match_canonical_terms(text) == ["type 2 diabetes"]


def test_match_canonical_terms_empty_for_no_matches():
    assert match_canonical_terms("Patient reports knee pain.") == []


def test_match_canonical_terms_empty_for_empty_text():
    assert match_canonical_terms("") == []
