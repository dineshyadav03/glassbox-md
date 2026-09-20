"""Repeatable, resumable imaging evaluation for the Glassbox MD pipeline.

Replaces an n=4 anecdote ("3 of 4 real chest X-rays landed sensibly")
with a measured result: a seeded, class-balanced sample of the public
Hugging Face `hf-vision/chest-xray-pneumonia` test split (624 pediatric
chest X-rays, NORMAL vs PNEUMONIA, CC BY 4.0) is wrapped as synthetic
DICOM, pushed through the real six-agent graph one case at a time, and
scored against the dataset's own labels with Wilson confidence intervals.

Everything except the two network functions (`fetch_rows_page`,
`download_image`) and the LLM call is offline-testable, and the LLM call
is injected the same way every other phase's tests inject it: through
`build_pipeline_graph(llm_caller=...)`. Images and the DICOM wrappers only
ever exist in a temp directory -- nothing here writes image data into the
repo -- and no patient data is real: identifiers are `EVAL-ROW-<idx>`.

Two design choices worth knowing about:
  - Results are appended to a JSONL file one case at a time. A free-tier
    run is slow (~70s per case at the router's observed latency) and
    flaky, so a run that dies at case 19 of 24 must keep cases 1-18.
    The file stores the model's raw condition strings, not our category
    for them, so `summarize` can re-score old runs if `categorize_condition`
    is ever improved.
  - The image URLs in a /rows page are signed and expire, so the sample
    only learns labels up front and each case re-fetches its own fresh
    URL right before downloading it.
"""

from __future__ import annotations

import io
import json
import logging
import math
import random
import re
import statistics
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

import numpy as np
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, SecondaryCaptureImageStorage, generate_uid

from .state import STAGE_NAMES, new_stage_status

logger = logging.getLogger(__name__)

DATASET_ID = "hf-vision/chest-xray-pneumonia"
DATASET_SPLIT = "test"
ROWS_ENDPOINT = "https://datasets-server.huggingface.co/rows"
ROWS_PAGE_SIZE = 100  # the /rows endpoint rejects length > 100
LABEL_NAMES = {0: "NORMAL", 1: "PNEUMONIA"}

# The signed CDN URLs sometimes 403 a bare urllib request; a Referer and a
# browser-like User-Agent are what reliably get through.
_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
_IMAGE_REFERER = "https://huggingface.co/"
REQUEST_TIMEOUT_SECONDS = 60
_HTTP_ATTEMPTS = 3

Record = dict[str, Any]


# --- sampling ----------------------------------------------------------------

def _http_get(url: str, headers: dict[str, str]) -> bytes:
    """GET with a few retries on transient failures (timeouts, dropped
    connections, 429/5xx). A 4xx other than 429 is a real answer, not a
    blip, so it raises immediately."""
    for attempt in range(1, _HTTP_ATTEMPTS + 1):
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            if exc.code != 429 and exc.code < 500:
                raise
            error: Exception = exc
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            error = exc
        if attempt == _HTTP_ATTEMPTS:
            raise error
        time.sleep(2**attempt)
    raise AssertionError("unreachable")  # the loop always returns or raises


def fetch_rows_page(offset: int, length: int) -> dict[str, Any]:
    """One page of the dataset-server /rows API. The single network entry
    point for row metadata, so tests replace exactly this."""
    query = urllib.parse.urlencode(
        {
            "dataset": DATASET_ID,
            "config": "default",
            "split": DATASET_SPLIT,
            "offset": offset,
            "length": length,
        }
    )
    return json.loads(_http_get(f"{ROWS_ENDPOINT}?{query}", {"User-Agent": _BROWSER_USER_AGENT}))


def download_image(url: str) -> bytes:
    """The single network entry point for image bytes."""
    return _http_get(url, {"Referer": _IMAGE_REFERER, "User-Agent": _BROWSER_USER_AGENT})


def _label_name(label: Any) -> str:
    try:
        return LABEL_NAMES[label]
    except KeyError:
        raise ValueError(f"unexpected label value {label!r} from the rows API") from None


def fetch_label_map() -> dict[int, str]:
    """row_idx -> "NORMAL"/"PNEUMONIA" for the whole split. Labels are read
    from the API rather than assumed from the split's current class
    boundaries, so a re-ordered dataset revision can't silently corrupt
    the ground truth."""
    labels: dict[int, str] = {}
    offset = 0
    total: int | None = None
    while total is None or offset < total:
        page = fetch_rows_page(offset, ROWS_PAGE_SIZE)
        total = page["num_rows_total"]
        rows = page["rows"]
        if not rows:
            raise RuntimeError(f"rows API returned no rows at offset {offset} of {total}")
        for row in rows:
            labels[row["row_idx"]] = _label_name(row["row"]["label"])
        offset += len(rows)
    if len(labels) != total:
        raise RuntimeError(f"expected {total} labelled rows, collected {len(labels)}")
    return labels


