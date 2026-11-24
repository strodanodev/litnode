/** The arcade page's security headers, wherever it is served from: Vercel (vercel.json carries the same strings;
 *  demo/cabinet.test.mjs fails when they differ), a node (node/litnode.js serveStatic) or `npm run cabinet`.
 *
 *  The point of the policy is script-src: the page has one module script and no inline handlers, so with scripts
 *  limited to its own origin an injected <script> or on*= attribute — from a peer's title listing, a node's answer,
 *  NFT metadata — does not run, and the player key in this origin's storage stays where it is. The rest is as open
 *  as the arcade needs: any node or RPC over http(s)/ws(s), art from any gateway, titles framed from https or from
 *  this machine. frame-ancestors keeps other sites from framing the arcade around a click. */
export const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https: http:; media-src 'self' data: blob: https:; connect-src 'self' https: wss: http: ws:; frame-src https: http://127.0.0.1:* http://localhost:*; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' https://*.litvm.games http://127.0.0.1:* http://localhost:*";
export const REFERRER_POLICY = "strict-origin-when-cross-origin";
export const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': REFERRER_POLICY, 'content-security-policy': CSP };
