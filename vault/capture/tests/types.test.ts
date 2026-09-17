import { assertEquals, assertThrows } from "jsr:@std/assert";
import { isName, validateEnvelope } from "../types.ts";

Deno.test("types: isName validation", () => {
  assertEquals(isName("valid_name"), true);
  assertEquals(isName("valid.name-123"), true);
  assertEquals(isName("Invalid"), false); // uppercase
  assertEquals(isName("1invalid"), false); // starts with number
  assertEquals(isName("invalid space"), false);
  assertEquals(isName(""), false);
});

Deno.test("types: validateEnvelope rejects malformed", () => {
  const valid = {
    subject_ref: "vault://subjects/test",
    origin: "test",
    actor: "test",
    occurred_at: "2026-09-16T00:00:00Z",
    visibility: "private",
    payload: { some: "data" },
    claims: [{ predicate: "test_pred", value: "val", claim: "claim", confidence: 1 }]
  };
  
  // Should not throw
  validateEnvelope(valid);
  
  assertThrows(() => validateEnvelope({ ...valid, subject_ref: "invalid" }), Error, "Invalid subject_ref");
  assertThrows(() => validateEnvelope({ ...valid, claims: [{ ...valid.claims[0], predicate: "INVALID" }] }), Error, "opaque name");
  assertThrows(() => validateEnvelope({ ...valid, claims: [{ ...valid.claims[0], confidence: 1.5 }] }), Error, "0.0 - 1.0");
  assertThrows(() => validateEnvelope({ ...valid, occurred_at: "not-a-date" }), Error, "Invalid occurred_at");
});