def sample_rows(label_map: dict[int, str], n_per_class: int, seed: int) -> list[tuple[int, str]]:
    """Deterministic class-balanced sample as (row_idx, label) pairs,
    interleaved NORMAL/PNEUMONIA so a run cut short still has a balanced
    partial sample.

    Each class is shuffled in full and the first `n_per_class` taken,
    instead of `rng.sample(pool, n)`: a larger `n` for the same seed then
    extends the smaller sample instead of replacing it, so a finished
    12-per-class run can be grown to 30-per-class with `--resume` and
    keep every result it already paid for.
    """
    if n_per_class < 1:
        raise ValueError(f"n_per_class must be at least 1, got {n_per_class}")
    rng = random.Random(seed)
    picks: list[list[tuple[int, str]]] = []
    for name in LABEL_NAMES.values():
        pool = sorted(idx for idx, label in label_map.items() if label == name)
        if len(pool) < n_per_class:
            raise ValueError(f"asked for {n_per_class} {name} rows but the split only has {len(pool)}")
        rng.shuffle(pool)
        picks.append([(idx, name) for idx in pool[:n_per_class]])
    return [case for pair in zip(*picks) for case in pair]


# --- image -> DICOM ----------------------------------------------------------

def load_grayscale_array(image_bytes: bytes) -> np.ndarray:
    """Decode an image to a 2-D uint8 array. Pillow is imported here, not
    at module top: the pipeline itself only needs it lazily (see
    `_dicom_to_png_bytes`), and `report` shouldn't require it."""
    try:
        from PIL import Image
    except ImportError as exc:
        raise ImportError("Pillow is required to decode dataset images: pip install pillow") from exc
    with Image.open(io.BytesIO(image_bytes)) as image:
        return np.asarray(image.convert("L"), dtype=np.uint8)


