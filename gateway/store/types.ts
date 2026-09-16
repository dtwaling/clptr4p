// Storage interfaces the gateway depends on. Two implementations:
//   memory/file (lite profile, zero infra) and postgres (durable vault).
// The gateway never touches a backend directly; it only sees these shapes.

// deno-lint-ignore no-explicit-any
export type Json = any;

export interface Claim {
  claim: string;
  predicate: string;
  value: string;
  confidence: number;
  provenance_handles: string[];
}

export interface IssuedBundle {
  request: Json;
  decision: Json;
  bundle: Json;
  consumed_at: string | null;
}

export type ConsumeFailure =
  | "BUNDLE_NOT_FOUND"
  | "BUNDLE_EXPIRED"
  | "BUNDLE_ALREADY_CONSUMED"
  | "ACTION_NOT_GRANTED";

export type ConsumeResult =
  | { ok: true; entry: IssuedBundle }
  | { ok: false; code: ConsumeFailure; detail: string };

export interface PolicySource {
  // The single active policy input (reference validatePolicy shape).
  active(): Promise<Json>;
}

export interface ClaimSource {
  select(subjectRef: string, predicates: string[]): Promise<Claim[]>;
}

export interface BundleRepo {
  // Persist bundle and its issuance receipt atomically: neither or both.
  issue(request: Json, decision: Json, bundle: Json, receipt: Json): Promise<void>;
  // Validate, then atomically mark consumed AND persist the receipt built by
  // `onGranted` in the same transaction. Fails closed on any mismatch.
  consume(bundleId: string, action: string, now?: Date, onGranted?: (entry: IssuedBundle) => Json): Promise<ConsumeResult>;
}

export interface Audit {
  decision(decision: Json): Promise<void>;
  rejectedAct(record: { bundle_id: string; action: string; code: string; detail: string }): Promise<void>;
  proposal(proposal: Json): Promise<void>;
}

export interface Backend {
  policy: PolicySource;
  claims: ClaimSource;
  bundles: BundleRepo;
  audit: Audit;
  describe(): string;
  close(): Promise<void>;
}

// Shared consume semantics so both backends behave identically.
export function evaluateConsume(
  entry: IssuedBundle | undefined,
  bundleId: string,
  action: string,
  now: Date,
): ConsumeResult {
  if (!entry) return { ok: false, code: "BUNDLE_NOT_FOUND", detail: bundleId };
  if (entry.consumed_at !== null) {
    return { ok: false, code: "BUNDLE_ALREADY_CONSUMED", detail: entry.consumed_at };
  }
  const expiresAt = Date.parse(entry.bundle.expires_at);
  if (Number.isNaN(expiresAt) || now.getTime() >= expiresAt) {
    return { ok: false, code: "BUNDLE_EXPIRED", detail: entry.bundle.expires_at };
  }
  const capabilities: string[] = entry.bundle.capabilities ?? [];
  if (!capabilities.includes(action)) {
    return { ok: false, code: "ACTION_NOT_GRANTED", detail: `${action} not in [${capabilities.join(", ")}]` };
  }
  return { ok: true, entry };
}
