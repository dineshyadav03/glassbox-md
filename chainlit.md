# Glassbox MD

A medical AI agent pipeline with an audit trail: six agents that turn
imaging, labs, and symptoms into a ranked differential, with each step
shown. The reasoning it shows is the model's own account of itself, not a
verified explanation of how it reached the answer.

> **Educational / portfolio demonstration. Not an FDA-cleared or
> clinically validated medical device. Not validated for diagnostic
> accuracy. Must not be used with real patient data (PHI) or to inform
> actual clinical decisions. All outputs are illustrative only, not
> medical advice, and require qualified clinician review before any
> action.**

## What happens when you upload a document

Each stage below runs as its own step in the trace so you can see what
each stage did:

1. **Document Parser** -- extracts text/tables from PDFs, metadata from DICOM
2. **Privacy Protection** -- redacts identifying information, extracts structured lab values
3. **Data Preparation** -- normalizes units and terminology
4. **Medical Knowledge RAG** -- retrieves relevant literature (type 2 diabetes, coronary artery disease, hyperlipidemia, hypertension, chronic kidney disease, hypothyroidism)
5. **Diagnostic Prediction** -- produces a ranked differential, never a single verdict
6. **Report Assembly** -- combines the model's self-reported reasoning with retrieved citations. It also runs a SHAP demo on a public dataset; that demo is *not* about the current case

**Use synthetic or de-identified test data only.** See `data/README.md` in the repo for how test documents are generated.
