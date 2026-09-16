import { assertEquals, assertRejects } from "jsr:@std/assert";
import { MemoryBundles } from "../store/lite.ts";
import { evaluateConsume } from "../store/types.ts";

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

Deno.test("MemoryBundles: consume succeeds once for a granted action", async () => {
  const store = new MemoryBundles();
  const f = fixture();
  await store.issue(f.request, f.decision, f.bundle, { id: "r0" });

  const first = await store.consume(f.bundle.id, "model.generate_text", T_LATER);
  assertEquals(first.ok, true);

  const second = await store.consume(f.bundle.id, "model.generate_text", T_LATER);
  assertEquals(second.ok, false);
  if (!second.ok) assertEquals(second.code, "BUNDLE_ALREADY_CONSUMED");
});

Deno.test("MemoryBundles: rejects ungranted action without consuming", async () => {
  const store = new MemoryBundles();
  const f = fixture();
  await store.issue(f.request, f.decision, f.bundle, { id: "r0" });

  const bad = await store.consume(f.bundle.id, "email.send", T_LATER);
  assertEquals(bad.ok, false);
  if (!bad.ok) assertEquals(bad.code, "ACTION_NOT_GRANTED");

  const good = await store.consume(f.bundle.id, "email.create_draft", T_LATER);
  assertEquals(good.ok, true);
});

Deno.test("MemoryBundles: rejects expired bundle", async () => {
  const store = new MemoryBundles();
  const f = fixture();
  await store.issue(f.request, f.decision, f.bundle, { id: "r0" });
  const r = await store.consume(f.bundle.id, "model.generate_text", T_EXPIRED);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "BUNDLE_EXPIRED");
});

Deno.test("MemoryBundles: unknown bundle id fails closed", async () => {
  const r = await new MemoryBundles().consume("urn:cl:bundle:nope", "model.generate_text", T_LATER);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "BUNDLE_NOT_FOUND");
});

Deno.test("MemoryBundles: duplicate issue rejects", async () => {
  const store = new MemoryBundles();
  const f = fixture();
  await store.issue(f.request, f.decision, f.bundle, { id: "r0" });
  await assertRejects(() => store.issue(f.request, f.decision, f.bundle, { id: "r1" }));
});

Deno.test("evaluateConsume: check order is not-found > consumed > expired > ungranted", () => {
  const base = fixture();
  const consumedAndExpired = { ...base, consumed_at: "2026-08-12T15:00:00Z" };
  const r1 = evaluateConsume(consumedAndExpired, base.bundle.id, "nope", T_EXPIRED);
  assertEquals(r1.ok === false && r1.code, "BUNDLE_ALREADY_CONSUMED");

  const expiredUngranted = { ...base, consumed_at: null };
  const r2 = evaluateConsume(expiredUngranted, base.bundle.id, "nope", T_EXPIRED);
  assertEquals(r2.ok === false && r2.code, "BUNDLE_EXPIRED");
});

Deno.test("MemoryBundles: receipts emitted on issue and granted consume only", async () => {
  const seen: unknown[] = [];
  const store = new MemoryBundles((r) => seen.push(r));
  const f = fixture();
  await store.issue(f.request, f.decision, f.bundle, { id: "issue" });
  await store.consume(f.bundle.id, "email.send", T_LATER, () => ({ id: "never" }));
  await store.consume(f.bundle.id, "model.generate_text", T_LATER, () => ({ id: "consume" }));
  await store.consume(f.bundle.id, "model.generate_text", T_LATER, () => ({ id: "never2" }));
  assertEquals(seen.map((r) => (r as { id: string }).id), ["issue", "consume"]);
});
