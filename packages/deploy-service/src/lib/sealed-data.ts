import { base64url } from "jose";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function encryptStoredText(secret: string, plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const key = await deriveAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext)
  );

  return {
    ciphertext: base64url.encode(new Uint8Array(ciphertext)),
    iv: base64url.encode(iv)
  };
}

export async function decryptStoredText(secret: string, payload: { ciphertext: string; iv: string }): Promise<string> {
  const key = await deriveAesKey(secret);
  const iv = new Uint8Array(base64url.decode(payload.iv));
  const ciphertext = new Uint8Array(base64url.decode(payload.ciphertext));
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  return decoder.decode(plaintext);
}

async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}
