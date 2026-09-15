# Glassbox MD

An explainable medical AI agent pipeline: six agents that turn imaging,
labs, and symptoms into a differential a clinician can actually audit,
not just trust.

> **Educational / portfolio demonstration. Not an FDA-cleared or
> clinically validated medical device. Not validated for diagnostic
> accuracy. Must not be used with real patient data (PHI) or to inform
> actual clinical decisions. All outputs are illustrative only, not
> medical advice, and require qualified clinician review before any
> action.**

## What happens when you upload a document

Each stage below runs as its own step in the trace so you can see how
the result was reached, not just what it was:

1. **Document Parser** -- extracts text/tables from PDFs, metadata from DICOM
2. **Privacy Protection** -- redacts identifying information, extracts structured lab values
3. **Data Preparation** -- normalizes units and terminology
4. **Medical Knowledge RAG** -- retrieves relevant literature (type 2 diabetes, coronary artery disease, hyperlipidemia, hypertension, chronic kidney disease, hypothyroidism)
5. **Diagnostic Prediction** -- produces a ranked differential, never a single verdict
6. **Explainability** -- assembles a citation-grounded narrative and a real SHAP demo

**Use synthetic or de-identified test data only.** See `data/README.md` in the repo for how test documents are generated.
