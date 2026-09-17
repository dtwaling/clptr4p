// AES-256-GCM authenticated encryption for raw evidence payloads.
// The DEK is held in the vault env, never exposed to the gateway.

export async function encryptPayload(payload: unknown, hexKey: string): Promise<{ digest: string; encrypted: Uint8Array }> {
  const pt = new TextEncoder().encode(JSON.stringify(payload));
  
  const digestBuf = await crypto.subtle.digest("SHA-256", pt);
  const digest = "sha256:" + encodeHex(new Uint8Array(digestBuf));

  const keyBytes = decodeHex(hexKey);
  if (keyBytes.length !== 32) throw new Error("VAULT_DEK must be 32 bytes (64 hex chars)");
  
  const key = await crypto.subtle.importKey("raw", keyBytes.buffer as ArrayBuffer, "AES-GCM", false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, pt);

  const encrypted = new Uint8Array(nonce.length + ct.byteLength);
  encrypted.set(nonce, 0);
  encrypted.set(new Uint8Array(ct), nonce.length);
  
  return { digest, encrypted };
}

export async function decryptPayload(encrypted: Uint8Array, hexKey: string): Promise<unknown> {
  const keyBytes = decodeHex(hexKey);
  const key = await crypto.subtle.importKey("raw", keyBytes.buffer as ArrayBuffer, "AES-GCM", false, ["decrypt"]);
  
  const nonce = encrypted.slice(0, 12);
  const ct = encrypted.slice(12);
  
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

function encodeHex(buf: Uint8Array): string {
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function decodeHex(hex: string): Uint8Array {
  const match = hex.match(/.{1,2}/g);
  if (!match) return new Uint8Array(0);
  return new Uint8Array(match.map((byte) => parseInt(byte, 16)));
}
