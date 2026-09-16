/** Read-only litVM access from the browser: the node's bond (NodeStake
 *  .standingOf) and the operator's tLITVM balance. Uses the node's own
 *  staking/keccak modules so the calldata is byte-identical to what the
 *  node sends. The RPC allows any origin. Nothing here signs anything. */
import { standingCall, decodeStanding } from './protocol/staking.js';
import { selector } from './protocol/keccak.js';
import { CHAIN } from './config.js';

let id = 0;
async function call(method, params) {
  const r = await fetch(CHAIN.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(12000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

const BALANCE_OF = selector('balanceOf(address)');
const wei = (hex) => BigInt(hex || '0x0');
const tokens = (n) => Number(n / 10n ** 14n) / 10_000; // 4 decimals is plenty for a dashboard

/** { bonded, amount, operator, balance, block } or null when unreachable. */
export async function readStake(nodeId) {
  if (!CHAIN.rpc || !CHAIN.NodeStake) return null;
  try {
    const [standing, head] = await Promise.all([
      call('eth_call', [standingCall(CHAIN.NodeStake, nodeId), 'latest']),
      call('eth_blockNumber', []),
    ]);
    const s = decodeStanding(standing);
    let balance = null;
    if (CHAIN.TestLITVM && s.active) {
      const data = BALANCE_OF + s.operator.slice(2).padStart(64, '0');
      balance = tokens(wei(await call('eth_call', [{ to: CHAIN.TestLITVM, data }, 'latest'])));
    }
    return { bonded: s.active, amount: tokens(s.amount), operator: s.operator, balance, block: parseInt(head, 16) };
  } catch (e) {
    return { error: e.message };
  }
}
