/** What a node pays for a transaction, and how it signs it.
 *
 *  Type 2 (EIP-1559) when the chain reports a base fee: maxFee = 2 × base + tip, a CEILING — the chain charges
 *  the base fee at inclusion, so the ×1.2 legacy price that a spike between estimate and send could undercut is
 *  gone (Liteforge's base fee moved 10M → 68M wei in one day; a sequencer charges base, not tip). Legacy
 *  (type 0) at gasPrice × 1.2 when the block carries no base fee (the in-process test chain, a pre-London RPC).
 *
 *  `capWei` bounds what the hot key will ever bid per gas (MAX_FEE_GWEI, default 5 gwei ≈ 70× Liteforge
 *  today): above it the send is refused rather than the key drained — the backstop seats retry every window. */
import { signTransaction, signTransaction2 } from '../protocol/evm.js';

export const DEFAULT_CAP_WEI = 5_000_000_000n; // 5 gwei

/** Read the fee the next transaction should carry. `call(method, params)` is the RPC. */
export async function feeParams(call, { capWei = DEFAULT_CAP_WEI } = {}) {
  let base = null;
  try { const b = await call('eth_getBlockByNumber', ['latest', false]); if (b?.baseFeePerGas != null) base = BigInt(b.baseFeePerGas); } catch { /* fall through to gasPrice */ }
  if (base === null) {
    const gasPrice = BigInt(await call('eth_gasPrice', [])) * 12n / 10n;
    if (gasPrice > capWei) throw Object.assign(new Error(`gas price ${gasPrice} wei is above the cap (${capWei}); not sending`), { overCap: true });
    return { type: 0, gasPrice };
  }
  if (base > capWei) throw Object.assign(new Error(`base fee ${base} wei is above the cap (${capWei}); not sending`), { overCap: true });
  const tip = base / 10n > 0n ? base / 10n : 1n; // a tenth of base, as the cabinet's wallet suggests; a sequencer ignores it anyway
  const maxFeePerGas = base * 2n + tip > capWei ? capWei : base * 2n + tip;
  return { type: 2, maxFeePerGas, maxPriorityFeePerGas: tip > maxFeePerGas ? maxFeePerGas : tip, baseFee: base };
}

/** Sign { nonce, gasLimit, to, value, data, chainId } with the fee feeParams() returned. */
export function signWithFee(tx, fee, privHex) {
  return fee.type === 2
    ? signTransaction2({ ...tx, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }, privHex)
    : signTransaction({ ...tx, gasPrice: fee.gasPrice }, privHex);
}

/** What the fee costs per gas at inclusion: base for type 2, the bid for legacy. For the "matches left" estimate. */
export const effectivePrice = (fee) => (fee.type === 2 ? fee.baseFee : fee.gasPrice);

export const capFromEnv = (env = process.env) => (env.MAX_FEE_GWEI ? BigInt(Math.round(Number(env.MAX_FEE_GWEI) * 1e9)) : DEFAULT_CAP_WEI);
