"""Runs the pipeline over the synthetic text-only case set (six lab/history
conditions, comorbid cases, and normal controls) and scores it.

Each case is rendered as a PDF (history paragraph + lab table) and sent through
the real six-agent graph, so the whole path from upload to differential is
exercised. Results are appended to a JSONL file as they finish; `--resume`
skips cases already in it. `report` needs neither the network nor an API key.

Usage:
    python scripts/eval_text.py run --out docs/comparison/text-medgemma1.5-local.jsonl --label medgemma1.5-local [--resume]
    python scripts/eval_text.py report --in docs/comparison/text-medgemma1.5-local.jsonl --md docs/text-eval-results.md

Model selection is the app's: OPENROUTER_API_KEY / OPENROUTER_MODEL from .env, or
LLM_BASE_URL (+ OPENROUTER_MODEL as the model name) for a local server.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "src"))

from dotenv import load_dotenv  # noqa: E402

from glassbox_md import text_eval  # noqa: E402


def cmd_run(args: argparse.Namespace) -> int:
    local_endpoint = os.environ.get("LLM_BASE_URL")
    if not local_endpoint and not os.environ.get("OPENROUTER_API_KEY"):
        print("OPENROUTER_API_KEY is not set (and no LLM_BASE_URL): nothing can run. See .env.example.", file=sys.stderr)
        return 2
    out = Path(args.out)
    resume = args.resume or args.retry_errors
    if out.exists() and out.stat().st_size > 0 and not resume:
        print(f"{out} already has results. Pass --resume (add --retry-errors to redo errored cases) or choose another --out.", file=sys.stderr)
        return 2
    skip = text_eval.completed_ids(out, retry_errors=args.retry_errors) if resume else set()
    remaining = len(text_eval.CASES) - len(skip & set(text_eval.case_ids()))
    print(f"Model endpoint: {local_endpoint or 'OpenRouter'}; model: {os.environ.get('OPENROUTER_MODEL', 'openrouter/free')}")
    print(f"{len(text_eval.CASES)} cases, {len(text_eval.CASES) - remaining} already done, {remaining} to run.")
    if remaining == 0:
        return 0

    from glassbox_md.pipeline import build_pipeline_graph  # heavy imports only when actually running

    ran = text_eval.run_eval(
        out,
        graph=build_pipeline_graph(),
        skip=skip,
        sleep_seconds=args.sleep,
        tags={"backend": args.label} if args.label else {},
    )
    print(f"Ran {ran} case(s); results are in {out}.")
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    source = Path(args.input)
    if not source.exists():
        print(f"No results file at {source}.", file=sys.stderr)
        return 1
    records = text_eval.load_records(source)
    if not records:
        print(f"{source} has no readable records.", file=sys.stderr)
        return 1
    markdown = text_eval.render_markdown(text_eval.summarize(records))
    if args.md:
        target = Path(args.md)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(markdown, encoding="utf-8")
        print(f"Wrote {target}.")
    else:
        print(markdown)
    return 0


def main() -> int:
    load_dotenv()
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)

    run = commands.add_parser("run", help="run the case set and append results to a JSONL file")
    run.add_argument("--out", required=True)
    run.add_argument("--label", help="arm label stamped on every record as `backend`")
    run.add_argument("--resume", action="store_true")
    run.add_argument("--retry-errors", action="store_true", help="implies --resume, re-running cases whose last attempt errored")
    run.add_argument("--sleep", type=float, default=2.0)
    run.set_defaults(handler=cmd_run)

    report = commands.add_parser("report", help="summarize a results file as Markdown")
    report.add_argument("--in", dest="input", required=True)
    report.add_argument("--md")
    report.set_defaults(handler=cmd_report)

    args = parser.parse_args()
    if getattr(args, "sleep", 0) < 0:
        parser.error("--sleep must be >= 0")
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
