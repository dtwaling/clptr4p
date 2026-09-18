#!/usr/bin/env python3
"""Export the Honcho workspace (peer card, conclusions, representation,
session index) to JSON files for review before any migration to clptr4p.

Read-only against Honcho. Writes one JSON file per artifact into --out-dir
(default honcho-export-<UTC timestamp>/). Never ingests anything -- curation
and ingest stay with the capture pipeline (envelopes + review).

Configuration (flags override env vars override defaults):
    --host        honcho.json host block (default: hermes)
    --peer        peer (user) whose card is exported
                  (env CLPTR4P_EXPORT_PEER, default: Dustin)
    --ai-peer     peer whose conclusions are queried
                  (env CLPTR4P_EXPORT_AI_PEER, default: hermes)
    --out-dir     output directory (default: honcho-export-<UTC timestamp>)
    --messages    also dump per-session message counts (not contents)
    --hermes-dir  Hermes source tree to import the Honcho config from
                  (env HERMES_AGENT_DIR, default ~/.hermes/hermes-agent)

Exit 0 = export written. Uses the same HonchoClientConfig the Hermes plugin
uses, so credentials/config resolution are identical to production.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, List


def write(out_dir: str, name: str, payload: Any) -> None:
    path = os.path.join(out_dir, name)
    with open(path, "w") as f:
        json.dump(payload, f, indent=2, default=str)
    print(f"wrote {name}")


def main() -> None:
    parser = argparse.ArgumentParser(description=( __doc__ or "").splitlines()[0])
    parser.add_argument("--host", default="hermes",
                        help="honcho.json host block")
    parser.add_argument("--peer", default=os.environ.get("CLPTR4P_EXPORT_PEER") or "Dustin",
                        help="peer (user) whose card is exported")
    parser.add_argument("--ai-peer", default=os.environ.get("CLPTR4P_EXPORT_AI_PEER") or "hermes",
                        help="peer whose conclusions are queried")
    parser.add_argument("--out-dir", default=None,
                        help="output directory (default: honcho-export-<timestamp>)")
    parser.add_argument("--messages", action="store_true",
                        help="also dump per-session message counts (not contents)")
    parser.add_argument("--hermes-dir",
                        default=os.environ.get("HERMES_AGENT_DIR")
                        or os.path.expanduser("~/.hermes/hermes-agent"),
                        help="Hermes source tree (Honcho config imports)")
    args = parser.parse_args()

    if not os.path.isdir(args.hermes_dir):
        print(f"FAIL: Hermes source tree not found: {args.hermes_dir}")
        sys.exit(1)
    sys.path.insert(0, os.path.abspath(args.hermes_dir))

    from honcho import Honcho  # noqa: E402
    from plugins.memory.honcho.client import HonchoClientConfig  # noqa: E402

    cfg = HonchoClientConfig.from_global_config(host=args.host)
    c = Honcho(workspace_id=cfg.workspace_id, api_key=cfg.api_key)

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = args.out_dir or f"honcho-export-{ts}"
    os.makedirs(out_dir, exist_ok=True)

    # Peer list (who exists in the workspace)
    peers_page = c.peers()
    peers = []
    page = peers_page
    while page:
        peers.extend({"id": p.id, "metadata": p.metadata} for p in page.items)
        page = page.get_next_page() if page.has_next_page else None
    write(out_dir, "peers.json", peers)

    # Peer card for the user -- the high-signal tier
    peer = c.peer(args.peer)
    card = peer.get_card()
    write(out_dir, "peer_card.json", {"peer": args.peer, "entries": list(card or [])})

    # Conclusions (all, unfiltered -- curation happens on review)
    conclusions: List[str] = []
    lst = peer.conclusions_of(args.ai_peer).list()
    items = lst.items if hasattr(lst, "items") else lst
    conclusions.extend(str(x) for x in items)
    write(out_dir, "conclusions.json", conclusions)

    # Dialectic representation (timestamped observations)
    rep = peer.representation()
    write(out_dir, "representation.json", str(rep))

    # Session index (names + message counts only; no contents)
    sessions = []
    page = c.sessions()
    while page:
        for s in page.items:
            entry: Any = {"id": s.id, "name": getattr(s, "name", None)}
            if args.messages:
                # SessionResponse.typeshed lacks .messages but the runtime object has it.
                get_messages = getattr(s, "messages", None)
                if callable(get_messages):
                    msgs = get_messages()
                    total = getattr(msgs, "total", None)
                    entry["message_count"] = total if total is not None else len(getattr(msgs, "items", []))
            sessions.append(entry)
        page = page.get_next_page() if page.has_next_page else None
    write(out_dir, "sessions.json", sessions)

    print(f"HONCHO EXPORT OK -> {out_dir}")


if __name__ == "__main__":
    main()