def wrap_as_dicom(pixels: np.ndarray, dest_path: str | Path, row_idx: int) -> Path:
    """Write `pixels` (2-D uint8) as a minimal valid DICOM the pipeline's
    parser and Diagnostic Prediction agent both accept. Modality is "MR"
    only because that's what the pipeline's DICOM handling was built and
    tested against; the identifiers are obviously synthetic."""
    if pixels.ndim != 2 or pixels.dtype != np.uint8:
        raise ValueError(f"expected a 2-D uint8 array, got shape {pixels.shape} dtype {pixels.dtype}")

    dest = Path(dest_path)
    sop_instance_uid = generate_uid()
    meta = FileMetaDataset()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
    meta.MediaStorageSOPInstanceUID = sop_instance_uid

    ds = FileDataset(str(dest), {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID = SecondaryCaptureImageStorage
    ds.SOPInstanceUID = sop_instance_uid
    ds.PatientName = f"EVAL-ROW-{row_idx}"
    ds.PatientID = f"EVAL-ROW-{row_idx}"
    ds.Modality = "MR"
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.Rows, ds.Columns = pixels.shape
    ds.BitsAllocated = 8
    ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    ds.PixelData = np.ascontiguousarray(pixels).tobytes()
    ds.save_as(str(dest), enforce_file_format=True)  # what the repo's other DICOM fixtures use (pydicom 3)
    return dest


def prepare_dicom(row_idx: int, true_label: str, work_dir: str | Path) -> Path:
    """Fetch a fresh signed URL for one row, download it, wrap it as DICOM
    in `work_dir`. The label is re-checked against the row actually
    returned, so a dataset revision that shifted row order fails loudly
    instead of scoring an image against the wrong ground truth."""
    page = fetch_rows_page(row_idx, 1)
    rows = page["rows"]
    if not rows or rows[0]["row_idx"] != row_idx:
        raise RuntimeError(f"rows API did not return row {row_idx}")
    row = rows[0]["row"]
    if _label_name(row["label"]) != true_label:
        raise RuntimeError(f"row {row_idx} is now labelled {_label_name(row['label'])}, expected {true_label}")
    pixels = load_grayscale_array(download_image(row["image"]["src"]))
    return wrap_as_dicom(pixels, Path(work_dir) / f"row-{row_idx}.dcm", row_idx)


# --- categorising the model's free-text conditions ----------------------------

# What counts as a "pneumonia" call is deliberately strict: the word
# pneumonia, or a parenchymal finding that IS how a radiograph reports one
# (consolidation, infiltrate, airspace/lung opacity). "Lower respiratory
# infection", "bronchiolitis" and "pneumonitis" are NOT counted -- they are
# adjacent diagnoses (pneumonitis is often non-infectious: radiation,
# hypersensitivity, chemical), and crediting them would inflate sensitivity.
# Adjacent calls land in "other", which counts as a miss.
_PNEUMONIA_PATTERN = re.compile(
    r"pneumonia|consolidation|infiltrat\w*|airspace\s+(?:opacit\w+|disease)"
    r"|(?:lung|pulmonary|focal|lobar)\s+opacit\w+"
)
_NORMAL_PATTERN = re.compile(
    r"\bnormal\b|\bunremarkable\b|\bhealthy\b|\bnegative\s+chest\b"
    r"|\bclear\s+lungs?\b|\blungs?\s+(?:are\s+)?clear\b"
    r"|\bno\s+(?:(?:acute|active|significant|focal)\s+)*"
    r"(?:(?:cardiopulmonary|cardiac|pulmonary|chest|thoracic|radiographic)\s+)?"
    r"(?:findings?|abnormalit\w+|disease|process)\b"
)
# A "normal" call is withdrawn if an unnegated abnormality is mentioned
# alongside it ("normal heart size with right pleural effusion").
_PATHOLOGY_PATTERN = re.compile(
    r"effusion|pneumothorax|hyperinflat\w*|air\s+trapping|cardiomegal\w*|edema|atelectasis"
    r"|\bmass\b|nodule|fracture|pneumonia|consolidation|infiltrat\w*|opacit\w+|enlarge\w*"
    r"|widen\w*|abnormal\w*"
)

# Negation rule, deliberately conservative: a term is negated if a negation
# or hedge cue appears ANYWHERE earlier in its clause ("no radiographic
# evidence of acute bacterial pneumonia", "no pleural effusion,
# pneumothorax, or pneumonia", "unlikely pneumonia", "findings inconsistent
# with pneumonia", "non-pneumonia"), or a hedge follows it ("pneumonia,
# ruled out", "pneumonia can be excluded", "pneumonia is not the
# diagnosis"). Clauses end at ; . ! ? : ( or a contrast word, NOT at commas,
# so a negated list stays negated -- the cost is that "no effusion, lobar
# pneumonia" also reads as negated. That errs toward "other", which counts
# as a miss, i.e. it can only understate accuracy, never inflate it. A
# negated pneumonia term is NOT credited as "normal" ("no pneumonia" says
# nothing about the rest of the film) unless a normal phrase is also present
# ("normal chest, no pneumonia"). A keyword heuristic, not NLP: anything it
# misjudges is visible in the stored raw condition strings, which is why
# they are kept.
_CLAUSE_BREAK = re.compile(r"[;.!?:(]|\b(?:but|however|although|though|except|whereas)\b")
_NEGATION_BEFORE = re.compile(
    r"\b(?:no|not|without|absent|absence\s+of|negative\s+for|neither|nor|denies|free\s+of|lack\s+of"
    r"|unlikely|improbable|less\s+likely|low\s+probability\s+of|inconsistent\s+with"
    r"|ruled\s+out)\b|\bnon-"
)
# "Rule out pneumonia" / "exclude pneumonia" are deliberately NOT cues: in a
# differential they name pneumonia as a candidate still to be considered.
# The past-tense forms ("ruled out", "excluded") assert the opposite.
_NEGATION_AFTER = re.compile(
    r"^[\s,\-:()]*(?:(?:is|are|was|has\s+been|been|can\s+be|could\s+be|may\s+be|would\s+be)\s+)?"
    r"(?:(?:very|highly|quite)\s+)?"
    r"(?:unlikely|improbable|less\s+likely|ruled\s+out|excluded|absent|negative|resolved"
    r"|not\s+(?:seen|present|evident|identified|detected|likely|suggested|favou?red|the\s+diagnosis|supported))\b"
)


def _is_negated(text: str, match: re.Match[str]) -> bool:
    clause = _CLAUSE_BREAK.split(text[: match.start()])[-1]
    return bool(_NEGATION_BEFORE.search(clause)) or bool(_NEGATION_AFTER.match(text[match.end() :]))


def _mentions(pattern: re.Pattern[str], text: str) -> bool:
    return any(not _is_negated(text, match) for match in pattern.finditer(text))


def categorize_condition(text: str | None) -> str:
    """Map a model-supplied condition name to "pneumonia", "normal" or
    "other" (see the rules above). Pneumonia is checked first: a
    differential entry naming a pneumonia finding is a pneumonia call even
    if it also mentions something normal ("normal heart size, lobar
    pneumonia"). A "normal" call needs a normal phrase and no unnegated
    abnormality mentioned with it."""
    lowered = (text or "").lower()
    if _mentions(_PNEUMONIA_PATTERN, lowered):
        return "pneumonia"
    if _mentions(_NORMAL_PATTERN, lowered) and not _mentions(_PATHOLOGY_PATTERN, lowered):
        return "normal"
    return "other"


def _is_correct(true_label: str, category: str) -> bool:
    return (true_label == "PNEUMONIA" and category == "pneumonia") or (
        true_label == "NORMAL" and category == "normal"
    )


def pneumonia_in_top3(record: Record) -> bool:
    conditions = record.get("top3") or [record.get("top1_condition")]
    return any(categorize_condition(c) == "pneumonia" for c in conditions[:3])


# --- running one case --------------------------------------------------------

def new_state(paths: list[str]) -> dict[str, Any]:
    """Mirrors app.py's `_new_state` (app.py can't be imported here: it
    builds a Chainlit app and the real pipeline at import time)."""
    return {
        "raw_input_paths": paths,
        "extracted_document_content": {},
        "anonymized_patient_data": {},
        "structured_clinical_data": {},
        "rag_literature_context": [],
        "diagnostic_prediction_result": {},
        "final_explainable_report": None,
        "stage_status": new_stage_status(),
        "audit_log": [],
    }


def _blank_record(row_idx: int, true_label: str) -> Record:
    return {
        "row_idx": row_idx,
        "true_label": true_label,
        "top1_condition": None,
        "top1_likelihood": None,
        "overall_confidence": None,
        "top3": [],
        "abstained": None,
        "disagreement_flagged": None,
        "stage_status": {},
        "error": None,
        "wall_seconds": None,
        "model_name": None,
    }


def _fill_record(record: Record, final_state: dict[str, Any]) -> None:
    statuses = final_state.get("stage_status") or {}
    record["stage_status"] = {stage: (statuses.get(stage) or {}).get("status") for stage in STAGE_NAMES}
    for stage in STAGE_NAMES:
        entry = statuses.get(stage) or {}
        if entry.get("status") == "failed":
            record["error"] = f"{stage} failed: {entry.get('message')}"
            break

    prediction = final_state.get("diagnostic_prediction_result") or {}
    # Highest likelihood first, exactly as app.py ranks the differential
    # it shows -- the model's list order isn't guaranteed to be sorted.
    ranked = sorted(prediction.get("differential") or [], key=lambda c: c["likelihood"], reverse=True)
    if ranked:
        record["top1_condition"] = ranked[0]["condition"]
        record["top1_likelihood"] = ranked[0]["likelihood"]
    record["top3"] = [c["condition"] for c in ranked[:3]]
    record["overall_confidence"] = prediction.get("overall_confidence")
    record["abstained"] = prediction.get("abstained")
    record["model_name"] = prediction.get("model_name")

    report = final_state.get("final_explainable_report")
    if report is not None:
        record["disagreement_flagged"] = report.get("disagreement_flagged")
    elif record["error"] is None:
        record["error"] = "pipeline finished without a final report"


def run_case(graph: Any, dcm_path: str | Path, row_idx: int, true_label: str) -> Record:
    """Run one DICOM through the compiled pipeline and return its record.
    Never raises: one bad case must not take down a long, slow run.
    `wall_seconds` is pipeline time only, excluding the image download."""
    record = _blank_record(row_idx, true_label)
    started = time.perf_counter()

    # This whole evaluation assumes the image reaches the model. The agent
    # silently drops a DICOM whose pixels can't be converted and calls the
    # model text-only, which would otherwise be scored like any other case.
    from .agents.diagnostic_prediction import _load_images_for_prompt

    try:
        image_convertible = bool(_load_images_for_prompt([str(dcm_path)]))
    except Exception:  # noqa: BLE001 -- treated the same as "not convertible"
        image_convertible = False
    if not image_convertible:
        record["error"] = "image could not be converted for the model (it would have been sent text-only)"
        record["wall_seconds"] = round(time.perf_counter() - started, 2)
        return record

    try:
        final_state = graph.invoke(new_state([str(dcm_path)]))
    except Exception as exc:
        record["error"] = f"{type(exc).__name__}: {exc}"
    else:
        _fill_record(record, final_state)
    record["wall_seconds"] = round(time.perf_counter() - started, 2)
    return record


def evaluate_row(
    row_idx: int,
    true_label: str,
    *,
    graph: Any,
    work_dir: str | Path,
    prepare: Callable[[int, str, Path | str], Path] = prepare_dicom,
) -> Record:
    """Prepare the image and run it, folding a failure at either step into
    the record's `error` instead of raising."""
    started = time.perf_counter()
    try:
        dcm_path = prepare(row_idx, true_label, work_dir)
    except Exception as exc:
        record = _blank_record(row_idx, true_label)
        record["error"] = f"image preparation failed: {type(exc).__name__}: {exc}"
        record["wall_seconds"] = round(time.perf_counter() - started, 2)
        return record
    try:
        return run_case(graph, dcm_path, row_idx, true_label)
    finally:
        Path(dcm_path).unlink(missing_ok=True)  # keep the temp dir small over a long run


# --- results file ------------------------------------------------------------

_ACCOUNT_ID = re.compile(r"""(['"]user_id['"]\s*:\s*['"])[^'"]*(['"])""")


def scrub_error_text(text: str) -> str:
    """Redact the provider account id that OpenRouter error bodies carry
    (`'user_id': 'user_...'`). The results file is meant to be committed,
    and an account identifier has no business in a public repo."""
    return _ACCOUNT_ID.sub(r"\1<redacted>\2", text)


def append_result(path: str | Path, record: Record) -> None:
    """Append one record and flush immediately, so an interrupted run
    keeps everything finished so far."""
    if record.get("error"):
        record = {**record, "error": scrub_error_text(record["error"])}
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # An interrupted write can leave a final line with no newline; without
    # this, the next record would be glued onto that fragment.
    needs_newline = path.exists() and path.stat().st_size > 0 and not path.read_bytes().endswith(b"\n")
    with path.open("a", encoding="utf-8") as handle:
        if needs_newline:
            handle.write("\n")
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        handle.flush()


def load_results(path: str | Path) -> list[Record]:
    """Read the JSONL, one record per row_idx (the last one wins, so a
    `--retry-errors` re-run supersedes the earlier failed attempt).
    Unparseable lines -- e.g. a write cut off mid-line -- are skipped with
    a warning rather than aborting the whole report."""
    latest: dict[int, Record] = {}
    # Read bytes and decode each line on its own: a write cut off inside a
    # multi-byte character (model output is often non-ASCII, and records
    # are stored with ensure_ascii=False) would otherwise raise
    # UnicodeDecodeError for the whole file, before any line is checked.
    for line_number, raw in enumerate(Path(path).read_bytes().split(b"\n"), start=1):
        line = raw.decode("utf-8", errors="replace")
        if not line.strip():
            continue
        try:
            record = json.loads(line)
            latest[record["row_idx"]] = record
        except (json.JSONDecodeError, KeyError, TypeError):
            logger.warning("skipping unparseable line %d in %s", line_number, path)
    return list(latest.values())


def completed_rows(path: str | Path, retry_errors: bool = False) -> set[int]:
    """row_idx values `--resume` should skip. With `retry_errors`, rows
    whose last attempt errored are left out so they run again."""
    path = Path(path)
    if not path.exists():
        return set()
    return {r["row_idx"] for r in load_results(path) if not (retry_errors and r.get("error"))}


def resume_seed_conflict(path: str | Path, seed: int) -> str | None:
    """A message if `path` already holds results from a different seed, else
    None. Resume skips by row_idx only, so resuming under another seed would
    quietly append a second, unrelated sample and the report would pool the
    two into one number that is neither."""
    path = Path(path)
    if not path.exists():
        return None
    other = [s for s in collect_meta(load_results(path))["seeds"] if s != seed]
    if not other:
        return None
    return (
        f"{path} already holds results from seed(s) {other}; resuming with --seed {seed} would mix two "
        "different samples into one report. Use the original seed, or choose a different --out."
    )


def run_eval(
    sample: Iterable[tuple[int, str]],
    out_path: str | Path,
    *,
    graph: Any,
    skip: Iterable[int] = (),
    sleep_seconds: float = 3.0,
    tags: dict[str, Any] | None = None,
    prepare: Callable[[int, str, Path | str], Path] = prepare_dicom,
    sleep: Callable[[float], None] = time.sleep,
    log: Callable[[str], None] = print,
) -> int:
    """Run every not-skipped case in order, appending each finished record
    to `out_path` immediately. `tags` (seed, n_per_class) are stamped on
    every record so the report can say what produced it. Returns the
    number of cases run."""
    skipped = set(skip)
    pending = [(idx, label) for idx, label in sample if idx not in skipped]
    with tempfile.TemporaryDirectory(prefix="glassbox-imaging-eval-") as work_dir:
        for position, (row_idx, true_label) in enumerate(pending, start=1):
            record = evaluate_row(row_idx, true_label, graph=graph, work_dir=work_dir, prepare=prepare)
            record.update(tags or {})
            record["run_at"] = datetime.now(timezone.utc).isoformat()
            append_result(out_path, record)
            outcome = record["error"] or f"top-1: {record['top1_condition']!r}"
            # Progress output must never abort a long unattended run: the
            # record is already on disk, but a redirected stdout on Windows
            # is cp1252 and raises on characters like "->" arrows in model text.
            try:
                log(f"[{position}/{len(pending)}] row {row_idx} ({true_label}) {record['wall_seconds']}s -- {outcome}")
            except Exception:  # noqa: BLE001 -- logging only
                log(f"[{position}/{len(pending)}] row {row_idx} ({true_label}) finished (message not printable)")
            if position < len(pending):
                sleep(sleep_seconds)
    return len(pending)


# --- statistics --------------------------------------------------------------

def wilson_interval(successes: int, trials: int, z: float = 1.96) -> tuple[float, float] | None:
    """Wilson score interval for a binomial proportion (95% by default).
    Preferred over the normal approximation here because the samples are
    small and the rates can sit near 0 or 1, where the normal interval
    escapes [0, 1]. None when there are no trials."""
    if trials == 0:
        return None
    if not 0 <= successes <= trials:
        raise ValueError(f"successes must be within 0..{trials}, got {successes}")
    p = successes / trials
    z2 = z * z
    denominator = 1 + z2 / trials
    centre = (p + z2 / (2 * trials)) / denominator
    half_width = z * math.sqrt(p * (1 - p) / trials + z2 / (4 * trials * trials)) / denominator
    # The bound at a boundary count is exactly 0 or 1 mathematically;
    # pin it so float rounding can't put the interval a hair inside the
    # point estimate (e.g. an upper bound of 0.9999999999999999 at k = n).
    lower = 0.0 if successes == 0 else max(0.0, centre - half_width)
    upper = 1.0 if successes == trials else min(1.0, centre + half_width)
    return lower, upper


def _rate(successes: int, trials: int) -> float | None:
    return successes / trials if trials else None


def _ci(successes: int, trials: int) -> list[float] | None:
    interval = wilson_interval(successes, trials)
    return list(interval) if interval else None


def _mean(values: list[float]) -> float | None:
    return statistics.fmean(values) if values else None


def _share(flags: list[bool | None]) -> float | None:
    known = [flag for flag in flags if flag is not None]
    return sum(known) / len(known) if known else None


def _top1_block(records: list[Record]) -> dict[str, Any]:
    """Top-1 accuracy-style metrics over exactly the records given."""
    categories = [(r, categorize_condition(r.get("top1_condition"))) for r in records]
    correct = [r for r, category in categories if _is_correct(r["true_label"], category)]
    incorrect = [r for r, category in categories if not _is_correct(r["true_label"], category)]
    confusion = {label: {"pneumonia": 0, "normal": 0, "other": 0} for label in LABEL_NAMES.values()}
    for record, category in categories:
        if record["true_label"] in confusion:
            confusion[record["true_label"]][category] += 1
    pneumonia_rows = [r for r in records if r["true_label"] == "PNEUMONIA"]
    normal_rows = [r for r in records if r["true_label"] == "NORMAL"]
    pneumonia_hits = confusion["PNEUMONIA"]["pneumonia"]
    normal_hits = confusion["NORMAL"]["normal"]
    top3_hits = sum(pneumonia_in_top3(r) for r in pneumonia_rows)
    return {
        "n": len(records),
        "n_correct": len(correct),
        "accuracy": _rate(len(correct), len(records)),
        "accuracy_ci95": _ci(len(correct), len(records)),
        "n_pneumonia": len(pneumonia_rows),
        "n_pneumonia_hit": pneumonia_hits,
        "sensitivity": _rate(pneumonia_hits, len(pneumonia_rows)),
        "sensitivity_ci95": _ci(pneumonia_hits, len(pneumonia_rows)),
        "n_pneumonia_top3_hit": top3_hits,
        "top3_sensitivity": _rate(top3_hits, len(pneumonia_rows)),
        "top3_sensitivity_ci95": _ci(top3_hits, len(pneumonia_rows)),
        "n_normal": len(normal_rows),
        "n_normal_hit": normal_hits,
        "specificity": _rate(normal_hits, len(normal_rows)),
        "specificity_ci95": _ci(normal_hits, len(normal_rows)),
        "confusion": confusion,
        "mean_confidence_correct": _mean([r["overall_confidence"] for r in correct if r.get("overall_confidence") is not None]),
        "mean_confidence_incorrect": _mean([r["overall_confidence"] for r in incorrect if r.get("overall_confidence") is not None]),
    }


def summarize(results: list[Record]) -> dict[str, Any]:
    """Score a list of records (one per row_idx, as `load_results` gives).

    Errored and abstained cases are counted and reported, never silently
    dropped, but they are excluded from the accuracy-style metrics
    (`n_scored`); `accuracy_all_cases` is the pessimistic companion that
    counts every one of them as wrong, so abstaining on hard cases can't
    flatter the headline number unnoticed.
    """
    errored = [r for r in results if r.get("error")]
    abstained = [r for r in results if not r.get("error") and r.get("abstained")]
    scored = [r for r in results if not r.get("error") and not r.get("abstained")]

    by_true_label: dict[str, dict[str, int]] = {}
    for record in results:
        counts = by_true_label.setdefault(
            record["true_label"], {"n": 0, "errored": 0, "abstained": 0, "scored": 0}
        )
        counts["n"] += 1
    for group, key in ((errored, "errored"), (abstained, "abstained"), (scored, "scored")):
        for record in group:
            by_true_label[record["true_label"]][key] += 1

    categories = [(r, categorize_condition(r.get("top1_condition"))) for r in scored]
    correct = [r for r, category in categories if _is_correct(r["true_label"], category)]
    incorrect = [r for r, category in categories if not _is_correct(r["true_label"], category)]

    confusion = {
        label: {"pneumonia": 0, "normal": 0, "other": 0} for label in LABEL_NAMES.values()
    }
    for record, category in categories:
        if record["true_label"] in confusion:
            confusion[record["true_label"]][category] += 1

    pneumonia_rows = [r for r in scored if r["true_label"] == "PNEUMONIA"]
    normal_rows = [r for r in scored if r["true_label"] == "NORMAL"]
    pneumonia_hits = confusion["PNEUMONIA"]["pneumonia"]
    normal_hits = confusion["NORMAL"]["normal"]
    top3_hits = sum(pneumonia_in_top3(r) for r in pneumonia_rows)

    completed = [r for r in results if not r.get("error")]
    wall_times = [r["wall_seconds"] for r in completed if r.get("wall_seconds") is not None]

    return {
        "n": len(results),
        "n_errored": len(errored),
        "n_abstained": len(abstained),
        "n_scored": len(scored),
        "n_completed": len(completed),
        "abstention_rate": _rate(len(abstained), len(completed)),
        "abstention_rate_ci95": _ci(len(abstained), len(completed)),
        # The same top-1 metrics over EVERY case that produced an answer,
        # abstained or not. The app still shows an abstained case's ranked
        # differential (flagged as inconclusive), so this is "what the
        # model's top-1 says" -- the committed-only figures below are what
        # survives if abstention is respected. Neither view alone is the
        # honest picture: abstaining on most cases flatters the second, and
        # ignoring the model's own low confidence flatters the first.
        "ignoring_abstention": _top1_block(completed),
        "committed": _top1_block(scored),
        "coverage": _rate(len(scored), len(results)),
        "by_true_label": by_true_label,
        "n_correct": len(correct),
        "accuracy": _rate(len(correct), len(scored)),
        "accuracy_ci95": _ci(len(correct), len(scored)),
        "accuracy_all_cases": _rate(len(correct), len(results)),
        "n_pneumonia_scored": len(pneumonia_rows),
        "n_pneumonia_hit": pneumonia_hits,
        "sensitivity": _rate(pneumonia_hits, len(pneumonia_rows)),
        "sensitivity_ci95": _ci(pneumonia_hits, len(pneumonia_rows)),
        "n_pneumonia_top3_hit": top3_hits,
        "top3_sensitivity": _rate(top3_hits, len(pneumonia_rows)),
        "top3_sensitivity_ci95": _ci(top3_hits, len(pneumonia_rows)),
        "n_normal_scored": len(normal_rows),
        "n_normal_hit": normal_hits,
        "specificity": _rate(normal_hits, len(normal_rows)),
        "specificity_ci95": _ci(normal_hits, len(normal_rows)),
        "confusion": confusion,
        "mean_confidence_correct": _mean([r["overall_confidence"] for r in correct if r.get("overall_confidence") is not None]),
        "mean_confidence_incorrect": _mean([r["overall_confidence"] for r in incorrect if r.get("overall_confidence") is not None]),
        # Same denominator (scored cases) as the correct/incorrect shares
        # beside it, so the three decompose cleanly; abstained cases are
        # excluded from all of them and counted separately above.
        "flagged_share_of_scored": _share([r.get("disagreement_flagged") for r in scored]),
        "flagged_share_of_correct": _share([r.get("disagreement_flagged") for r in correct]),
        "flagged_share_of_incorrect": _share([r.get("disagreement_flagged") for r in incorrect]),
        "median_wall_seconds": statistics.median(wall_times) if wall_times else None,
    }


def collect_meta(results: list[Record]) -> dict[str, Any]:
    """Provenance for the report, read back from the records themselves."""
    run_times = sorted(r["run_at"] for r in results if r.get("run_at"))
    return {
        "seeds": sorted({r["seed"] for r in results if r.get("seed") is not None}),
        "n_per_class": sorted({r["n_per_class"] for r in results if r.get("n_per_class") is not None}),
        "model_names": sorted({r["model_name"] for r in results if r.get("model_name")}),
        "first_run_at": run_times[0] if run_times else None,
        "last_run_at": run_times[-1] if run_times else None,
    }


# --- report ------------------------------------------------------------------

def _pct(value: float | None) -> str:
    return "n/a" if value is None else f"{value * 100:.1f}%"


def _interval(interval: list[float] | None) -> str:
    return "n/a" if not interval else f"{interval[0] * 100:.1f}% to {interval[1] * 100:.1f}%"


def render_markdown(summary: dict[str, Any], results_meta: dict[str, Any] | None = None) -> str:
    meta = results_meta or {}
    s = summary
    by_label = s["by_true_label"]

    def count(label: str, key: str) -> int:
        return by_label.get(label, {}).get(key, 0)

    sample_bits = []
    if meta.get("seeds"):
        sample_bits.append("sample seed " + ", ".join(map(str, meta["seeds"])))
    if meta.get("n_per_class"):
        sample_bits.append("requested per class: " + ", ".join(map(str, meta["n_per_class"])))
    sample_note = f" ({'; '.join(sample_bits)})" if sample_bits else ""
    models = ", ".join(f"`{m}`" for m in meta.get("model_names") or []) or "not recorded"

    lines = [
        "# Imaging evaluation: chest X-ray, pneumonia vs normal",
        "",
        "> Educational project, not clinical validation. Read the caveats at the bottom before quoting any number here.",
        "",
        "## Setup",
        "",
        f"- Dataset: `{DATASET_ID}`, `{DATASET_SPLIT}` split (624 pediatric chest X-rays), from Kermany, Zhang & "
        "Goldbaum (2018), *Labeled Optical Coherence Tomography (OCT) and Chest X-Ray Images for Classification*, "
        "Mendeley Data V2, doi:10.17632/rscbjbr9sj.2, licensed CC BY 4.0. Labels were graded by two physicians.",
        f"- Cases in this file: {s['n']}{sample_note}.",
        f"- Model(s) recorded: {models} (the model the provider reports as having served each request; "
        "the configured router alias is used only where the provider reported none).",
        f"- Run window: {meta.get('first_run_at') or 'unknown'} to {meta.get('last_run_at') or 'unknown'}.",
        "",
    ]

    def metric_table(block: dict[str, Any]) -> list[str]:
        return [
            "| Metric | Value | 95% CI (Wilson) | Count |",
            "|---|---|---|---|",
            f"| Accuracy | {_pct(block['accuracy'])} | {_interval(block['accuracy_ci95'])} | {block['n_correct']} / {block['n']} |",
            f"| Sensitivity (PNEUMONIA rows, top-1 pneumonia) | {_pct(block['sensitivity'])} | {_interval(block['sensitivity_ci95'])} | {block['n_pneumonia_hit']} / {block['n_pneumonia']} |",
            f"| Specificity (NORMAL rows, top-1 normal) | {_pct(block['specificity'])} | {_interval(block['specificity_ci95'])} | {block['n_normal_hit']} / {block['n_normal']} |",
            f"| Top-3 sensitivity (pneumonia anywhere in top 3) | {_pct(block['top3_sensitivity'])} | {_interval(block['top3_sensitivity_ci95'])} | {block['n_pneumonia_top3_hit']} / {block['n_pneumonia']} |",
        ]

    if s["n_completed"] == 0:
        lines += ["## Results", "", "No completed cases yet (every case errored).", ""]
    else:
        lines += [
            "## Headline: what the model's top-1 says, regardless of abstention",
            "",
            f"Every case that produced an answer (n = {s['n_completed']}). The app still shows an abstained "
            "case's ranked differential, flagged as inconclusive, so this is the model's own top-1 call.",
            "",
            *metric_table(s["ignoring_abstention"]),
            "",
            f"The pipeline abstained (overall confidence below its threshold) on {s['n_abstained']} of "
            f"{s['n_completed']} answered cases: {_pct(s['abstention_rate'])}, 95% CI {_interval(s['abstention_rate_ci95'])}.",
            "",
            f"## If abstention is respected: committed cases only (n = {s['n_scored']})",
            "",
        ]
        if s["n_scored"] == 0:
            lines += ["Every answered case was abstained, so nothing was committed.", ""]
        else:
            lines += [
                *metric_table(s["committed"]),
                "",
                "Neither view alone is the honest picture: abstaining on most cases can flatter this one, "
                "while ignoring the model's own low confidence flatters the headline.",
                "",
            ]
        lines += [
            f"Counting every errored or abstained case as wrong, accuracy is {_pct(s['accuracy_all_cases'])} "
            f"over all {s['n']} cases.",
            "",
        ]

    lines += [
        "## Case accounting",
        "",
        "| | NORMAL | PNEUMONIA | Total |",
        "|---|---|---|---|",
        f"| Total cases | {count('NORMAL', 'n')} | {count('PNEUMONIA', 'n')} | {s['n']} |",
        f"| Scored | {count('NORMAL', 'scored')} | {count('PNEUMONIA', 'scored')} | {s['n_scored']} |",
        f"| Abstained (model confidence below threshold) | {count('NORMAL', 'abstained')} | {count('PNEUMONIA', 'abstained')} | {s['n_abstained']} |",
        f"| Errored (image, network or pipeline failure) | {count('NORMAL', 'errored')} | {count('PNEUMONIA', 'errored')} | {s['n_errored']} |",
        "",
        f"Coverage (scored / total): {_pct(s['coverage'])}.",
        "",
        "## Confusion (scored cases; rows are the truth, columns the model's top-1)",
        "",
        "| Truth | Top-1 pneumonia | Top-1 normal | Top-1 other |",
        "|---|---|---|---|",
    ]
    for label in ("NORMAL", "PNEUMONIA"):
        row = s["confusion"][label]
        lines.append(f"| {label} | {row['pneumonia']} | {row['normal']} | {row['other']} |")

    def confidence(value: float | None) -> str:
        return "n/a" if value is None else f"{value:.2f}"

    lines += [
        "",
        "## Confidence and review flags",
        "",
        f"- Mean overall confidence: {confidence(s['mean_confidence_correct'])} on correct cases, {confidence(s['mean_confidence_incorrect'])} on incorrect ones.",
        f"- Flagged for review (close differential or low confidence): {_pct(s['flagged_share_of_scored'])} of scored cases; "
        f"{_pct(s['flagged_share_of_incorrect'])} of incorrect cases vs {_pct(s['flagged_share_of_correct'])} of correct ones "
        "(abstained cases are excluded from all three).",
        f"- Median pipeline time per case: {confidence(s['median_wall_seconds'])} s.",
        "",
        "## Caveats",
        "",
        "- Single dataset: one set of pediatric chest X-rays (ages 1-5, one hospital). Nothing here says how the pipeline behaves on adults, other scanners, or any other condition.",
        "- Small, class-balanced sample, not the split's natural mix. Accuracy is not a deployment-prevalence estimate, and at this size the intervals above are wide, so small differences between runs or models should not be read as real.",
        "- Free-tier model identity varies run to run. The default `openrouter/free` is a router that can pick a different model on every call (the model that actually served each case is recorded above), so this is a measurement of a moving mix of models, and a re-run can legitimately give a different result.",
        "- The pipeline sends the image alone: these cases have no labs, history or retrieved literature, so the model is judging the picture with an empty text prompt.",
        "- The PNEUMONIA label pools bacterial and viral cases. Scoring is binary against the dataset label; a top-1 that is neither pneumonia nor normal counts as a miss for both classes.",
        "- Free-text condition names are mapped to categories by a keyword heuristic (`categorize_condition`). The raw strings are kept in the results file so anything it misjudges can be audited.",
        "- Images are re-encoded JPEGs wrapped as synthetic DICOM, not real scanner exports.",
        "- Not clinical validation. This measures one educational pipeline on one public dataset.",
        "",
    ]
    return "\n".join(lines)
