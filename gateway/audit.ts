// Append-only JSONL audit log. One writer, fail-loud on IO errors: a receipt
// that cannot be persisted must not report success upstream (spec invariant 8).

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class AuditLog {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(kind: string, record: unknown): void {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), kind, record });
    appendFileSync(this.path, line + "\n");
  }
}
