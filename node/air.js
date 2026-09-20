/** AIR Kit session-token verification for the node (docs/UNIVERSAL-LOGIN.md).
 *
 *  A browser signed in through AIR Kit hands the node its session JWT; the
 *  node verifies the signature against AIR's public JWKS and takes the
 *  identity from the payload: `sub` (the AIR user id) and, when present,
 *  the smart-account address. The browser is never trusted about who it is.
 *
 *  Ported from Agent Fighter's packages/server/src/airjwt.ts (ADR 0003),
 *  which has verified real AIR tokens since July 2026: zero dependencies,
 *  ES256/ES384/RS256 only, `exp` required, JWS signatures in ieee-p1363
 *  encoding (R||S, not DER — the classic footgun). AIR signs per
 *  environment (production vs sandbox), so both JWKS are tried by default. */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

export const DEFAULT_JWKS_URL = 'https://static.air3.com/.well-known/jwks.json,https://static.sandbox.air3.com/.well-known/jwks.json';
const JWKS_TTL_MS = 10 * 60_000;

const b64urlJson = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const ALG = {
  ES256: { hash: 'sha256', opts: (key) => ({ key, dsaEncoding: 'ieee-p1363' }) },
  ES384: { hash: 'sha384', opts: (key) => ({ key, dsaEncoding: 'ieee-p1363' }) },
  RS256: { hash: 'sha256', opts: (key) => ({ key }) },
};

/** Verify a JWT against a set of JWKs; the payload, or a throw. Pure. */
export function verifyJwtWithKeys(token, keys, nowSec = Math.floor(Date.now() / 1000)) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) throw new Error('not a JWT');
  const header = b64urlJson(parts[0]);
  const spec = ALG[String(header.alg ?? '')];
  if (!spec) throw new Error(`disallowed alg "${header.alg}"`);
  const kid = header.kid;
  const candidates = keys.filter((k) => !kid || !k.kid || k.kid === kid);
  if (!candidates.length) throw new Error(`no JWK for kid "${kid}"`);
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], 'base64url');
  const ok = candidates.some((jwk) => { try { return cryptoVerify(spec.hash, data, spec.opts(createPublicKey({ key: jwk, format: 'jwk' })), sig); } catch { return false; } });
  if (!ok) throw new Error('bad signature');
  const payload = b64urlJson(parts[1]);
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp <= 0) throw new Error('missing exp — refusing a non-expiring token');
  if (exp < nowSec) throw new Error('expired');
  const nbf = Number(payload.nbf ?? 0);
  if (nbf > 0 && nbf > nowSec + 60) throw new Error('not yet valid');
  return payload;
}

/** `{ verify(token) → identity }` with a JWKS cache (10 min, plus one eager
 *  refetch on an unknown kid). `partnerId`, when set, refuses tokens AIR
 *  minted for another partner app — any partner's token verifies against the
 *  same JWKS, so without it a token from an unrelated app would pass. */
export function createAirVerifier({ jwksUrl = DEFAULT_JWKS_URL, partnerId = null, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  let keys = [], keysAt = 0;
  const fetchJwks = async () => {
    const results = await Promise.allSettled(jwksUrl.split(',').map(async (u) => {
      const r = await fetchImpl(u.trim(), { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`JWKS ${r.status}`);
      const body = await r.json();
      if (!Array.isArray(body.keys)) throw new Error('JWKS has no keys');
      return body.keys;
    }));
    const got = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (!got.length) throw new Error(`no JWKS reachable: ${results.map((r) => (r.status === 'rejected' ? String(r.reason?.message ?? r.reason) : 'ok')).join(' | ')}`);
    keys = got; keysAt = now();
  };
  const verify = async (token) => {
    if (!keys.length || now() - keysAt > JWKS_TTL_MS) await fetchJwks();
    let payload;
    try { payload = verifyJwtWithKeys(token, keys, Math.floor(now() / 1000)); }
    catch (e) { if (!/no JWK/.test(String(e.message))) throw e; await fetchJwks(); payload = verifyJwtWithKeys(token, keys, Math.floor(now() / 1000)); }
    const sub = String(payload.sub ?? '');
    if (!sub) throw new Error('token has no sub');
    const tokenPartner = typeof payload.partnerId === 'string' ? payload.partnerId : null;
    if (partnerId && tokenPartner !== partnerId) throw new Error('token was minted for another partner app');
    return {
      sub,
      partnerId: tokenPartner,
      address: typeof payload.abstractAccountAddress === 'string' ? payload.abstractAccountAddress.toLowerCase() : null,
      email: typeof payload.email === 'string' ? payload.email : null,
    };
  };
  return { verify, status: () => ({ jwksUrl, partnerId, keys: keys.length, keysAt: keysAt || null }) };
}
