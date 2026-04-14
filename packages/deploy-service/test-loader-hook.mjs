// Registers the ESM resolver hook in `test-loader.mjs` so that importing
// `cloudflare:workers` (used by `@cloudflare/workers-oauth-provider`) resolves to an
// inline stub during Node-based tests. Loaded via `--import` from the `test` script.
import { register } from "node:module";

register("./test-loader.mjs", import.meta.url);
