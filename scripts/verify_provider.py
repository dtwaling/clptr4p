#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "pyyaml>=6.0,<7",
# ]
# ///
"""End-to-end verification of the clptr4p Hermes memory provider.

Exercises the installed provider (Hermes plugin discovery) against the live
vault: discovery, availability, prefetch (policy-gated recall), both tools
(context fetch + propose), and the denial surface for ungranted predicates.
The test proposal is rejected by this script itself via review.ts, so the run
leaves no residue.

Configuration (flags override env vars override defaults):
    --hermes-dir   Hermes source tree to import the plugin loader from
                   (env HERMES_AGENT_DIR, default ~/.hermes/hermes-agent)
    --vault-dir    clptr4p vault directory
                   (env CLPTR4P_VAULT_DIR, default <repo>/vault next to this script)
    --deno         deno binary (env CLPTR4P_DENO, default `deno` on PATH)


Required env (same vars the provider needs, typically from ~/.hermes/.env):
    GATEWAY_DATABASE_URL, VAULT_DEK

Exit 0 = all checks passed. Any failure exits 1 with a message.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid
from typing import NoReturn

EXPECTED_PREFETCH_MIN = 1  # at least one claim must be served by prefetch
VERIFY_PRINCIPAL = "urn:cl:verify"
DEFAULT_SUBJECT = "vault://subjects/primary"
VERIFY_PREFETCH_SELECTORS = "preferred_name"


def fail(msg: str) -> NoReturn:
    print(f"FAIL: {msg}")
    sys.exit(1)


def load_database_urls(vault_dir: str) -> dict[str, str]:
    database_urls: dict[str, str] = {}
    env_file = os.path.join(vault_dir, ".env")
    if os.path.isfile(env_file):
        with open(env_file, encoding="utf-8") as f:
            for line in f:
                for name in ("DATABASE_URL", "REVIEWER_DATABASE_URL"):
                    if line.startswith(f"{name}="):
                        database_urls[name] = line.split("=", 1)[1].strip()
    for name in ("DATABASE_URL", "REVIEWER_DATABASE_URL"):
        if not database_urls.get(name):
            fail(f"{name} not found in vault/.env")
    return database_urls


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def run_sql(args: argparse.Namespace, database_url: str, statement: str) -> list[dict[str, object]]:
    result = subprocess.run(
        [
            args.deno, "run",
            "--allow-net=127.0.0.1:5433", "--allow-env",
            f"--allow-read={args.vault_dir}",
            os.path.join(args.vault_dir, "psql.ts"),
        ],
        env={**os.environ, "DATABASE_URL": database_url},
        cwd=args.vault_dir, input=statement, capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        fail(f"SQL verification setup failed: {result.stdout} {result.stderr}")
    try:
        rows = json.loads(result.stdout)
    except json.JSONDecodeError:
        fail(f"SQL verification setup returned invalid JSON: {result.stdout}")
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        fail(f"SQL verification setup returned unexpected rows: {rows}")
    return rows


@contextmanager
def temporarily_promote_prefetch_claim(
    args: argparse.Namespace, reviewer_database_url: str, subject: str,
):
    rows = run_sql(
        args,
        reviewer_database_url,
        f"""WITH candidate AS (
             SELECT id, injection_tier
             FROM claims
             WHERE subject_ref = {sql_literal(subject)}
               AND predicate = 'preferred_name'
               AND superseded_by IS NULL
               AND (valid_from IS NULL OR valid_from <= now())
               AND (valid_to IS NULL OR valid_to > now())
             ORDER BY created_at ASC, id ASC
             LIMIT 1
           )
           UPDATE claims AS claim
           SET injection_tier = 'core'
           FROM candidate
           WHERE claim.id = candidate.id
           RETURNING claim.id, candidate.injection_tier AS previous_tier;""",
    )
    if len(rows) != 1 or not isinstance(rows[0].get("id"), str):
        fail(f"could not promote one archive verify claim for prefetch: {rows}")
    claim_id = rows[0]["id"]
    previous_tier = rows[0].get("previous_tier")
    assert isinstance(claim_id, str)
    try:
        yield claim_id
    finally:
        if previous_tier == 'archive':
            restored = run_sql(
                args,
                reviewer_database_url,
                "UPDATE claims SET injection_tier = 'archive' "
                f"WHERE id = {sql_literal(claim_id)} RETURNING id, injection_tier;",
            )
            if restored != [{"id": claim_id, "injection_tier": "archive"}]:
                fail(f"could not restore prefetch claim tier: {restored}")


def main() -> None:
    script_dir = os.path.dirname(os.path.abspath(__file__))
    defaults = {
        "hermes_dir": os.environ.get("HERMES_AGENT_DIR")
        or os.path.expanduser("~/.hermes/hermes-agent"),
        "vault_dir": os.environ.get("CLPTR4P_VAULT_DIR")
        or os.path.join(os.path.dirname(script_dir), "vault"),
        "deno": os.environ.get("CLPTR4P_DENO") or "deno",
    }
    parser = argparse.ArgumentParser(description=( __doc__ or "").splitlines()[0])
    parser.add_argument("--hermes-dir", default=defaults["hermes_dir"],
                        help="Hermes source tree (plugin loader imports)")
    parser.add_argument("--vault-dir", default=defaults["vault_dir"],
                        help="clptr4p vault directory (review.ts + .env)")
    parser.add_argument("--deno", default=defaults["deno"],
                        help="deno binary path")
    args = parser.parse_args()

    for var in ("GATEWAY_DATABASE_URL", "VAULT_DEK"):
        if not os.environ.get(var):
            fail(f"missing env var {var} (source from ~/.hermes/.env)")
    if not os.path.isdir(args.hermes_dir):
        fail(f"Hermes source tree not found: {args.hermes_dir}")
    if not os.path.isfile(os.path.join(args.vault_dir, "review.ts")):
        fail(f"review.ts not found under: {args.vault_dir}")

    sys.path.insert(0, os.path.abspath(args.hermes_dir))
    from plugins.memory import load_memory_provider  # noqa: E402

    # The live subject may have archive claims for other granted selectors.
    # Exercise the core-only prefetch path with the fixture predicate alone.
    os.environ["CLPTR4P_SELECTORS"] = VERIFY_PREFETCH_SELECTORS

    # 1. Discovery + availability
    p = load_memory_provider("clptr4p")
    if p is None:
        fail("provider not discovered by Hermes plugin loader")
    if not p.is_available():
        fail(f"provider unavailable: {p.unavailable_reason()}")
    print("ok    discovery + availability")

    # 2. Initialize
    p.initialize("verify-provider", platform="test")
    print("ok    initialize")

    database_urls = load_database_urls(args.vault_dir)
    subject = os.environ.get("CLPTR4P_SUBJECT", DEFAULT_SUBJECT)

    # 3. Prefetch serves only human-stamped core claims. The shared verifier
    # fixture is intentionally archive-tier by default, so promote one claim
    # only while checking prefetch and restore it even if this check fails.
    # Budget boundary behavior is covered separately by
    # scripts/verify_prefetch_budget.py against an isolated fixture.
    with temporarily_promote_prefetch_claim(
        args, database_urls["REVIEWER_DATABASE_URL"], subject,
    ):
        ctx = p.prefetch("verify provider end-to-end")
        lines = [l for l in (ctx or "").splitlines() if l.startswith("-")]
        if len(lines) < EXPECTED_PREFETCH_MIN:
            fail(f"prefetch served {len(lines)} claims, expected >= {EXPECTED_PREFETCH_MIN}")
        status = p.recall_status()
        if status is None or status.count < EXPECTED_PREFETCH_MIN:
            fail("recall_status missing or wrong count")
        print(f"ok    prefetch ({status.count} claims)")

    # 4. Context tool: granted predicate returns a claim
    out = json.loads(p.handle_tool_call("clptr4p_context", {"predicates": ["preferred_name"]}))
    if not out.get("success") or not out.get("claims"):
        fail(f"context tool returned no claims: {out}")
    print(f"ok    clptr4p_context ({out['claims'][0]['predicate']})")

    # 5. Context tool: ungranted predicate returns empty (policy denial)
    out = json.loads(p.handle_tool_call("clptr4p_context", {"predicates": ["salary"]}))
    if not out.get("success") or out.get("claims"):
        fail(f"ungranted predicate leaked claims: {out}")
    print("ok    ungranted predicate denied")

    # 6. Propose tool queues a reviewable proposal. Use a fresh value per
    # verifier invocation so an earlier rejected fixture cannot be reused;
    # repeat this exact value below to exercise retry idempotence.
    verify_value = f"provider verification run {uuid.uuid4().hex}"
    out = json.loads(p.handle_tool_call("clptr4p_propose", {
        "predicate": "x.verify.artifact",
        "value": verify_value,
        "claim": "the clptr4p provider verification script ran successfully",
        "rationale": "verify_provider.py artifact; auto-rejected by the script",
    }))
    proposal_id = out.get("proposal_id", "")
    if not out.get("success") or out.get("status") != "pending_validation" or not proposal_id:
        fail(f"propose did not queue a proposal: {out}")
    print(f"ok    clptr4p_propose queued ({proposal_id})")

    # The same proposed fact must retain its identifier on retry. Postgres
    # treats that identifier as idempotent (ON CONFLICT DO NOTHING), so this
    # prevents a second pending queue row after an uncertain client retry.
    retry = json.loads(p.handle_tool_call("clptr4p_propose", {
        "predicate": "x.verify.artifact",
        "value": verify_value,
        "claim": "the clptr4p provider verification script ran successfully",
        "rationale": "verify_provider.py artifact; auto-rejected by the script",
    }))
    if (not retry.get("success") or retry.get("status") != "pending_validation"
            or retry.get("proposal_id") != proposal_id):
        fail(f"retry did not reuse proposal id: {retry}")
    print("ok    clptr4p_propose retry reused proposal id")

    p.shutdown()

    # 7. Cleanup: reject our own proposal under the explicit verifier machine
    # principal, then confirm the persisted source event records that actor.
    result = subprocess.run(
        [
            args.deno, "run",
            "--allow-net=127.0.0.1:5433", "--allow-env",
            f"--allow-read={args.vault_dir}",
            os.path.join(args.vault_dir, "review.ts"),
            "reject", proposal_id, "--reason", "verify_provider.py artifact",
        ],
        env={**os.environ, "REVIEWER_DATABASE_URL": database_urls["REVIEWER_DATABASE_URL"],
             "REVIEWER_PRINCIPAL": VERIFY_PRINCIPAL},
        cwd=args.vault_dir, capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0 or "rejected" not in result.stdout:
        fail(f"cleanup reject failed: {result.stdout} {result.stderr}")
    event_match = re.search(r"\(event (urn:cl:event:[0-9a-f]+),", result.stdout)
    if not event_match:
        fail(f"cleanup reject did not report an event id: {result.stdout}")
    sql_path = ""
    audit: subprocess.CompletedProcess[str] | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".sql", prefix="verify-provider-", dir=args.vault_dir,
            encoding="utf-8", delete=False,
        ) as sql_file:
            sql_path = sql_file.name
            sql_file.write(
                "SELECT actor FROM source_events "
                f"WHERE id = '{event_match.group(1)}';\n"
            )
        with open(sql_path, encoding="utf-8") as sql_file:
            audit = subprocess.run(
                [
                    args.deno, "run",
                    "--allow-net=127.0.0.1:5433", "--allow-env",
                    f"--allow-read={args.vault_dir}",
                    os.path.join(args.vault_dir, "psql.ts"),
                ],
                env={**os.environ, "DATABASE_URL": database_urls["DATABASE_URL"]},
                cwd=args.vault_dir, stdin=sql_file, capture_output=True, text=True, timeout=60,
            )
    finally:
        if sql_path:
            os.unlink(sql_path)
    if audit is None:
        fail("cleanup audit did not run")
    if audit.returncode != 0:
        fail(f"cleanup audit failed: {audit.stdout} {audit.stderr}")
    try:
        actors = json.loads(audit.stdout)
    except json.JSONDecodeError:
        fail(f"cleanup audit returned invalid JSON: {audit.stdout}")
    if actors != [{"actor": VERIFY_PRINCIPAL}]:
        fail(f"cleanup rejection recorded wrong actor: {actors}")
    print(f"ok    proposal rejected as {VERIFY_PRINCIPAL} (no residue)")

    print("PROVIDER VERIFY OK")


if __name__ == "__main__":
    main()
