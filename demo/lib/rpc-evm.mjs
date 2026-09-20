/** A JSON-RPC endpoint over the in-process EVM (demo/lib/evm.mjs), shaped
 *  like Liteforge as the node sees it: the `chainFetch` a test hands
 *  createNode() answers eth_call, eth_sendRawTransaction (the node's own
 *  signed legacy transactions from its delegate key), receipts, logs, blocks
 *  and balances — so a node can commit, settle and attest against the REAL
 *  MatchBook without Liteforge. Chain id 4441, like the testnet.
 *
 *    const chain = await createRpcEvm();
 *    await chain.fund(address, 10n ** 18n);
 *    const node = await createNode({ rpc: 'mock://', chainFetch: chain.fetch, ... });
 *
 *  `listen()` serves the same RPC over HTTP, shaped enough for ethers v6
 *  (blocks with the fields its formatter wants, receipts with
 *  contractAddress, eth_getCode, eth_getTransactionByHash), so the deploy
 *  tool can be run against it unchanged — a dry run of the migration. */
import { ethers } from 'ethers';
import { createVM, runTx } from '@ethereumjs/vm';
import { createCustomCommon, Hardfork, Mainnet } from '@ethereumjs/common';
import { createBlock } from '@ethereumjs/block';
import { createTxFromRLP } from '@ethereumjs/tx';
import { createServer } from 'node:http';
import { createAccount, hexToBytes, bytesToHex, createAddressFromString } from '@ethereumjs/util';
import { artifacts, keyOf, addressOf } from './evm.mjs';

