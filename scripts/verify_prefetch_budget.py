#!/usr/bin/env python3
"""Verify a clptr4p provider prefetch stays within its configured budget.

This is a test helper. Point CLPTR4P_SUBJECT and CLPTR4P_SELECTORS at an
isolated, policy-granted test fixture before running it. The provider must be
installed in the active Hermes home.
"""

from __future__ import annotations

import argparse
import os
import sys


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expect-empty", action="store_true",
                        help="require an empty prefetch (for a budget below the header size)")
    parser.add_argument("--require", default="",
                        help="text that must be present in a non-empty prefetch")
    parser.add_argument("--forbid", default="",
                        help="text that must not be present in the prefetch")
    args = parser.parse_args()

    hermes_dir = os.environ.get("HERMES_AGENT_DIR") or os.path.expanduser("~/.hermes/hermes-agent")
    if not os.path.isdir(hermes_dir):
        raise SystemExit(f"Hermes source tree not found: {hermes_dir}")
    sys.path.insert(0, hermes_dir)
    from plugins.memory import load_memory_provider  # noqa: PLC0415

    provider = load_memory_provider("clptr4p")
    if provider is None or not provider.is_available():
        raise SystemExit("clptr4p provider unavailable")
    provider.initialize("verify-prefetch-budget", platform="test")
    try:
        text = provider.prefetch("verify prefetch budget")
        budget = int(os.environ.get("CLPTR4P_PREFETCH_MAX_CHARS", "11000"))
        if len(text) > budget:
            raise SystemExit(f"prefetch is {len(text)} chars, exceeds {budget}-char budget")
        if args.expect_empty and text:
            raise SystemExit(f"expected empty prefetch, got {len(text)} chars")
        if not args.expect_empty and not text:
            raise SystemExit("expected non-empty prefetch")
        if args.require and args.require not in text:
            raise SystemExit(f"required text missing: {args.require!r}")
        if args.forbid and args.forbid in text:
            raise SystemExit(f"forbidden text present: {args.forbid!r}")
        print(f"PREFETCH BUDGET OK ({len(text)}/{budget} chars)")
    finally:
        provider.shutdown()


if __name__ == "__main__":
    main()
