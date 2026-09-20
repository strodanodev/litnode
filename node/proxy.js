/** litVM proxy wallets for AIR accounts (docs/UNIVERSAL-LOGIN.md).
 *
 *  AIR Kit gives every user a smart account on the chains AIR supports;
 *  litVM is not one of them. So a node that has verified an AIR session
 *  (node/air.js) assigns the user a PROXY WALLET on litVM: a plain key,
 *  created on first sign-in, kept under <dataDir>/proxies/, and used for
 *  exactly the transactions the mesh identity needs — mint the user's
 *  PlayerProfile with the AIR id bound to it (`airKey(sub)`), bind the
 *  browser's ed25519 key to that profile, revoke one, rename. Gas comes
 *  from the node's announcer key, which the operator already funds: the
 *  sponsor tops the proxy up before each send.
 *
 *  Custody is the node's, and the design says so: a proxy signs what the
 *  profile contract allows its owner to sign and nothing else — there is no
 *  "send any transaction" path. A user who later brings a real wallet on
 *  litVM binds it to the same profile; the proxy then simply stops being
 *  used. Every node can RESOLVE an AIR id to its proxy with one eth_call
 *  (ownerOfKey(airKey)); only the node that created the key can SIGN for
 *  it, and it answers `custody: 'elsewhere'` when the profile exists but
 *  the key is not here. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomPrivateKey, addressOf, signTransaction } from '../protocol/evm.js';
import { airKey, nameFor } from '../protocol/air.js';
import { ownerOfKeyCall, profileOfCall, nameOfCall, decodeOwner, decodeUint, decodeString, registerCalldata, bindKeyCalldata, revokeKeyCalldata } from '../protocol/profile.js';

const TOPUP_WEI = 2_000_000_000_000_000n;     // 0.002 native: a handful of profile transactions on Liteforge
const MIN_WEI = 500_000_000_000_000n;        // top up below 0.0005
const RECEIPT_TIMEOUT_MS = 60_000;

export function createProxyWallets({ dataDir, chainId, rpc, playerProfile, sponsor, log = () => {}, emit = () => {} }) {
  const dir = join(dataDir, 'proxies');
  mkdirSync(dir, { recursive: true });
  const locks = new Map();
  /** One operation per AIR user at a time: two tabs signing in together must not mint two profiles. */
  const withLock = async (sub, fn) => {
    const prev = locks.get(sub) ?? Promise.resolve();
    let release; const mine = new Promise((r) => { release = r; });
    locks.set(sub, prev.then(() => mine));
    try { await prev; return await fn(); } finally { release(); if (locks.get(sub) === mine) locks.delete(sub); }
  };

  const keyPath = (sub) => join(dir, `${airKey(sub)}.json`);
  const load = (sub) => { const p = keyPath(sub); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; };
  const create = (sub) => {
    const rec = { sub, privateKey: randomPrivateKey(), createdAt: new Date().toISOString() };
    rec.address = addressOf(rec.privateKey).toLowerCase();
    writeFileSync(keyPath(sub), JSON.stringify(rec, null, 2) + '\n');
    log(`proxy: new litVM wallet ${rec.address} for AIR user ${sub.slice(0, 8)}…`);
    emit('proxy.created', { sub, address: rec.address });
    return rec;
  };

  // ---------------------------------------------------------------- chain
  const call = (data) => rpc('eth_call', [data, 'latest']);
  const balance = async (address) => BigInt(await rpc('eth_getBalance', [address, 'latest']));
  const receipt = async (hash) => {
    const t0 = Date.now();
    while (Date.now() - t0 < RECEIPT_TIMEOUT_MS) {
      const r = await rpc('eth_getTransactionReceipt', [hash]);
      if (r) { if (r.status !== '0x1') throw new Error(`transaction ${hash.slice(0, 12)}… reverted`); return r; }
      await new Promise((res) => setTimeout(res, 1500));
    }
    throw new Error(`transaction ${hash.slice(0, 12)}… not mined in ${RECEIPT_TIMEOUT_MS / 1000}s`);
  };
  /** Sign and send one call from `key`; the receipt, or a throw. */
  const send = async (key, { to, data = '0x', value = 0n }) => {
    const from = addressOf(key.privateKey);
    const [nonceHex, gasPriceHex, gasHex] = await Promise.all([
      rpc('eth_getTransactionCount', [from, 'pending']),
      rpc('eth_gasPrice', []),
      rpc('eth_estimateGas', [{ from, to, data, value: '0x' + value.toString(16) }]),
    ]);
    const raw = signTransaction({ nonce: BigInt(nonceHex), gasPrice: BigInt(gasPriceHex) * 12n / 10n, gasLimit: BigInt(gasHex) * 13n / 10n, to, value, data, chainId: BigInt(chainId) }, key.privateKey);
    const hash = await rpc('eth_sendRawTransaction', [raw]);
    return { hash, receipt: await receipt(hash) };
  };
  /** Make sure the proxy can pay for a few calls; the sponsor pays. */
  const fund = async (address) => {
    if ((await balance(address)) >= MIN_WEI) return null;
    if (!sponsor) throw new Error('proxy wallet has no gas and this node has no sponsor key');
    const have = await balance(sponsor.address);
    if (have < TOPUP_WEI * 2n) throw new Error(`sponsor ${sponsor.address} has ${have} wei — the operator must fund it (it is the announcer key on /health)`);
    const { hash } = await send(sponsor, { to: address, value: TOPUP_WEI });
    log(`proxy: sponsored ${address} with ${TOPUP_WEI} wei (tx ${hash.slice(0, 12)}…)`);
    return hash;
  };

  // ---------------------------------------------------------------- reads (any node can do these)
  // JSON-safe: tokenId as a decimal string (a BigInt in a reply body kills the response after its headers went out).
  const ownerOf = async (keyHex) => { const o = decodeOwner(await call(ownerOfKeyCall(playerProfile, keyHex))); return o.tokenId === 0n ? null : { owner: o.owner.toLowerCase(), tokenId: o.tokenId.toString(), active: o.active }; };
  const profileOf = async (address) => { const tokenId = decodeUint(await call(profileOfCall(playerProfile, address))); return tokenId === 0n ? null : { tokenId, name: decodeString(await call(nameOfCall(playerProfile, tokenId))) }; };
  /** What the chain says about an AIR user: its proxy (profile owner), token and name — or null. */
  const resolve = async (sub) => {
    const b = await ownerOf(airKey(sub));
    if (!b?.active) return null;
    const p = await profileOf(b.owner);
    return { address: b.owner, tokenId: b.tokenId, name: p?.name ?? null };
  };

  // ---------------------------------------------------------------- the one flow
  /** First sign-in creates the proxy, sponsors it and mints the profile with
   *  the AIR id bound; every sign-in binds the browser's player key when it
   *  is not bound yet. Idempotent. */
  const session = ({ sub, email = null, playerKey = null, name = null }) => withLock(sub, async () => {
    const steps = [];
    let onChain = await resolve(sub);
    let key = load(sub);
    if (onChain && (!key || key.address !== onChain.address)) {
      // The profile exists but was minted by another node (or this node lost
      // its key): resolvable, not signable from here.
      return { sub, address: onChain.address, tokenId: onChain.tokenId, name: onChain.name, custody: 'elsewhere', playerKey: playerKey ? await ownerOf(playerKey) : null, steps };
    }
    if (!onChain) {
      key ??= create(sub);
      const existing = await profileOf(key.address);
      if (existing) {
        // Minted, but the AIR key is not bound (a crash between two steps): bind it now.
        await fund(key.address);
        const { hash } = await send(key, { to: playerProfile, data: bindKeyCalldata(airKey(sub)) });
        steps.push({ step: 'bind-air', tx: hash });
      } else {
        const who = name && /^[A-Za-z0-9 _.-]{1,32}$/.test(name) ? name : nameFor({ email, sub });
        const t = await fund(key.address); if (t) steps.push({ step: 'sponsor', tx: t });
        const { hash } = await send(key, { to: playerProfile, data: registerCalldata(airKey(sub), who) });
        steps.push({ step: 'register', tx: hash });
        log(`proxy: registered profile "${who}" for AIR user ${sub.slice(0, 8)}… at ${key.address}`);
        emit('proxy.registered', { sub, address: key.address, name: who });
      }
      onChain = await resolve(sub);
      if (!onChain) throw new Error('profile not visible after registration');
    }
    let bound = null;
    if (playerKey) {
      bound = await ownerOf(playerKey);
      if (bound && bound.owner !== onChain.address) {
        steps.push({ step: 'player-key', skipped: `bound to another wallet ${bound.owner}` });
      } else if (!bound?.active) {
        await fund(key.address);
        const { hash } = await send(key, { to: playerProfile, data: bindKeyCalldata(playerKey) });
        steps.push({ step: 'bind-player-key', tx: hash });
        bound = await ownerOf(playerKey);
        emit('proxy.bound', { sub, address: key.address, playerKey });
      }
    }
    return { sub, address: onChain.address, tokenId: onChain.tokenId, name: onChain.name, custody: 'here', playerKey: bound, steps };
  });

  /** Revoke a browser key from the user's profile (a lost device). */
  const revoke = ({ sub, playerKey }) => withLock(sub, async () => {
    const key = load(sub); const onChain = await resolve(sub);
    if (!key || !onChain || key.address !== onChain.address) throw new Error('this node does not hold the proxy for that account');
    const b = await ownerOf(playerKey);
    if (!b || b.owner !== onChain.address) throw new Error('that key is not bound to this account');
    if (!b.active) return { sub, playerKey, revoked: true, tx: null };
    await fund(key.address);
    const { hash } = await send(key, { to: playerProfile, data: revokeKeyCalldata(playerKey) });
    return { sub, playerKey, revoked: true, tx: hash };
  });

  return { session, revoke, resolve, addressOf: (sub) => load(sub)?.address ?? null, status: () => ({ sponsor: sponsor?.address ?? null, contract: playerProfile }) };
}
