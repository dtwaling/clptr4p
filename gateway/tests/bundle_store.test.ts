import { assertEquals, assertThrows } from "jsr:@std/assert";
import { BundleStore } from "../bundle_store.ts";

const T0 = new Date("2026-08-12T14:33:00Z");
const T_LATER = new Date("2026-08-12T15:00:00Z");
const T_EXPIRED = new Date("2026-08-12T17:00:00Z");

function fixture(id = "urn:cl:bundle:test1") {
  return {
    request: { id: "urn:cl:request:r1" },
    decision: { id: "urn:cl:decision:d1" },
    bundle: {
      id,
      expires_at: "2026-08-12T16:33:00Z",
      single_use: true,
      capabilities: ["model.generate_text", "email.create_draft"],
    },
  };
}

Deno.test("BundleStore: consume succeeds once for a granted action", () => {
  const store = new BundleStore();
  const f = fixture();
  store.issue(f.request, f.decision, f.bundle);

  const first = store.consume(f.bundle.id, "model.generate_text", T_LATER);
  assertEquals(first.ok, true);

  const second = store.consume(f.bundle.id, "model.generate_text", T_LATER);
  assertEquals(second.ok, false);
  if (!second.ok) assertEquals(second.code, "BUNDLE_ALREADY_CONSUMED");
});

Deno.test("BundleStore: rejects ungranted action without consuming", () => {
  const store = new BundleStore();
  const f = fixture();
  store.issue(f.request, f.decision, f.bundle);

  const bad = store.consume(f.bundle.id, "email.send", T_LATER);
  assertEquals(bad.ok, false);
  if (!bad.ok) assertEquals(bad.code, "ACTION_NOT_GRANTED");

  // Bundle must still be usable for a granted action.
  const good = store.consume(f.bundle.id, "email.create_draft", T_LATER);
  assertEquals(good.ok, true);
});

Deno.test("BundleStore: rejects expired bundle", () => {
  const store = new BundleStore();
  const f = fixture();
  store.issue(f.request, f.decision, f.bundle);

  const r = store.consume(f.bundle.id, "model.generate_text", T_EXPIRED);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "BUNDLE_EXPIRED");
});

Deno.test("BundleStore: unknown bundle id fails closed", () => {
  const store = new BundleStore();
  const r = store.consume("urn:cl:bundle:nope", "model.generate_text", T0);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "BUNDLE_NOT_FOUND");
});

Deno.test("BundleStore: duplicate issue throws", () => {
  const store = new BundleStore();
  const f = fixture();
  store.issue(f.request, f.decision, f.bundle);
  assertThrows(() => store.issue(f.request, f.decision, f.bundle));
});

Deno.test("BundleStore: prune removes expired entries only", () => {
  const store = new BundleStore();
  const a = fixture("urn:cl:bundle:a");
  const b = fixture("urn:cl:bundle:b");
  b.bundle.expires_at = "2026-08-12T18:00:00Z";
  store.issue(a.request, a.decision, a.bundle);
  store.issue(b.request, b.decision, b.bundle);

  assertEquals(store.prune(T_EXPIRED), 1);
  assertEquals(store.size, 1);
  assertEquals(store.get("urn:cl:bundle:b") !== undefined, true);
});
