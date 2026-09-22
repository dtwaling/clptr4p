"""clptr4p memory plugin -- MemoryProvider backed by the Context Layer gateway.

Zero-trust memory for Hermes: this provider is a thin MCP stdio client to the
deployed clptr4p Policy Gateway (Deno, vault-backed Postgres).

  reads  -> gateway context_request (purpose retrieve.context, policy-gated)
  writes -> gateway memory_propose (queued for HUMAN review; never direct)

Builtin Hermes memory writes remain Hermes-local. Durable vault facts flow only
through deliberate clptr4p_propose calls, where consent stays with the human.

Config (env, resolved from ~/.hermes/.env):
  GATEWAY_DATABASE_URL   gateway DB connection string (required)
  VAULT_DEK              vault data encryption key (required)
  CLPTR4P_SELECTORS      comma list of predicates to prefetch (optional;
                         default: preferred_name,comm.style,formatting.rule)
  CLPTR4P_PREFETCH_MAX_CHARS  max prefetch characters (default: 11000)
  CLPTR4P_SUBJECT        subject_ref (default vault://subjects/primary)
  CLPTR4P_DENO           deno binary override
  CLPTR4P_GATEWAY_ENTRY  gateway main.ts override
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider, RecallStatus, is_trivial_prompt
from tools.registry import tool_error

logger = logging.getLogger(__name__)

_DEFAULT_SELECTORS = ("preferred_name,comm.style,formatting.rule,tech.stack,"
                      "notes.tool,skill.rule,skill.cadence,project.active,repo.remote,"
                      "hermes.setup,tools.convention,project.audio2midi,"
                      "skill.scanner,terminal.guard,browser.testing,daemon.spawn,"
                      "ghcli.regression,skill.authoring,github.ops,gateway.setup,"
                      "ob1l.legacy,desktop.quirks,profile.rule,kanban.dispatcher,"
                      "clptr4p.ops")
_DEFAULT_SUBJECT = "vault://subjects/primary"
_DEFAULT_DENO = "/home/dtdubs/.deno/bin/deno"
_DEFAULT_ENTRY = "/mnt/bro/thinktank/clptr4p/gateway/main.ts"
_PREFETCH_TTL_S = 60.0
_CALL_TIMEOUT_S = 15.0
_DEFAULT_PREFETCH_MAX_CHARS = 11000


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _iso_later(seconds: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")




class _GatewayClient:
    """Minimal MCP stdio client for the clptr4p gateway. Thread-safe; one
    in-flight call at a time (serialized by lock); lazily (re)spawned."""

    def __init__(self) -> None:
        self._proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()
        self._next_id = 0
        self._responses: Dict[int, Dict[str, Any]] = {}
        self._cond = threading.Condition()
        self._reader: Optional[threading.Thread] = None

    # -- lifecycle ---------------------------------------------------------

    def _spawn(self) -> subprocess.Popen:
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": os.environ.get("HOME", "/home/dtdubs"),
            "LANG": os.environ.get("LANG", "C.UTF-8"),
            "GATEWAY_DATABASE_URL": os.environ.get("GATEWAY_DATABASE_URL", ""),
            "VAULT_DEK": os.environ.get("VAULT_DEK", ""),
        }
        entry = os.environ.get("CLPTR4P_GATEWAY_ENTRY", _DEFAULT_ENTRY)
        deno = os.environ.get("CLPTR4P_DENO", _DEFAULT_DENO)
        entry_dir = os.path.dirname(entry)
        cmd = [
            deno, "run",
            f"--allow-read={entry_dir},{os.path.join(os.path.dirname(entry_dir), 'context-layer-reference')}",
            f"--allow-write={os.path.join(os.path.dirname(entry_dir), 'vault', 'data')}",
            "--allow-env",
            "--allow-net=127.0.0.1:5433",
            entry,
        ]
        proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=env, cwd=entry_dir,
        )
        self._reader = threading.Thread(target=self._read_loop, args=(proc,), daemon=True,
                                        name="clptr4p-mcp-reader")
        self._reader.start()
        # Drain stderr on a side thread (Deno logs its banner there).
        threading.Thread(target=self._drain_stderr, args=(proc,), daemon=True,
                         name="clptr4p-mcp-stderr").start()
        # MCP handshake
        init_id = self._alloc_id()
        self._send(proc, {
            "jsonrpc": "2.0", "id": init_id,
            "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                       "clientInfo": {"name": "hermes-clptr4p-provider", "version": "1.0.0"}},
        })
        init = self._wait(init_id, timeout=_CALL_TIMEOUT_S)
        if init is None or "error" in init:
            proc.kill()
            raise RuntimeError(f"gateway initialize failed: {init}")
        self._send(proc, {"jsonrpc": "2.0", "method": "notifications/initialized"})
        return proc

    def _drain_stderr(self, proc: subprocess.Popen) -> None:
        try:
            for line in proc.stderr:  # type: ignore[union-attr]
                logger.debug("clptr4p gateway stderr: %s", line.decode(errors="replace").rstrip())
        except Exception:
            pass

    def _read_loop(self, proc: subprocess.Popen) -> None:
        try:
            for line in proc.stdout:  # type: ignore[union-attr]
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(msg.get("id"), int):
                    with self._cond:
                        self._responses[msg["id"]] = msg
                        self._cond.notify_all()
        except Exception:  # process died or pipe closed
            with self._cond:
                self._cond.notify_all()

    def _alloc_id(self) -> int:
        self._next_id += 1
        return self._next_id

    @staticmethod
    def _send(proc: subprocess.Popen, payload: Dict[str, Any]) -> None:
        if proc.stdin is None:
            raise RuntimeError("gateway stdin closed")
        proc.stdin.write((json.dumps(payload) + "\n").encode())
        proc.stdin.flush()

    def _wait(self, msg_id: int, timeout: float) -> Optional[Dict[str, Any]]:
        deadline = time.time() + timeout
        with self._cond:
            while msg_id not in self._responses:
                remaining = deadline - time.time()
                if remaining <= 0 or (self._proc is not None and self._proc.poll() is not None):
                    return None
                self._cond.wait(remaining)
            return self._responses.pop(msg_id)

    def _ensure(self) -> subprocess.Popen:
        if self._proc is not None and self._proc.poll() is None:
            return self._proc
        self._responses.clear()
        self._proc = self._spawn()
        return self._proc

    def call(self, tool: str, arguments: Dict[str, Any], timeout: float = _CALL_TIMEOUT_S) -> Dict[str, Any]:
        """tools/call; returns the parsed content JSON. Raises on any failure."""
        with self._lock:
            proc = self._ensure()
            msg_id = self._alloc_id()
            self._send(proc, {"jsonrpc": "2.0", "id": msg_id, "method": "tools/call",
                              "params": {"name": tool, "arguments": arguments}})
            reply = self._wait(msg_id, timeout=timeout)
            if reply is None:
                self.close()
                raise RuntimeError(f"gateway call timed out or process died (tool {tool})")
            if "error" in reply:
                raise RuntimeError(f"gateway error: {reply['error']}")
            result = reply.get("result", {})
            if result.get("isError"):
                text = result.get("content", [{}])[0].get("text", "unknown gateway error")
                raise RuntimeError(f"gateway tool error: {text}")
            content = result.get("content", [{}])[0].get("text", "{}")
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                return {"raw": content}

    def close(self) -> None:
        proc, self._proc = self._proc, None
        if proc is not None:
            try:
                if proc.stdin:
                    proc.stdin.close()
                proc.wait(timeout=3)
            except Exception:
                proc.kill()


class Clptr4pMemoryProvider(MemoryProvider):
    """Policy-gated vault memory. Reads flow through the gateway under the
    active policy; writes are proposals awaiting human review."""

    def __init__(self) -> None:
        self._client = _GatewayClient()
        self._session_id = ""
        self._platform = ""
        self._last_prefetch_at = 0.0
        self._last_prefetch_text = ""
        self._last_recall_count = 0
        self._selectors: List[str] = [
            s.strip() for s in
            os.environ.get("CLPTR4P_SELECTORS", _DEFAULT_SELECTORS).split(",")
            if s.strip()
        ]

    # -- contract ----------------------------------------------------------

    @property
    def name(self) -> str:
        return "clptr4p"

    def is_available(self) -> bool:
        if not os.environ.get("GATEWAY_DATABASE_URL"):
            return False
        if not os.environ.get("VAULT_DEK"):
            return False
        entry = os.environ.get("CLPTR4P_GATEWAY_ENTRY", _DEFAULT_ENTRY)
        return os.path.isfile(entry)

    def unavailable_reason(self) -> str:
        missing = [v for v in ("GATEWAY_DATABASE_URL", "VAULT_DEK") if not os.environ.get(v)]
        if missing:
            return f"missing env: {', '.join(missing)} (add to ~/.hermes/.env)"
        entry = os.environ.get("CLPTR4P_GATEWAY_ENTRY", _DEFAULT_ENTRY)
        if not os.path.isfile(entry):
            return f"gateway entry not found: {entry}"
        return ""

    def initialize(self, session_id: str, **kwargs) -> None:
        self._session_id = session_id
        self._platform = str(kwargs.get("platform") or "")
        logger.info("clptr4p provider initialized (session %s, platform %s, selectors %s)",
                    session_id, self._platform or "?", self._selectors)

    def system_prompt_block(self) -> str:
        return (
            "You have access to clptr4p, a governed memory vault. Reads are "
            "policy-checked: use the clptr4p_context tool to fetch approved facts "
            "about the user when drafting responses. Writes are consent-gated: the "
            "clptr4p_propose tool submits a memory proposal that the human reviews; "
            "it is never committed immediately. Durable user facts must flow through "
            "clptr4p_propose, never anywhere else."
        )

    # -- recall ------------------------------------------------------------

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if is_trivial_prompt(query):
            return ""
        now = time.time()
        if now - self._last_prefetch_at < _PREFETCH_TTL_S:
            return self._last_prefetch_text
        try:
            claims = self._fetch_claims(self._selectors, prefetch_core_only=True)
        except Exception as e:
            logger.warning("clptr4p prefetch failed: %s", e)
            return ""
        self._last_prefetch_at = now
        if not claims:
            self._last_prefetch_text = ""
            self._last_recall_count = 0
            return ""
        lines = ["Approved user context (clptr4p vault, reviewed core claims):"]
        max_chars = self._prefetch_max_chars()
        if len(lines[0]) > max_chars:
            logger.warning("clptr4p prefetch header exceeds %d-char budget; returning no context", max_chars)
            self._last_prefetch_text = ""
            self._last_recall_count = 0
            return ""
        dropped = 0
        for c in claims:
            line = f"- {c.get('claim', '')} [{c.get('predicate')} = {c.get('value')}]"
            if len("\n".join([*lines, line])) > max_chars:
                dropped += 1
                continue
            lines.append(line)
        if dropped:
            logger.warning("clptr4p prefetch dropped %d oldest core claim(s) over %d-char budget", dropped, max_chars)
        self._last_prefetch_text = "\n".join(lines)
        self._last_recall_count = len(lines) - 1
        return self._last_prefetch_text

    def recall_status(self) -> Optional[RecallStatus]:
        if self._last_recall_count <= 0:
            return None
        return RecallStatus(provider_label="clptr4p", count=self._last_recall_count)

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "",
                  messages: Optional[List[Dict[str, Any]]] = None,
                  turn_author: Optional[Dict[str, Any]] = None) -> None:
        # Deliberate no-op: turns are never auto-written to memory. Writes only
        # happen through explicit clptr4p_propose calls that the human reviews.
        return None

    # -- tools -------------------------------------------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [
            {
                "name": "clptr4p_context",
                "description": ("Fetch approved, reviewed facts about the user from the "
                                "clptr4p memory vault. Returns claims the active policy "
                                "grants. Optionally pass specific predicates."),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "predicates": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Predicates to request (default: the granted set)",
                        },
                    },
                },
            },
            {
                "name": "clptr4p_propose",
                "description": ("Submit a memory proposal to the clptr4p vault. The human "
                                "reviews it before it becomes durable memory. Use for durable "
                                "facts about the user worth remembering across sessions."),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "predicate": {"type": "string", "description": "snake_case fact key, e.g. x.hermes.preference"},
                        "value": {"type": "string", "description": "the fact value"},
                        "claim": {"type": "string", "description": "full sentence asserting the fact"},
                        "rationale": {"type": "string", "description": "why this is worth remembering"},
                    },
                    "required": ["predicate", "value", "claim", "rationale"],
                },
            },
        ]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        try:
            if tool_name == "clptr4p_context":
                predicates = [p.strip() for p in (args.get("predicates") or self._selectors) if p.strip()]
                claims = self._fetch_claims(predicates)
                return json.dumps({"success": True, "claims": claims})
            if tool_name == "clptr4p_propose":
                return self._propose(
                    predicate=str(args.get("predicate", "")),
                    value=str(args.get("value", "")),
                    claim=str(args.get("claim", "")),
                    rationale=str(args.get("rationale", "")),
                )
            return tool_error(f"clptr4p does not handle tool '{tool_name}'")
        except Exception as e:
            logger.error("clptr4p tool %s failed: %s", tool_name, e)
            return tool_error(f"clptr4p tool '{tool_name}' failed: {e}")

    def shutdown(self) -> None:
        self._client.close()

    # -- internals -----------------------------------------------------------

    def _context_request(self, predicates: List[str], *, prefetch_core_only: bool = False) -> Dict[str, Any]:
        subject = os.environ.get("CLPTR4P_SUBJECT", _DEFAULT_SUBJECT)
        request = {
            "spec_version": "context-layer/0.2-draft",
            "type": "context_request",
            "id": f"urn:cl:request:hermes-{uuid.uuid4().hex[:12]}",
            "created_at": _utcnow(),
            "issuer": {"id": "urn:agent:hermes"},
            "subject_ref": subject,
            "requester": {
                "principal": "urn:agent:hermes",
                "authenticated_by": "local",
                "client_instance": "urn:device:local-workstation",
            },
            "recipient": {"principal": "urn:model:configured", "onward_disclosure": "forbidden"},
            "purpose_code": "retrieve.context",
            "purpose": "draft a response for the user",
            "task": {"kind": "draft_only", "user_visible": True},
            "selectors": [{"predicate": p} for p in predicates],
            "requested_actions": [],
            "retention": {"mode": "ephemeral", "max_seconds": 3600},
            "receipt_requirement": {"level": "operation", "required": True},
            "expires_at": _iso_later(3600),
        }
        return self._client.call("context_request", {"request": request, "prefetch_core_only": prefetch_core_only})

    def _fetch_claims(self, predicates: List[str], *, prefetch_core_only: bool = False) -> List[Dict[str, Any]]:
        result = self._context_request(predicates, prefetch_core_only=prefetch_core_only)
        bundle = result.get("bundle") or {}
        claims = bundle.get("context") or []
        # Only keep the requested predicates the policy actually granted.
        wanted = set(predicates)
        return [c for c in claims if c.get("predicate") in wanted]

    @staticmethod
    def _prefetch_max_chars() -> int:
        raw = os.environ.get("CLPTR4P_PREFETCH_MAX_CHARS", str(_DEFAULT_PREFETCH_MAX_CHARS))
        try:
            value = int(raw)
            if value > 0:
                return value
        except ValueError:
            pass
        logger.warning("invalid CLPTR4P_PREFETCH_MAX_CHARS=%r; using %d", raw, _DEFAULT_PREFETCH_MAX_CHARS)
        return _DEFAULT_PREFETCH_MAX_CHARS

    def _propose(self, predicate: str, value: str, claim: str, rationale: str) -> str:
        if not predicate or not value or not claim:
            return tool_error("predicate, value, and claim are required")
        subject = os.environ.get("CLPTR4P_SUBJECT", _DEFAULT_SUBJECT)
        proposal = {
            "spec_version": "context-layer/0.2-draft",
            "type": "memory_update_proposal",
            "id": f"urn:cl:proposal:hermes-{uuid.uuid4().hex[:12]}",
            "created_at": _utcnow(),
            "issuer": {"id": "urn:agent:hermes"},
            "subject_ref": subject,
            "operation": "add_or_contradict",
            "proposed_claims": [{
                "predicate": predicate,
                "object": {"value": value, "datatype": "string"},
                "confidence": 0.6,
            }],
            "provenance_refs": [],
            "rationale": rationale,
            "submitted_by": "urn:agent:hermes",
            "status": "pending_validation",
            "approval_requirement": ["user_confirm"],
            "expires_at": _iso_later(7 * 24 * 3600),
        }
        result = self._client.call("memory_propose", {"proposal": proposal})
        return json.dumps({
            "success": True,
            "status": result.get("status", "pending_validation"),
            "proposal_id": result.get("proposal_id", ""),
            "note": "proposal queued for human review; not yet committed",
        })

    # -- optional setup plumbing ---------------------------------------------

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {"key": "gateway_database_url", "description": "clptr4p gateway Postgres URL",
             "secret": True, "required": True, "env_var": "GATEWAY_DATABASE_URL", "type": "text"},
            {"key": "vault_dek", "description": "Vault data encryption key (64 hex)",
             "secret": True, "required": True, "env_var": "VAULT_DEK", "type": "text"},
            {"key": "selectors", "description": "Comma-separated predicates to prefetch",
             "required": False, "env_var": "CLPTR4P_SELECTORS", "type": "text"},
            {"key": "prefetch_max_chars", "description": "Maximum characters injected by core prefetch",
             "required": False, "env_var": "CLPTR4P_PREFETCH_MAX_CHARS", "type": "text"},
        ]
