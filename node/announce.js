/** Announce this node's addresses on NodeDirectory, with the announcer key
 *  the operator delegated to this node key. The node still holds no
 *  operator key (BUILD-SPEC §11): the announcer can publish URLs for this
 *  one node and nothing else.
 *
 *  Key: <dataDir>/announcer.json, generated on first run; its address is on
 *  /health so the operator can delegate it (tools/set-announcer.mjs) and
 *  send it a little gas. Until both are done the node says what is missing
 *  and keeps working — announcing is how strangers find a seed, not how
 *  the mesh works. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomPrivateKey, addressOf, signTransaction } from '../protocol/evm.js';
import { entryOfCall, decodeEntry, announcerOfCall, decodeAddress, announceCalldata } from '../protocol/directory.js';

const MIN_GAP_MS = 2 * 60_000;      // never send more often than this
const REFRESH_S = 3 * 24 * 3600;    // re-announce an unchanged entry this often (FRESH_S is 7 d)

export function createAnnouncer({ dataDir, nodeId, contract, chainId, rpc, log = () => {}, emit = () => {} }) {
  const keyPath = join(dataDir, 'announcer.json');
  const key = existsSync(keyPath) ? JSON.parse(readFileSync(keyPath, 'utf8')) : { privateKey: randomPrivateKey() };
  if (!existsSync(keyPath)) writeFileSync(keyPath, JSON.stringify(key, null, 2) + '\n');
  const address = addressOf(key.privateKey);
  let lastSentAt = 0, lastTx = null, lastError = null, entry = null, delegated = null, funded = null, pending = false;

  const call = async (method, params) => { const r = await rpc(method, params); return r; };

  /** Make the chain say what we advertise. Returns what it did. */
  const sync = async (url, wsAddr = '') => {
    if (!contract || !url || pending) return 'skip';
    pending = true;
    try {
      const ent = decodeEntry(await call('eth_call', [entryOfCall(contract, nodeId), 'latest']));
      entry = ent;
      const nowS = Math.floor(Date.now() / 1000);
      const same = ent.url === url && (ent.wsAddr || '') === (wsAddr || '');
      if (same && nowS - ent.updatedAt < REFRESH_S) return 'current';
      if (Date.now() - lastSentAt < MIN_GAP_MS) return 'rate-limited';
      delegated = decodeAddress(await call('eth_call', [announcerOfCall(contract, nodeId), 'latest'])).toLowerCase() === address.toLowerCase();
      if (!delegated) { lastError = `announcer ${address} is not delegated for this node — operator: node tools/set-announcer.mjs ${nodeId.slice(0, 12)}… ${address}`; return 'not-delegated'; }
      const bal = BigInt(await call('eth_getBalance', [address, 'latest']));
      funded = bal > 0n;
      if (!funded) { lastError = `announcer ${address} has no gas — send it a little zkLTC (faucet: liteforge.hub.caldera.xyz)`; return 'unfunded'; }
      const data = announceCalldata(nodeId, url, wsAddr || '');
      const [nonceHex, gasPriceHex, gasHex] = await Promise.all([
        call('eth_getTransactionCount', [address, 'pending']),
        call('eth_gasPrice', []),
        call('eth_estimateGas', [{ from: address, to: contract, data }]),
      ]);
      const raw = signTransaction({ nonce: BigInt(nonceHex), gasPrice: BigInt(gasPriceHex) * 12n / 10n, gasLimit: BigInt(gasHex) * 13n / 10n, to: contract, value: 0n, data, chainId: BigInt(chainId) }, key.privateKey);
      lastSentAt = Date.now();
      lastTx = await call('eth_sendRawTransaction', [raw]);
      lastError = null;
      log(`announced ${url}${wsAddr ? ` + ${wsAddr}` : ''} on NodeDirectory (tx ${lastTx.slice(0, 12)}…)`);
      emit('announced', { url, wsAddr: wsAddr || null, tx: lastTx });
      return 'sent';
    } catch (e) { lastError = String(e.message ?? e); return 'error'; }
    finally { pending = false; }
  };

  return { address, sync, status: () => ({ address, delegated, funded, lastTx, lastError, entry }) };
}
