import { assertEquals } from "jsr:@std/assert";
import { liteBackend } from "../store/lite.ts";

Deno.test("lite claims: select filters by subject and requested predicates", async () => {
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
  const dir = Deno.makeTempDirSync();
  const be = liteBackend({ claimsFile: path, auditDir: dir });
  Deno.removeSync(path);

  assertEquals((await be.claims.select("vault://subjects/a", ["p1"])).map((c) => c.value), ["1"]);
  assertEquals((await be.claims.select("vault://subjects/a", ["p1", "p2"])).length, 2);
  assertEquals((await be.claims.select("vault://subjects/b", ["p2"])).length, 0);
  assertEquals((await be.claims.select("vault://subjects/missing", ["p1"])).length, 0);
});

Deno.test("lite policy: absent file yields deny-all", async () => {
  const be = liteBackend({ auditDir: Deno.makeTempDirSync() });
  const p = await be.policy.active();
  assertEquals(p.id, "urn:cl:policy:default-deny");
  assertEquals(p.allowed_actions, []);
});
