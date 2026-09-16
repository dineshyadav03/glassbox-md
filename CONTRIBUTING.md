# Contributing to Glassbox MD

This is primarily a solo educational/portfolio project, but issues and
pull requests are welcome -- for bug reports, test coverage, documentation
fixes, or extending the pipeline (new conditions, new lab conversions,
new PII patterns).

Before anything else, read the disclaimer at the top of
[`README.md`](README.md) and in
[`src/glassbox_md/disclaimer.py`](src/glassbox_md/disclaimer.py). This is
not a medical device and must never be used with real patient data (PHI)
-- that boundary applies to test fixtures, example data, and issue reports
too. Use synthetic or de-identified data only, always.

## Setup

```bash
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt
pip install -e .
copy .env.example .env        # then fill in your API key(s)
pytest
```

See the README's [Setup](README.md#setup) section for the literature
index build step (needed for the RAG agent) and how to run the Chainlit
UI locally.

## Before opening a pull request

- **Run the test suite**: `pytest`. All tests should pass; add new ones
  for new behavior rather than only checking it manually.
- **Keep the six-agent boundary intact.** Each agent
  (`src/glassbox_md/agents/`) has one job and communicates only through
  `MedicalPipelineState`. If a change needs to reach across agents, that's
  usually a sign it belongs in the state schema, not a direct import.
- **PHI never crosses the Privacy Protection Agent unredacted.** Any code
  path that touches patient-shaped data before redaction needs to keep it
  that way -- see `assert_privacy_boundary_respected` in
  `privacy_protection.py` for the existing enforcement pattern.
- **Update the README, not just the code**, when you change scope,
  fix a real bug, or hit a real limitation worth documenting. The
  [Status](README.md#status) and [Known limitations](README.md#known-limitations)
  sections are written to stay honest about what does and doesn't work --
  new work should follow that same rhythm rather than only describing the
  happy path.
- **Prefer a live check over an assumption** for anything touching the UI
  or the real OpenRouter call. Several of the bugs already documented in
  this project (see Status) were only found by actually running the app,
  not by reading the code.

## Reporting bugs

Open a GitHub issue with: what you ran, what you expected, what actually
happened, and (if relevant) which pipeline stage it surfaced in -- the
Chainlit UI shows each of the six agents as its own step, which usually
narrows this down quickly. Include the audit log entry if the failure
produced one.

## Scope

New conditions, labs, or PII patterns are welcome, but should follow the
existing pattern of being real and independently verifiable -- e.g. a
real MeSH Descriptor ID checked against NCBI, not typed from memory (see
`controlled_vocabulary.py` and the RAG V2 writeup in the README for what
that looked like in practice). Changes that would require a UMLS/UTS
license, a paid LLM provider, or real patient data are out of scope for
this project by design.
