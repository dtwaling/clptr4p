export interface ClaimInput {
  predicate: string;
  value: unknown;
  claim: string;
  confidence: number;
  datatype?: string;
  supersede?: boolean;
}

export interface CaptureEnvelope {
  subject_ref: string;
  origin: string;
  actor: string;
  occurred_at: string;
  visibility: string;
  payload: unknown;
  claims: ClaimInput[];
}

export function isName(value: string): boolean {
  return typeof value === "string" && /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value);
}

// deno-lint-ignore no-explicit-any
export function validateEnvelope(env: any): asserts env is CaptureEnvelope {
  if (!env || typeof env !== "object") throw new Error("Envelope must be an object");
  if (typeof env.subject_ref !== "string" || !env.subject_ref.startsWith("vault://subjects/")) {
    throw new Error("Invalid subject_ref");
  }
  if (typeof env.origin !== "string" || typeof env.actor !== "string") throw new Error("Missing origin/actor");
  if (typeof env.occurred_at !== "string" || Number.isNaN(Date.parse(env.occurred_at))) {
    throw new Error("Invalid occurred_at");
  }
  if (typeof env.visibility !== "string") throw new Error("Missing visibility");
  if (!Array.isArray(env.claims)) throw new Error("claims must be an array");

  for (const [i, c] of env.claims.entries()) {
    if (!isName(c.predicate)) throw new Error(`claims[${i}].predicate must be an opaque name`);
    if (c.value === undefined || typeof c.claim !== "string") throw new Error(`claims[${i}] missing value/claim`);
    if (typeof c.confidence !== "number" || c.confidence < 0 || c.confidence > 1) {
      throw new Error(`claims[${i}].confidence must be 0.0 - 1.0`);
    }
  }
}
