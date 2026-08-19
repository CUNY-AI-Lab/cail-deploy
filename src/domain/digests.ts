import type { JsonValue } from "./json";

const encoder = new TextEncoder();

export async function sha256Hex(input: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes =
    input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : encoder.encode(input);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(new Uint8Array(bytes));
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseContentDigest(value: string | null): Uint8Array | null {
  const match = value?.match(/^sha-256=:([A-Za-z0-9+/]+={0,2}):$/u);
  if (!match?.[1]) return null;
  try {
    return Uint8Array.from(atob(match[1]), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value instanceof Object) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function opaqueId(prefix: "prj" | "rel"): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
