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
/** Send one call through the wallet and wait for its receipt. */
async function send(from, to, data, value = 0n) {
  const tx = await eth().request({ method: 'eth_sendTransaction', params: [{ from, to, data, ...(value ? { value: hex(value) } : {}) }] });
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
  const announcer = CHAIN.NodeDirectory ? decodeAddress(await rpc('eth_call', [announcerOfCall(CHAIN.NodeDirectory, nodeId), 'latest'])).toLowerCase() : null;
  return { bonded: s.active, amount: s.amount, operator: s.operator.toLowerCase(), minStake, balance, announcer: announcer && /^0x0{40}$/.test(announcer) ? null : announcer };
}

export const connectOperator = () => connect();

export async function faucet(from) { return send(from, CHAIN.TestLITVM, faucetCalldata()); }

/** approve + stake at the contract's minimum. Two wallet prompts. */
export async function bond(from, nodeId, { onStep = () => {} } = {}) {
  const minStake = BigInt(await rpc('eth_call', [minStakeCall(CHAIN.NodeStake), 'latest']));
  onStep(`approve ${minStake} wei of tLITVM — confirm in your wallet`);
  await send(from, CHAIN.TestLITVM, approveCalldata(CHAIN.NodeStake, minStake));
  onStep('stake — confirm in your wallet');
  return send(from, CHAIN.NodeStake, stakeCalldata(nodeId, minStake));
}

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