export async function createRpcEvm({ chainId = 4441, startTime = Math.floor(Date.now() / 1000), startBlock = 100, accounts = 24 } = {}) {
  const common = createCustomCommon({ chainId }, Mainnet, { hardfork: Hardfork.Shanghai });
  const hashOf = (n) => '0x' + ethers.keccak256(ethers.toUtf8Bytes(`block-${n}`)).slice(2);
  let number = startBlock;
  let offset = 0; // seconds warped ahead of the wall clock
  const now = () => Math.floor(Date.now() / 1000) + offset;
  const blockchain = { getBlock: async (n) => ({ hash: () => hexToBytes(hashOf(Number(n))) }), putBlock: async () => {}, shallowCopy() { return this; } };
  const vm = await createVM({ common, blockchain });
  const arts = artifacts();
  const ifaces = new Map();
  const receipts = new Map();  // txHash → receipt
  const txs = new Map();       // txHash → the tx as eth_getTransactionByHash returns it
  const logs = [];             // every log, eth_getLogs-shaped
  const blocks = new Map();    // number → { timestamp }
  for (let i = 0; i < accounts; i++) await vm.stateManager.putAccount(createAddressFromString(addressOf(i)), createAccount({ balance: 10n ** 24n, nonce: 0n }));
  // A read (eth_call, eth_estimateGas) must leave no trace: runCall bumps the caller's nonce, so run it inside a checkpoint and revert.
  const allErrors = new ethers.Interface([...new Set(Object.values(arts).flatMap((byName) => Object.values(byName).flatMap((c) => c.abi.filter((x) => x.type === 'error').map((x) => JSON.stringify(x)))))].map((x) => JSON.parse(x)));
  const revertReason = (ret) => { const hex = bytesToHex(ret); try { const e = allErrors.parseError(hex); if (e) return `${e.name}(${e.args.map(String).join(',')})`; } catch { /* not custom */ } try { return 'revert: ' + ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + hex.slice(10))[0]; } catch { return 'execution reverted'; } };
  // ...on a shallow copy of the VM: a checkpoint/revert on the live state left the account cache stale for the next read (nonce read 0 after a mined tx).
  const dryRun = async (opts) => { const copy = await vm.shallowCopy(); return copy.evm.runCall(opts); };
  const mkBlock = () => createBlock({ header: { number: BigInt(number), timestamp: BigInt(now()), gasLimit: 30_000_000n, baseFeePerGas: 0n } }, { common });
  const mined = () => { blocks.set(number, { timestamp: now() }); number += 1; };
  const record = (execLogs, txHash) => execLogs.map(([addr, topics, data], li) => { const l = { address: bytesToHex(addr), topics: topics.map(bytesToHex), data: bytesToHex(data), blockNumber: '0x' + number.toString(16), blockHash: hashOf(number), logIndex: '0x' + li.toString(16), transactionHash: txHash, transactionIndex: '0x0', removed: false }; logs.push(l); return l; });

  // ---- what the harness itself does (deploy, fund) outside the RPC
  const runFrom = async (fromIdx, to, data) => {
    const caller = createAddressFromString(addressOf(fromIdx));
    const r = await vm.evm.runCall({ caller, origin: caller, to: to ? createAddressFromString(to) : undefined, data: hexToBytes(data), gasLimit: 20_000_000n, block: mkBlock() });
    if (r.execResult.exceptionError) throw new Error(`harness call failed: ${r.execResult.exceptionError.error}`);
    record(r.execResult.logs ?? [], '0x' + '00'.repeat(32));
    mined();
    return r;
  };
  const api = {
    vm, chainId, addressOf, keyOf,
    deploy: async (file, name, args = [], from = 0) => {
      const { abi, evm } = arts[file][name];
      const iface = new ethers.Interface(abi);
      const r = await runFrom(from, null, '0x' + evm.bytecode.object + (args.length ? iface.encodeDeploy(args).slice(2) : ''));
      const addr = r.createdAddress.toString().toLowerCase();
      ifaces.set(addr, iface);
      return addr;
    },
    send: async (from, to, fn, args = []) => { const r = await runFrom(from, to, ifaces.get(to).encodeFunctionData(fn, args)); return { logs: (r.execResult.logs ?? []).length }; },
    read: async (to, fn, args = []) => {
      const r = await dryRun({ to: createAddressFromString(to), data: hexToBytes(ifaces.get(to).encodeFunctionData(fn, args)), gasLimit: 20_000_000n, block: mkBlock() });
      return ifaces.get(to).decodeFunctionResult(fn, bytesToHex(r.execResult.returnValue));
    },
    fund: async (address, wei) => { const a = createAddressFromString(address); const acc = (await vm.stateManager.getAccount(a)) ?? createAccount({ balance: 0n, nonce: 0n }); acc.balance += wei; await vm.stateManager.putAccount(a, acc); },
    warp: (s) => { offset += s; },
    mine: (n = 1) => { for (let i = 0; i < n; i++) mined(); },
    blockNumber: () => number,
    logs: () => logs.slice(),
    iface: (addr) => ifaces.get(addr),
    // ---- the RPC the node talks to. One request at a time: a dry run's checkpoint/revert must never
    // straddle another request's runTx (ethers fires estimateGas, nonce and fee reads concurrently).
    rpc: (method, params) => { const p = chainOfRequests.then(() => rpcNow(method, params)); chainOfRequests = p.catch(() => {}); return p; },
  };
  let chainOfRequests = Promise.resolve();
  const rpcNow = async (method, params) => {
      switch (method) {
        case 'eth_chainId': return '0x' + chainId.toString(16);
        case 'eth_blockNumber': return '0x' + (number - 1).toString(16);
        case 'eth_gasPrice': return '0x1';
        case 'eth_getBalance': { const acc = await vm.stateManager.getAccount(createAddressFromString(params[0])); return '0x' + (acc?.balance ?? 0n).toString(16); }
        case 'eth_getTransactionCount': { const acc = await vm.stateManager.getAccount(createAddressFromString(params[0])); return '0x' + (acc?.nonce ?? 0n).toString(16); }
        case 'eth_getBlockByNumber': {
          const n = params[0] === 'latest' || params[0] === 'pending' ? number - 1 : parseInt(params[0], 16);
          const b = blocks.get(n) ?? { timestamp: now() };
          // no baseFeePerGas: ethers then sends legacy (gasPrice) transactions, which is what the node signs too
          return { number: '0x' + n.toString(16), timestamp: '0x' + b.timestamp.toString(16), hash: hashOf(n), parentHash: hashOf(n - 1), nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1c9c380', gasUsed: '0x0', miner: '0x' + '00'.repeat(20), extraData: '0x', transactions: [], sha3Uncles: '0x' + '00'.repeat(32), logsBloom: '0x' + '00'.repeat(256), stateRoot: '0x' + '00'.repeat(32), receiptsRoot: '0x' + '00'.repeat(32), transactionsRoot: '0x' + '00'.repeat(32), mixHash: '0x' + '00'.repeat(32), size: '0x0', totalDifficulty: '0x0', uncles: [] };
        }
        case 'eth_getCode': { const a = createAddressFromString(params[0]); const code = await vm.stateManager.getCode(a); return bytesToHex(code); }
        case 'eth_getTransactionByHash': return txs.get(params[0]) ?? null;
        case 'net_version': return String(chainId);
        case 'eth_call': {
          const c = params[0];
          const r = await dryRun({ caller: c.from ? createAddressFromString(c.from) : undefined, to: c.to ? createAddressFromString(c.to) : undefined, data: hexToBytes(c.data ?? '0x'), gasLimit: 20_000_000n, block: mkBlock() });
          if (r.execResult.exceptionError) throw Object.assign(new Error(revertReason(r.execResult.returnValue)), { rpc: true });
          return bytesToHex(r.execResult.returnValue);
        }
        case 'eth_estimateGas': {
          const c = params[0];
          const r = await dryRun({ caller: createAddressFromString(c.from), to: c.to ? createAddressFromString(c.to) : undefined, data: hexToBytes(c.data ?? '0x'), gasLimit: 20_000_000n, block: mkBlock() });
          if (r.execResult.exceptionError) throw Object.assign(new Error(revertReason(r.execResult.returnValue)), { rpc: true });
          // execution + the intrinsic cost ethers does not add back (21k base, 32k for a create, calldata bytes) + margin
          const bytes = BigInt(((c.data ?? '0x').length - 2) / 2);
          return '0x' + (r.execResult.executionGasUsed + 21_000n + (c.to ? 0n : 32_000n) + bytes * 16n + 20_000n).toString(16);
        }
        case 'eth_sendRawTransaction': {
          const tx = createTxFromRLP(hexToBytes(params[0]), { common });
          const hash = bytesToHex(tx.hash());
          const res = await runTx(vm, { tx, block: mkBlock(), skipBalance: false, skipBlockGasLimitValidation: true });
          const ok = !res.execResult.exceptionError;
          const txLogs = ok ? record(res.execResult.logs ?? [], hash) : [];
          const from = tx.getSenderAddress().toString(), to = tx.to?.toString() ?? null, blockHex = '0x' + number.toString(16);
          const created = res.createdAddress ? res.createdAddress.toString() : null;
          if (created && ok) ifaces.set(created.toLowerCase(), ifaces.get(created.toLowerCase()) ?? null);
          receipts.set(hash, { transactionHash: hash, transactionIndex: '0x0', status: ok ? '0x1' : '0x0', blockNumber: blockHex, blockHash: hashOf(number), gasUsed: '0x' + res.totalGasSpent.toString(16), cumulativeGasUsed: '0x' + res.totalGasSpent.toString(16), effectiveGasPrice: '0x1', type: '0x0', logs: txLogs, logsBloom: '0x' + '00'.repeat(256), from, to, contractAddress: created });
          txs.set(hash, { hash, blockHash: hashOf(number), blockNumber: blockHex, transactionIndex: '0x0', from, to, nonce: '0x' + tx.nonce.toString(16), gas: '0x' + tx.gasLimit.toString(16), gasPrice: '0x' + (tx.gasPrice ?? 1n).toString(16), value: '0x' + tx.value.toString(16), input: bytesToHex(tx.data), type: '0x0', chainId: '0x' + chainId.toString(16), v: '0x' + (tx.v ?? 0n).toString(16), r: '0x' + (tx.r ?? 0n).toString(16), s: '0x' + (tx.s ?? 0n).toString(16) });
          mined();
          return hash;
        }
        case 'eth_getTransactionReceipt': return receipts.get(params[0]) ?? null;
        case 'eth_getLogs': {
          const f = params[0];
          const from = f.fromBlock == null || f.fromBlock === 'earliest' ? 0 : f.fromBlock === 'latest' ? number - 1 : parseInt(f.fromBlock, 16);
          const to = f.toBlock == null || f.toBlock === 'latest' || f.toBlock === 'pending' ? number : parseInt(f.toBlock, 16);
          const addrs = f.address ? (Array.isArray(f.address) ? f.address : [f.address]).map((a) => a.toLowerCase()) : null;
          const t0 = f.topics?.[0] ? (Array.isArray(f.topics[0]) ? f.topics[0] : [f.topics[0]]).map((t) => t.toLowerCase()) : null;
          return logs.filter((l) => { const n = parseInt(l.blockNumber, 16); return n >= from && n <= to && (!addrs || addrs.includes(l.address.toLowerCase())) && (!t0 || t0.includes(l.topics[0].toLowerCase())); });
        }
        default: throw Object.assign(new Error(`method ${method} not supported by the test chain`), { rpc: true });
      }
  };
  /** Serve the RPC over HTTP for tools that hold an ethers provider (the deploy tool). Returns { url, close }. */
  api.listen = async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', async () => {
        // ethers caches identical reads (the pending nonce among them) for 250 ms; a chain that mines in
        // microseconds would hand it a stale nonce, so a send takes 300 ms to answer, like a real block.
        const answer = async (r) => { try { const result = await api.rpc(r.method, r.params ?? []); if (r.method === 'eth_sendRawTransaction') await new Promise((res) => setTimeout(res, 300)); return { jsonrpc: '2.0', id: r.id, result }; } catch (e) { return { jsonrpc: '2.0', id: r.id, error: { code: -32000, message: e.message } }; } };
        let parsed; try { parsed = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
        const out = Array.isArray(parsed) ? await Promise.all(parsed.map(answer)) : await answer(parsed);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
  };
  /** The fetch(url, { body }) the node's chain.js calls. */
  api.fetch = async (_url, init) => {
    const req = JSON.parse(init.body);
    try { const result = await api.rpc(req.method, req.params ?? []); return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) }; }
    catch (e) { return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: e.message } }) }; }
  };
  return api;
}
