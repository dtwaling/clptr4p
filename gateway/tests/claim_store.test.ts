import { assertEquals } from "jsr:@std/assert";
import { ClaimStore } from "../claim_store.ts";

Deno.test("ClaimStore: select filters by subject and requested predicates", () => {
  const path = Deno.makeTempFileSync({ suffix: ".json" });
  Deno.writeTextFileSync(path, JSON.stringify({
    "vault://subjects/a": [
      { claim: "x", predicate: "p1", value: "1", confidence: 0.9, provenance_handles: ["h1"] },
      { claim: "y", predicate: "p2", value: "2", confidence: 0.9, provenance_handles: ["h2"] },
    ],
    "vault://subjects/b": [
      { claim: "z", predicate: "p1", value: "3", confidence: 0.9, provenance_handles: ["h3"] },
    ],
  }));
  const store = ClaimStore.fromFile(path);
  Deno.removeSync(path);

  assertEquals(store.subjectCount, 2);
  assertEquals(store.select("vault://subjects/a", ["p1"]).map((c) => c.value), ["1"]);
  assertEquals(store.select("vault://subjects/a", ["p1", "p2"]).length, 2);
  assertEquals(store.select("vault://subjects/b", ["p2"]).length, 0);
  assertEquals(store.select("vault://subjects/missing", ["p1"]).length, 0);
});

Deno.test("ClaimStore: empty store selects nothing", () => {
  assertEquals(ClaimStore.empty().select("vault://subjects/a", ["p1"]).length, 0);
});
