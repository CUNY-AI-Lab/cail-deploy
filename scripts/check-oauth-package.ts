import { createHash } from "node:crypto";

const expected = {
  version: "0.5.0",
  sourceRevision: "b4bc502c3421f2bc8a61760fb84790f09d0fa529",
  tarballSha256: "097c5955e8eb6092575a008d9e3b960fc945b48c8fb26ae252bedd9482bdce11",
  integrity:
    "sha512-KlqhvvG6XAkemDlckeiqpMpXzYjpfW+IXkxfIHJOxnrotfZdVVkeiAMTTtmYBizwvY/t6FtR9d2Da+NZLboM5g==",
};

const packageJson = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
  dependencies: Record<string, string>;
};
const installed = (await Bun.file(
  new URL("../node_modules/@cloudflare/workers-oauth-provider/package.json", import.meta.url),
).json()) as { version: string };
const bom = (await Bun.file(
  new URL("../cloudflare-compatibility.json", import.meta.url),
).json()) as {
  packages: Record<
    string,
    { accepted?: string; sourceRevision?: string; npmTarballSha256?: string }
  >;
};
const lock = await Bun.file(new URL("../bun.lock", import.meta.url)).text();

if (packageJson.dependencies["@cloudflare/workers-oauth-provider"] !== expected.version) {
  throw new Error("workers-oauth-provider must be pinned exactly to 0.5.0");
}
if (installed.version !== expected.version) throw new Error("installed OAuth provider drifted");
const receipt = bom.packages["@cloudflare/workers-oauth-provider"];
if (
  receipt?.accepted !== expected.version ||
  receipt.sourceRevision !== expected.sourceRevision ||
  receipt.npmTarballSha256 !== expected.tarballSha256
) {
  throw new Error("OAuth provider source/tarball receipt drifted");
}
if (!lock.includes(expected.integrity)) throw new Error("OAuth provider lock integrity drifted");

const receiptDigest = createHash("sha256")
  .update(
    `${expected.version}\n${expected.sourceRevision}\n${expected.tarballSha256}\n${expected.integrity}\n`,
  )
  .digest("hex");
console.log(`OAuth provider pin/source/tarball receipt passed: ${receiptDigest}`);
