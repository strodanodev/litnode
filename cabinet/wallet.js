/** Sign in with a wallet (docs/WALLET-IDENTITY.md). No wallet library: the
 *  calldata comes from the node's own protocol/profile.js, the wallet signs
 *  it, and nothing here ever sees a private key. The player's ed25519 key is
 *  untouched — the wallet authorizes it, it keeps signing play.
 *
 *  Flow: connect → make sure MetaMask is on litVM (4441) → does this wallet
 *  have a profile? → register(key, name) mints one and binds this browser's
 *  key, or bindKey(key) adds this browser to an existing profile. */
import { CHAIN } from './config.js';
import { registerCalldata, bindKeyCalldata, revokeKeyCalldata, profileOfCall, ownerOfKeyCall, nameOfCall, decodeOwner, decodeUint, decodeString } from './protocol/profile.js';

const eth = () => globalThis.ethereum ?? null;
export const hasWallet = () => !!eth();
export const configured = () => !!CHAIN.PlayerProfile;
const hex = (n) => '0x' + BigInt(n).toString(16);

let id = 0;
async function rpc(method, params) {
  const r = await fetch(CHAIN.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(12000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

/** Ask the wallet for an account and for the litVM chain (added if unknown). */
export async function connect() {
  const w = eth(); if (!w) throw new Error('no wallet in this browser');
  const [account] = await w.request({ method: 'eth_requestAccounts' });
  const want = hex(CHAIN.chainId);
  const have = await w.request({ method: 'eth_chainId' });
  if (have !== want) {
    try { await w.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] }); }
    catch (e) {
      if (e.code !== 4902) throw e;
      await w.request({ method: 'wallet_addEthereumChain', params: [{ chainId: want, chainName: CHAIN.name, rpcUrls: [CHAIN.rpc], nativeCurrency: { name: 'zkLTC', symbol: 'zkLTC', decimals: 18 }, blockExplorerUrls: CHAIN.explorer ? [CHAIN.explorer] : [] }] });
    }
  }
  return account.toLowerCase();
}

/** { tokenId, name } for a wallet, or null when it has no profile. Read-only, no wallet needed. */
export async function profileOf(address) {
  if (!configured()) return null;
  const tokenId = decodeUint(await rpc('eth_call', [profileOfCall(CHAIN.PlayerProfile, address), 'latest']));
  if (tokenId === 0n) return null;
  const name = decodeString(await rpc('eth_call', [nameOfCall(CHAIN.PlayerProfile, tokenId), 'latest']));
  return { tokenId, name };
}

/** Which wallet, if any, this browser's key is bound to. Read-only. */
export async function bindingOf(playerKey) {
  if (!configured()) return null;
  const b = decodeOwner(await rpc('eth_call', [ownerOfKeyCall(CHAIN.PlayerProfile, playerKey), 'latest']));
  return b.tokenId === 0n ? null : { ...b, owner: b.owner.toLowerCase() };
}

const send = async (from, data) => eth().request({ method: 'eth_sendTransaction', params: [{ from, to: CHAIN.PlayerProfile, data }] });
/** One transaction: mint the profile and bind this key. Returns the tx hash. */
export const register = (from, playerKey, name) => send(from, registerCalldata(playerKey, name));
export const bindKey = (from, playerKey) => send(from, bindKeyCalldata(playerKey));
export const revokeKey = (from, playerKey) => send(from, revokeKeyCalldata(playerKey));

/** Poll until the chain shows the key bound (or give up). */
export async function waitForBinding(playerKey, { timeoutMs = 60_000, intervalMs = 1500 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const b = await bindingOf(playerKey).catch(() => null);
    if (b?.active) return b;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}
