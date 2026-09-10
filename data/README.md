# Data sourcing (Phase 0 / task p0-4)

**Nothing real goes in this folder.** Every subfolder here holds either
public, already de-identified data or data you generate yourself. This is
a project constraint from the architecture critique, not just a suggestion
-- see the project brief's Privacy & Security section for why.

## `imaging/`
A small public chest-X-ray or similar imaging dataset (e.g. a Kaggle
pneumonia/chest-X-ray set), used to test the Document Parser and
Diagnostic Prediction agents against realistic files without touching a
DICOM data-use agreement. Add a second sub-set of a few synthetic/AI-
generated MRI-style images (as referenced in the original project
material) if you want imaging variety beyond X-rays.

## `tabular/`
A public tabular dataset for the *real* SHAP demo in the Explainability
agent -- e.g. the UCI Heart Disease or Diabetes dataset. This is the one
place SHAP is used correctly in this project: trained on a model you
actually control, not applied to a closed multimodal LLM call.

## `literature/`
Cache for PubMed abstracts pulled via the free E-utilities API for the
Medical Knowledge RAG agent (Phase 4). Populated by a script, not by hand
-- nothing to add here yet in Phase 0.

## `synthetic_patients/`
Fake patient documents *you generate yourself* (fabricated names, dates,
lab values) for testing the Privacy Protection agent's redaction. Because
you control the ground truth, you can verify the agent actually caught
every planted identifier. Never put a real document here, de-identified
or not.
