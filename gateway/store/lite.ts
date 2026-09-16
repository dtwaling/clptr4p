// Lite backend: in-memory bundles, file-backed policy/claims, JSONL audit.
// Zero infra; bundles do not survive restart (acceptable: they are short-lived).

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Audit,
  type Backend,
  type BundleRepo,
  type Claim,
  type ClaimSource,
  type ConsumeResult,
  evaluateConsume,
  type IssuedBundle,
  type Json,
  type PolicySource,
} from "./types.ts";

export const DENY_ALL_POLICY = {
  id: "urn:cl:policy:default-deny",
  version: "default-deny/1",
  issuer: "urn:cl:policy-engine:local",
  allowed_purpose_codes: [],
  allowed_selectors: [],
  denied_selectors: [],
  allowed_actions: [],
  max_retention_seconds: 3600,
  allow_onward_disclosure: false,
  transform_requirements: [],
};

class FilePolicy implements PolicySource {
  constructor(private readonly policy: Json) {}
  static load(path: string | undefined): FilePolicy {
    if (!path) return new FilePolicy(DENY_ALL_POLICY);
    try {
      return new FilePolicy(JSON.parse(Deno.readTextFileSync(path)));
    } catch (e) {
      console.error(`policy load failed (${path}), deny-all:`, (e as Error).message);
      return new FilePolicy(DENY_ALL_POLICY);
    }
  }
  active(): Promise<Json> {
    return Promise.resolve(this.policy);
  }
}

class FileClaims implements ClaimSource {
  private constructor(private readonly bySubject: Map<string, Claim[]>) {}
  static load(path: string | undefined): FileClaims {
    if (!path) return new FileClaims(new Map());
    try {
      const raw = JSON.parse(Deno.readTextFileSync(path)) as Record<string, Claim[]>;
      return new FileClaims(new Map(Object.entries(raw)));
    } catch (e) {
      console.error(`claims load failed (${path}), empty:`, (e as Error).message);
      return new FileClaims(new Map());
    }
  }
  select(subjectRef: string, predicates: string[]): Promise<Claim[]> {
    const wanted = new Set(predicates);
    return Promise.resolve((this.bySubject.get(subjectRef) ?? []).filter((c) => wanted.has(c.predicate)));
  }
  get subjectCount(): number {
    return this.bySubject.size;
  }
}

export class MemoryBundles implements BundleRepo {
  private readonly entries = new Map<string, IssuedBundle>();
  constructor(private readonly receipts: (r: Json) => void = () => {}) {}

  issue(request: Json, decision: Json, bundle: Json, receipt: Json): Promise<void> {
    if (this.entries.has(bundle.id)) return Promise.reject(new Error(`bundle ${bundle.id} already issued`));
    this.entries.set(bundle.id, { request, decision, bundle, consumed_at: null });
    this.receipts(receipt);
    return Promise.resolve();
  }
  consume(bundleId: string, action: string, now: Date = new Date(), onGranted?: (e: IssuedBundle) => Json): Promise<ConsumeResult> {
    const entry = this.entries.get(bundleId);
    const result = evaluateConsume(entry, bundleId, action, now);
    if (result.ok) {
      if (entry!.bundle.single_use) entry!.consumed_at = now.toISOString();
      if (onGranted) this.receipts(onGranted(entry!));
    }
    return Promise.resolve(result);
  }
  get size(): number {
    return this.entries.size;
  }
}

class JsonlAudit implements Audit {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dirname(`${dir}/x`), { recursive: true });
  }
  private write(file: string, kind: string, record: Json): Promise<void> {
    appendFileSync(`${this.dir}/${file}`, JSON.stringify({ timestamp: new Date().toISOString(), kind, record }) + "\n");
    return Promise.resolve();
  }
  decision(d: Json) { return this.write("decisions.jsonl", "policy_decision", d); }
  rejectedAct(r: Json) { return this.write("decisions.jsonl", "act_rejected", r); }
  receipt(r: Json) { return this.write("receipts.jsonl", "receipt", r); }
  proposal(p: Json) { return this.write("proposals.jsonl", "memory_update_proposal", p); }
}

export function liteBackend(opts: { policyFile?: string; claimsFile?: string; auditDir: string }): Backend {
  const policy = FilePolicy.load(opts.policyFile);
  const claims = FileClaims.load(opts.claimsFile);
  const audit = new JsonlAudit(opts.auditDir);
  return {
    policy,
    claims,
    bundles: new MemoryBundles((r) => void audit.receipt(r)),
    audit,
    describe: () => `lite (policy=${opts.policyFile ? "file" : "deny-all"}, subjects=${claims.subjectCount})`,
    close: () => Promise.resolve(),
  };
}
