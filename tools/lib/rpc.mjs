/** An ethers provider that survives Liteforge's gateway.
 *
 *  Caldera's RPC answers 502 now and then, and ethers polls for receipts in
 *  the background — a retry around one call does not cover the poll, and an
 *  unhandled poll error kills the process mid-transaction (seen while
 *  bonding a node). So the retry lives in the provider: every JSON-RPC send,
 *  foreground or background, gets a few attempts with a growing pause, and
 *  only a non-transient error (a revert, a bad argument) escapes. */
import { ethers } from 'ethers';

const TRANSIENT = new Set(['SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR']);

export class RetryingProvider extends ethers.JsonRpcProvider {
  constructor(url, chainId, { tries = 6, log = () => {} } = {}) {
    super(url, chainId, { staticNetwork: true });
    this._tries = tries;
    this._log = log;
    // A poll that fails for good is reported, not thrown across the process.
    this.on('error', (e) => this._log(`rpc: ${e?.shortMessage ?? e?.message ?? e}`));
  }
  async _send(payload) {
    for (let i = 1; ; i++) {
      try { return await super._send(payload); }
      catch (e) {
        if (!TRANSIENT.has(e?.code) || i >= this._tries) throw e;
        this._log(`rpc: ${e.shortMessage ?? e.message} — retry ${i}/${this._tries - 1}`);
        await new Promise((r) => setTimeout(r, 1500 * i));
      }
    }
  }
}

export const provider = (deployed, opts) => new RetryingProvider(deployed.rpc, deployed.chainId, opts);
