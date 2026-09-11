"""Document Parser Agent.

First in pipeline order. Reads each path in `raw_input_paths` and produces
`extracted_document_content` -- text and tables from PDFs, metadata and a
pixel-array summary from DICOM files, as two genuinely separate code
paths. The architecture critique flagged that Marker/Docling (the
libraries named in the original pitch) don't read DICOM at all; this
module never tries to make one library do both jobs.

Library choice for PDFs: pdfplumber, not Marker/Docling as originally
pitched. Both Marker and Docling are ML-based parsers built for messy
real-world documents -- scanned pages, complex multi-column layouts -- and
both pull in torch as a transitive dependency: a multi-hundred-megabyte-
to-gigabyte install for what this MVP actually needs, which is text
extraction from synthetic, born-digital lab-report PDFs this project
generates itself (see data/synthetic_patients/). pdfplumber handles that
with no ML dependency at all. If this project is ever pointed at real
scanned documents, swap the implementation of `parse_pdf()` for one backed
by Docling -- the `ParsedDocument` contract below doesn't have to change.

Design note: DICOM pixel data is extracted as a shape/dtype summary here,
not as the raw array, so large binary imaging data never enters the
LangGraph state dict. That mirrors the same concern the architecture
critique raised about LangGraph checkpointing -- state should stay small
enough that persisting it doesn't become an unbounded copy of patient
imaging. Anything downstream that needs actual pixel data should read it
from `source_path` directly (before Phase 3 replaces it with a
de-identified copy).
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path
from typing import Any, Literal, TypedDict

import pdfplumber
import pydicom
from pydicom.valuerep import PersonName

from ..audit import audit_entry
from ..state import MedicalPipelineState, update_stage_status

STAGE_NAME = "document_parser"

Table = list[list[str | None]]


class ParsedDocument(TypedDict):
    source_path: str
    kind: Literal["pdf", "dicom"]
    text: str
    tables: list[Table]
    dicom_metadata: dict[str, Any] | None
    pixel_summary: dict[str, Any] | None  # {"shape": ..., "dtype": ...}, an error dict, or None


class ParseError(TypedDict):
    source_path: str
    error: str


class ExtractedDocumentContent(TypedDict):
    documents: list[ParsedDocument]
    parse_errors: list[ParseError]


class UnsupportedFileTypeError(ValueError):
    """Raised for a file extension this agent doesn't know how to
    dispatch. Caught by the agent node, not propagated to its caller --
    an unrecognized file is a per-file parse error, not a pipeline crash.
    """


_PDF_EXTENSIONS = {".pdf"}
_DICOM_EXTENSIONS = {".dcm", ".dicom", ""}  # DICOM files often carry no extension


def parse_pdf(path: str) -> ParsedDocument:
    """Extract text and tables from a born-digital PDF via pdfplumber."""
    text_parts: list[str] = []
    tables: list[Table] = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text()
            if page_text:
                text_parts.append(page_text)
            tables.extend(page.extract_tables())

    return ParsedDocument(
        source_path=path,
        kind="pdf",
        text="\n".join(text_parts),
        tables=tables,
        dicom_metadata=None,
        pixel_summary=None,
    )


def parse_dicom(path: str) -> ParsedDocument:
    """Extract DICOM metadata and a pixel-array summary via pydicom. Never
    returns the raw pixel array itself -- see module docstring."""
    dataset = pydicom.dcmread(path)

    metadata: dict[str, Any] = {}
    for element in dataset:
        if element.keyword == "PixelData":
            continue
        metadata[element.keyword or str(element.tag)] = _stringify(element.value)

    pixel_summary: dict[str, Any] | None = None
    if hasattr(dataset, "PixelData"):
        try:
            array = dataset.pixel_array
            pixel_summary = {"shape": tuple(array.shape), "dtype": str(array.dtype)}
        except Exception as exc:  # e.g. an unsupported/missing transfer syntax
            pixel_summary = {"error": f"{type(exc).__name__}: {exc}"}

    return ParsedDocument(
        source_path=path,
        kind="dicom",
        text="",
        tables=[],
        dicom_metadata=metadata,
        pixel_summary=pixel_summary,
    )


def _stringify(value: Any) -> Any:
    """DICOM element values include types (PersonName, MultiValue, bytes)
    that don't round-trip through the rest of the pipeline cleanly --
    flatten them to plain str/list so downstream agents get plain data.

    PersonName must be checked before the generic Iterable case: it
    supports iteration (over its component groups), which would otherwise
    shred "Test^Synthetic" into a list of individual characters.
    """
    if isinstance(value, bytes):
        return f"<{len(value)} bytes>"
    if isinstance(value, (str, PersonName)):
        return str(value)
    if isinstance(value, Iterable):
        return [str(v) for v in value]
    return str(value)


def _dispatch(path: str) -> ParsedDocument:
    extension = Path(path).suffix.lower()
    if extension in _PDF_EXTENSIONS:
        return parse_pdf(path)
    if extension in _DICOM_EXTENSIONS:
        return parse_dicom(path)
    raise UnsupportedFileTypeError(f"no parser registered for extension {extension!r}")


def document_parser_agent(state: MedicalPipelineState) -> dict[str, Any]:
    """The LangGraph node. Every file in `raw_input_paths` is attempted
    independently -- one malformed or unsupported file becomes a recorded
    `ParseError`, never an uncaught exception that kills the other five
    stages downstream of it.
    """
    paths = state.get("raw_input_paths") or []

    if not paths:
        return {
            "stage_status": update_stage_status(
                state, STAGE_NAME, {"status": "failed", "message": "no input files provided"}
            ),
            "audit_log": [audit_entry(STAGE_NAME, "failed: no input files provided")],
        }

    documents: list[ParsedDocument] = []
    parse_errors: list[ParseError] = []

    for path in paths:
        try:
            documents.append(_dispatch(path))
        except Exception as exc:  # malformed/unsupported input, not a code bug -- record, don't raise
            parse_errors.append({"source_path": path, "error": f"{type(exc).__name__}: {exc}"})

    extracted_document_content: ExtractedDocumentContent = {
        "documents": documents,
        "parse_errors": parse_errors,
    }

    if not documents:
        status = {"status": "failed", "message": f"all {len(paths)} file(s) failed to parse"}
        summary = f"failed to parse all {len(paths)} file(s)"
    elif parse_errors:
        status = {
            "status": "needs_review",
            "message": f"{len(parse_errors)} of {len(paths)} file(s) failed to parse",
        }
        summary = f"parsed {len(documents)} of {len(paths)} file(s); {len(parse_errors)} failed"
    else:
        status = {"status": "ok", "message": None}
        summary = f"parsed {len(documents)} file(s)"

    return {
        "extracted_document_content": extracted_document_content,
        "stage_status": update_stage_status(state, STAGE_NAME, status),
        "audit_log": [audit_entry(STAGE_NAME, summary)],
    }
