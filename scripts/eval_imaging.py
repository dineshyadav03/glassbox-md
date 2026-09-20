"""Runs the pipeline over a seeded sample of real chest X-rays and reports
how often its top-1 call matches the dataset label.

This is a deliberate, slow, networked step -- not part of the test suite.
`run` downloads images from the public Hugging Face dataset
`hf-vision/chest-xray-pneumonia` into a temp dir (never into the repo),
wraps each as a synthetic DICOM, and sends it through the real six-agent
pipeline, which calls OpenRouter (free-tier latency is ~70s per case, so
24 cases takes half an hour or more). Each finished case is appended to
the results file immediately; if the run dies, `--resume` picks up where
it stopped. `report` turns a results file into a Markdown summary with
confidence intervals and caveats, and needs neither the network nor an API key.

Usage:
    python scripts/eval_imaging.py run --n-per-class 12 --seed 0 --out docs/imaging-eval-results.jsonl [--resume] [--sleep 3]
    python scripts/eval_imaging.py report --in docs/imaging-eval-results.jsonl --md docs/imaging-eval-results.md

Reads OPENROUTER_API_KEY (and optionally OPENROUTER_MODEL) from .env,
same as the app.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "src"))

from dotenv import load_dotenv  # noqa: E402

from glassbox_md import imaging_eval  # noqa: E402

DEFAULT_RESULTS = REPO_ROOT / "docs" / "imaging-eval-results.jsonl"
DEFAULT_REPORT = REPO_ROOT / "docs" / "imaging-eval-results.md"


def cmd_run(args: argparse.Namespace) -> int:
    if not args.dry_run and not os.environ.get("OPENROUTER_API_KEY"):
        print(
            "OPENROUTER_API_KEY is not set. Add it to .env (see .env.example) -- the pipeline's "
            "Diagnostic Prediction step calls OpenRouter for every case, so nothing can run without it. "
            "Use --dry-run to preview the sample without a key.",
            file=sys.stderr,
        )
        return 2

    out = Path(args.out)
    resume = args.resume or args.retry_errors
    if out.exists() and out.stat().st_size > 0 and not resume and not args.dry_run:
        print(
            f"{out} already has results. Pass --resume to continue that run (add --retry-errors to re-run "
            "cases that errored), or choose a different --out.",
            file=sys.stderr,
        )
        return 2

    if resume and not args.dry_run:
        conflict = imaging_eval.resume_seed_conflict(out, args.seed)
        if conflict:
            print(conflict, file=sys.stderr)
            return 2

    print("Reading labels for the full test split ...")
    try:
        label_map = imaging_eval.fetch_label_map()
        sample = imaging_eval.sample_rows(label_map, args.n_per_class, args.seed)
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"Could not build the sample: {exc}", file=sys.stderr)
        return 1

    if args.dry_run:
        print(f"Sample for seed {args.seed}, {args.n_per_class} per class ({len(sample)} rows):")
        for row_idx, label in sample:
            print(f"  row {row_idx}: {label}")
        return 0

    skip = imaging_eval.completed_rows(out, retry_errors=args.retry_errors) if resume else set()
    already_done = skip & {idx for idx, _ in sample}
    remaining = len(sample) - len(already_done)
    print(f"{len(sample)} cases sampled, {len(already_done)} already done, {remaining} to run.")
    if remaining == 0:
        return 0

    # Imported here so `report` and `--dry-run` don't pay for langgraph,
    # chromadb and presidio just to read a file.
    from glassbox_md.pipeline import build_pipeline_graph

    ran = imaging_eval.run_eval(
        sample,
        out,
        graph=build_pipeline_graph(),  # llm_caller=None, rag_collection=None: the real OpenRouter call
        skip=skip,
        sleep_seconds=args.sleep,
        tags={"seed": args.seed, "n_per_class": args.n_per_class},
    )
    print(f"Ran {ran} case(s); results are in {out}. Next: python scripts/eval_imaging.py report --in {out}")
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    source = Path(args.input)
    if not source.exists():
        print(f"No results file at {source}. Run `run` first.", file=sys.stderr)
        return 1
    results = imaging_eval.load_results(source)
    if not results:
        print(f"{source} has no readable records.", file=sys.stderr)
        return 1

    summary = imaging_eval.summarize(results)
    markdown = imaging_eval.render_markdown(summary, imaging_eval.collect_meta(results))
    if args.md:
        target = Path(args.md)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(markdown, encoding="utf-8")
        print(f"Wrote {target} ({summary['n']} cases, {summary['n_scored']} scored).")
    else:
        print(markdown)
    return 0


def main() -> int:
    load_dotenv()
    # A 30+ minute run is usually redirected to a file, where Windows Python
    # defaults stdout to cp1252; model text with characters outside it must
    # not be able to raise mid-run.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)

    run = commands.add_parser("run", help="run the pipeline over a sample and append results to a JSONL file")
    run.add_argument("--n-per-class", type=int, default=12, help="cases per class (default 12 NORMAL + 12 PNEUMONIA)")
    run.add_argument("--seed", type=int, default=0, help="sampling seed (default 0)")
    run.add_argument("--out", default=str(DEFAULT_RESULTS), help="results JSONL (default docs/imaging-eval-results.jsonl)")
    run.add_argument("--resume", action="store_true", help="skip row indices already in --out")
    run.add_argument("--retry-errors", action="store_true", help="implies --resume, but re-runs rows whose last attempt errored")
    run.add_argument("--sleep", type=float, default=3.0, help="seconds to pause between cases (default 3)")
    run.add_argument("--dry-run", action="store_true", help="print the sampled rows and exit; no images, no LLM calls")
    run.set_defaults(handler=cmd_run)

    report = commands.add_parser("report", help="summarize a results file as Markdown")
    report.add_argument("--in", dest="input", default=str(DEFAULT_RESULTS), help="results JSONL to read")
    report.add_argument("--md", help="write the report here (default: print to stdout)")
    report.set_defaults(handler=cmd_report)

    args = parser.parse_args()
    if getattr(args, "sleep", 0) < 0 or getattr(args, "n_per_class", 1) < 1:
        parser.error("--sleep must be >= 0 and --n-per-class must be >= 1")
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())
