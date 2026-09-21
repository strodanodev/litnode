/** Operator actions from the Nodes page, signed by the operator's own wallet
 *  (MetaMask or any EIP-1193 wallet on litVM). The CLI tools (bond-node,
 *  transfer-operator, set-announcer) do the same calls with ethers; this is
 *  the same calldata from the node's own protocol modules, and the wallet
 *  signs — nothing here ever sees a private key. docs/UNIVERSAL-LOGIN.md §
 *  "Signing from the dashboard".
 *
 *  bond:     TestLITVM.approve(NodeStake, minStake) then NodeStake.stake(nodeKey, minStake)
 *  faucet:   TestLITVM.faucet() (testnet only)
 *  transfer: NodeStake.transferOperator(nodeKey, to)
 *  delegate: NodeDirectory.setAnnouncer(nodeKey, announcer) + a little gas to the announcer */
import { CHAIN } from './config.js';
import { connect } from './wallet.js';
import { setDelegateCalldata, delegateOfCall } from './protocol/staking.js';
import { standingCall, decodeStanding, minStakeCall, stakeCalldata, transferOperatorCalldata, approveCalldata, faucetCalldata, balanceOfCall } from './protocol/staking.js';
import { setAnnouncerCalldata, announcerOfCall, decodeAddress } from './protocol/directory.js';

const eth = () => globalThis.ethereum ?? null;
let id = 0;
async function rpc(method, params) {
  const r = await fetch(CHAIN.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(12000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const hex = (n) => '0x' + BigInt(n).toString(16);
/** Fees the site suggests, so the wallet's own estimate cannot undercut the
 *  chain: MetaMask on a custom network set maxFeePerGas 0.01 % under
 *  Liteforge's base fee, which moves a little every block, and the RPC
 *  refused the bond ("max fee per gas less than block base fee", 21 Sep
 *  2026). Twice the current base fee is headroom; the chain charges the
 *  base fee, not the cap. */
async function fees() {
  try {
    const b = await rpc('eth_getBlockByNumber', ['latest', false]);
    const base = BigInt(b?.baseFeePerGas ?? (await rpc('eth_gasPrice', [])));
    const tip = base / 10n > 0n ? base / 10n : 1n;
    return { maxFeePerGas: hex(base * 2n + tip), maxPriorityFeePerGas: hex(tip) };
  } catch { return {}; } // the wallet's estimate, as before
}
/** Send one call through the wallet and wait for its receipt. */
async function send(from, to, data, value = 0n) {
  const tx = await eth().request({ method: 'eth_sendTransaction', params: [{ from, to, data, ...(value ? { value: hex(value) } : {}), ...(await fees()) }] });
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    const r = await rpc('eth_getTransactionReceipt', [tx]).catch(() => null);
    if (r) { if (r.status !== '0x1') throw new Error(`transaction ${tx.slice(0, 12)}… reverted`); return tx; }
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error(`transaction ${tx.slice(0, 12)}… not mined in 120 s`);
}

export const available = () => !!eth() && !!CHAIN.NodeStake;

/** What the chain says about this node and this wallet. */
export async function inspect(nodeId, account) {
  const [standingHex, minHex] = await Promise.all([rpc('eth_call', [standingCall(CHAIN.NodeStake, nodeId), 'latest']), rpc('eth_call', [minStakeCall(CHAIN.NodeStake), 'latest'])]);
  const s = decodeStanding(standingHex);
  const minStake = BigInt(minHex);
  const balance = account && CHAIN.TestLITVM ? BigInt(await rpc('eth_call', [balanceOfCall(CHAIN.TestLITVM, account), 'latest'])) : null;
  const gas = account ? BigInt(await rpc('eth_getBalance', [account, 'latest'])) : null; // zkLTC: without it no transaction can be signed
  const announcer = CHAIN.NodeDirectory ? decodeAddress(await rpc('eth_call', [announcerOfCall(CHAIN.NodeDirectory, nodeId), 'latest'])).toLowerCase() : null;
  // NodeStake v3: the delegate (the node's hot key) — null on a v2 contract or when unset
  let delegate = null;
  try { const d = decodeAddress(await rpc('eth_call', [delegateOfCall(CHAIN.NodeStake, nodeId), 'latest'])).toLowerCase(); delegate = /^0x0{40}$/.test(d) ? null : d; } catch { /* v2 */ }
  return { bonded: s.active, amount: s.amount, operator: s.operator.toLowerCase(), minStake, balance, gas, announcer: announcer && /^0x0{40}$/.test(announcer) ? null : announcer, delegate };
}

export const connectOperator = () => connect();

export async function faucet(from) { return send(from, CHAIN.TestLITVM, faucetCalldata()); }

/** approve + stake at the contract's minimum, then (NodeStake v3) name the
 *  node's hot key as its delegate — the key it commits, settles, attests and
 *  proposes with (BUILD-SPEC v0.3 §2.2). Three wallet prompts; `delegate` is
 *  the node's announcer address (/health.directory.announcer). The node
 *  enrols itself in the witness pool once it sees the delegation. */
export async function bond(from, nodeId, { onStep = () => {}, delegate = null } = {}) {
  const minStake = BigInt(await rpc('eth_call', [minStakeCall(CHAIN.NodeStake), 'latest']));
  onStep(`approve ${minStake} wei of tLITVM — confirm in your wallet`);
  await send(from, CHAIN.TestLITVM, approveCalldata(CHAIN.NodeStake, minStake));
  onStep('stake — confirm in your wallet');
  const tx = await send(from, CHAIN.NodeStake, stakeCalldata(nodeId, minStake));
  if (delegate) { onStep('delegate the node\'s hot key — confirm in your wallet'); await send(from, CHAIN.NodeStake, setDelegateCalldata(nodeId, delegate)); }
  return tx;
}
/** Name (or change) the node's delegate on NodeStake v3 by itself. */
export async function setDelegate(from, nodeId, delegate) { return send(from, CHAIN.NodeStake, setDelegateCalldata(nodeId, delegate)); }

export async function transferOperator(from, nodeId, to) { return send(from, CHAIN.NodeStake, transferOperatorCalldata(nodeId, to)); }

/** Delegate the node's announcer key and give it gas for announcements. */
export async function delegateAnnouncer(from, nodeId, announcer, { fundWei = 20_000_000_000_000_000n, onStep = () => {} } = {}) {
  onStep('delegate the announcer — confirm in your wallet');
  const tx = await send(from, CHAIN.NodeDirectory, setAnnouncerCalldata(nodeId, announcer));
  if (fundWei > 0n) {
    const bal = BigInt(await rpc('eth_getBalance', [announcer, 'latest']));
    if (bal < fundWei / 2n) { onStep('fund the announcer with gas — confirm in your wallet'); await send(from, announcer, '0x', fundWei); }
  }
  return tx;
}
