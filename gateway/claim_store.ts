// Claim store: the vault's derived-claims surface as seen by the gateway.
// File-backed JSON for the lite profile; the gateway never exposes raw
// claims to a consumer, only what issueScopedBundle selects and transforms.

export interface Claim {
  claim: string;
  predicate: string;
  value: string;
  confidence: number;
  provenance_handles: string[];
}

export class ClaimStore {
  private constructor(private readonly bySubject: Map<string, Claim[]>) {}

  static empty(): ClaimStore {
    return new ClaimStore(new Map());
  }

  // Expected file shape: { "<subject_ref>": Claim[] , ... }
  static fromFile(path: string): ClaimStore {
    const raw = JSON.parse(Deno.readTextFileSync(path)) as Record<string, Claim[]>;
    const map = new Map<string, Claim[]>();
    for (const [subject, claims] of Object.entries(raw)) {
      if (!Array.isArray(claims)) throw new Error(`claims for ${subject} must be an array`);
      map.set(subject, claims);
    }
    return new ClaimStore(map);
  }

  // Returns only claims whose predicate was requested; the policy engine
  // decides which of those are actually granted.
  select(subjectRef: string, predicates: string[]): Claim[] {
    const all = this.bySubject.get(subjectRef) ?? [];
    const wanted = new Set(predicates);
    return all.filter((c) => wanted.has(c.predicate));
  }

  get subjectCount(): number {
    return this.bySubject.size;
  }
}
