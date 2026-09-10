"""The six pipeline agents. Empty for now -- this package exists so the
import path (`glassbox_md.agents.document_parser`, etc.) is settled before
Phase 1 starts, not because any agent is implemented yet.

Build order (see docs/reference-images and the project brief's task list):
  1. data_preparation      -- deterministic, no dependencies, build first
  2. document_parser       -- Marker/Docling for PDFs, pydicom for DICOM
  3. privacy_protection    -- must run before anything touches an external API
  4. medical_knowledge_rag -- ChromaDB over PubMed abstracts
  5. diagnostic_prediction -- Gemini Pro Vision / GPT-4V
  6. explainability        -- modality-split, citation-grounded, human-gated
"""
