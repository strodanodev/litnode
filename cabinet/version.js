/** The cabinet's own version — the litnode release its files were cut with. Kept equal to package.json by
 *  `npm version` (tools/sync-version.mjs) and asserted by demo/cabinet.test.mjs, so a copy served from
 *  somewhere else (Vercel, an exe's bundle) can say how far behind the node it talks to it is: the node
 *  reports its own on /health.version, the cabinet shows both and flags a mismatch. */
export const CABINET_VERSION = '0.11.18';
