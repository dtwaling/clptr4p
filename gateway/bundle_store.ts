// Bundle store: enforces single-use, expiry, and capability binding for issued
// Scoped Context Bundles. Kept in-memory for the lite profile; the interface is
// narrow enough to swap in a durable backend later.

export interface IssuedBundle {
  // deno-lint-ignore no-explicit-any
  request: any;
  // deno-lint-ignore no-explicit-any
  decision: any;
  // deno-lint-ignore no-explicit-any
  bundle: any;
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

export class BundleStore {
  private readonly entries = new Map<string, IssuedBundle>();

  // deno-lint-ignore no-explicit-any
  issue(request: any, decision: any, bundle: any): void {
    if (this.entries.has(bundle.id)) {
      throw new Error(`bundle ${bundle.id} already issued`);
    }
    this.entries.set(bundle.id, { request, decision, bundle, consumed_at: null });
  }

  get(bundleId: string): IssuedBundle | undefined {
    return this.entries.get(bundleId);
  }

  // Validate then atomically mark consumed. Fails closed on any mismatch.
  consume(bundleId: string, action: string, now: Date = new Date()): ConsumeResult {
    const entry = this.entries.get(bundleId);
    if (!entry) {
      return { ok: false, code: "BUNDLE_NOT_FOUND", detail: bundleId };
    }
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
    if (entry.bundle.single_use) {
      entry.consumed_at = now.toISOString();
    }
    return { ok: true, entry };
  }

  // Drop expired entries so the map does not grow unbounded.
  prune(now: Date = new Date()): number {
    let removed = 0;
    for (const [id, entry] of this.entries) {
      const expiresAt = Date.parse(entry.bundle.expires_at);
      if (Number.isNaN(expiresAt) || now.getTime() >= expiresAt) {
        this.entries.delete(id);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }
}
