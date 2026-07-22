import { sha256Hex } from "../src/domain/digests";

const path = new URL("../fixtures/worker-artifact.v1.json", import.meta.url);
const bytes = await Bun.file(path).arrayBuffer();
const digest = await sha256Hex(bytes);
if (
  bytes.byteLength !== 253 ||
  digest !== "fb711fd92301a9ef5aae345cc3da06408e7d291b8e0cdff1d4434c216e459e82"
) {
  throw new Error(`Golden artifact drifted: bytes=${bytes.byteLength} sha256=${digest}`);
}
console.log(`Golden artifact verified: ${bytes.byteLength} bytes ${digest}`);
