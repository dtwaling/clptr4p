import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { encryptPayload, decryptPayload } from "../crypto.ts";

Deno.test("crypto: encrypt and decrypt round-trip", async () => {
  const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // 32 bytes hex
  const payload = { hello: "world", nested: [1, 2, 3], text: "Call me Dustin" };
  
  const { digest, encrypted } = await encryptPayload(payload, key);
  
  assertNotEquals(encrypted.length, 0);
  assertEquals(digest.startsWith("sha256:"), true);
  
  const decrypted = await decryptPayload(encrypted, key);
  assertEquals(decrypted, payload);
});

Deno.test("crypto: rejects invalid key length", async () => {
  const badKey = "0123456789abcdef"; // too short
  let threw = false;
  try {
    await encryptPayload({}, badKey);
  } catch (e) {
    threw = true;
    assertEquals((e as Error).message.includes("32 bytes"), true);
  }
  assertEquals(threw, true);
});
