"""Build, run and score the evidence-check test set (src/glassbox_md/claim_eval.py).

    # 1. write the labelled items (no model, no network)
    python scripts/eval_claims.py build --out docs/comparison/claim-eval-items.jsonl

    # 2a. score with a judge behind an OpenAI-compatible server that returns logprobs
    DECISION_BASE_URL=http://gpu-host:8000/v1 python scripts/eval_claims.py run \\
        --items docs/comparison/claim-eval-items.jsonl --out docs/comparison/claim-eval-scores.jsonl [--per-class 20]

    # 2b. or score with scripts/biodecision_score.py (Transformers, on any GPU box) and copy the file back

    # 3. report (no model)
    python scripts/eval_claims.py report --items docs/comparison/claim-eval-items.jsonl \\
        --scores docs/comparison/claim-eval-scores.jsonl --judge "BioDecision-4B" --md docs/claim-eval-biodecision.md
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "src"))

from dotenv import load_dotenv  # noqa: E402

from glassbox_md import claim_eval, decision_layer  # noqa: E402


def cmd_build(args: argparse.Namespace) -> int:
    items = claim_eval.build_items()
    claim_eval.write_items(args.out, items)
    by_gold = {g: sum(i.gold == g for i in items) for g in claim_eval.GOLDS}
    print(f"Wrote {len(items)} items to {args.out}: {by_gold}")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    backend = decision_layer.backend_from_env()
    if backend is None:
        print("DECISION_BASE_URL is not set: nothing to score with. See .env.example.", file=sys.stderr)
        return 2
    items = claim_eval.load_items(args.items)
    if args.per_class:
        items = claim_eval.sample(items, args.per_class, args.seed)
    out = Path(args.out)
    done = set(claim_eval.load_scores(out)) if out.exists() else set()
    todo = [i for i in items if i.item_id not in done]
    print(f"{len(items)} items, {len(done & {i.item_id for i in items})} already scored, {len(todo)} to score with {backend.name}")
    with out.open("a", encoding="utf-8") as handle:
        for record in claim_eval.run_backend(todo, backend):
            handle.write(json.dumps(record) + "\n")
            handle.flush()
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    items = claim_eval.load_items(args.items)
    scores = claim_eval.load_scores(args.scores)
    scored_ids = set(scores)
    items = [i for i in items if i.item_id in scored_ids] if args.only_scored else items
    meta_path = Path(str(args.scores) + ".meta.json")
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else None
    markdown = claim_eval.render_markdown(claim_eval.score(items, scores), args.judge, meta)
    if args.md:
        Path(args.md).write_text(markdown, encoding="utf-8")
        print(f"Wrote {args.md}")
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

    build = commands.add_parser("build")
    build.add_argument("--out", required=True)
    build.set_defaults(handler=cmd_build)

    run = commands.add_parser("run")
    run.add_argument("--items", required=True)
    run.add_argument("--out", required=True)
    run.add_argument("--per-class", type=int, default=0, help="score a class-balanced subset of N per class")
    run.add_argument("--seed", type=int, default=0)
    run.set_defaults(handler=cmd_run)

    report = commands.add_parser("report")
    report.add_argument("--items", required=True)
    report.add_argument("--scores", required=True)
    report.add_argument("--judge", default="judge model")
    report.add_argument("--md")
    report.add_argument("--only-scored", action="store_true", help="score only the items present in --scores (for a subset run)")
    report.set_defaults(handler=cmd_report)

    args = parser.parse_args()
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
