"""Compare two imaging-evaluation arms run on the same sampled rows.

Reads results files written by `scripts/eval_imaging.py` (no network, no
API key). Each arm may be several files, one per repeat pass; the first
file is the headline, the rest feed the run-to-run stability figures.

Usage:
    python scripts/compare_imaging.py \
        --a docs/cmp/openrouter-pass1.jsonl docs/cmp/openrouter-pass2.jsonl --label-a "OpenRouter free" \
        --b docs/cmp/medgemma-local.jsonl --label-b "MedGemma 1.5 (local)" \
        --md docs/imaging-comparison.md
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "src"))

from glassbox_md import imaging_compare  # noqa: E402


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--a", nargs="+", required=True, help="results file(s) for arm A (first = headline pass)")
    parser.add_argument("--b", nargs="+", required=True, help="results file(s) for arm B (first = headline pass)")
    parser.add_argument("--label-a", default="A")
    parser.add_argument("--label-b", default="B")
    parser.add_argument("--note", action="append", default=[], help="a line for the report's notes section (repeatable)")
    parser.add_argument("--md", help="write the report here (default: print)")
    args = parser.parse_args()

    for path in args.a + args.b:
        if not Path(path).exists():
            print(f"No results file at {path}.", file=sys.stderr)
            return 1
    arm_a = imaging_compare.load_arm(args.a)
    arm_b = imaging_compare.load_arm(args.b)
    if not arm_a[0] or not arm_b[0]:
        print("An arm's first file has no readable records.", file=sys.stderr)
        return 1

    markdown = imaging_compare.render_markdown(
        imaging_compare.compare(arm_a, arm_b), args.label_a, args.label_b, args.note
    )
    if args.md:
        target = Path(args.md)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(markdown, encoding="utf-8")
        print(f"Wrote {target}.")
    else:
        print(markdown)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
