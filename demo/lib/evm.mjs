/** An in-process EVM for exercising the contracts' BEHAVIOUR in npm test —
 *  slashing, windows, escalation, the attacks — not just their compilation.
 *  @ethereumjs/vm (dev-dependency, no external binary). Time and block
 *  number are under the test's control; blockhash(n) is deterministic so a
 *  seeded draw is reproducible.
 *
 *    const evm = await createEvm();
 *    const token = await evm.deploy('TestLITVM.sol', 'TestLITVM', []);
 *    await evm.send(alice, token, 'faucet', []);
 *    (await evm.read(token, 'balanceOf', [alice])).at(0)
 *    evm.warp(600); evm.mine(3);
 *
 *  Reverts throw an Error whose message carries the decoded custom error
 *  name (`StillLocked(1700000600)`) or the require string. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import solc from 'solc';
import { ethers } from 'ethers';
import { createVM } from '@ethereumjs/vm';
import { Common, Hardfork, Mainnet } from '@ethereumjs/common';
import { createBlock } from '@ethereumjs/block';
import { Address, createAccount, hexToBytes, bytesToHex, createAddressFromString } from '@ethereumjs/util';

const dir = join(process.cwd(), 'contracts');
let compiled = null;
/** Compile every .sol once per process; ABI + bytecode by (file, name). */
export function artifacts() {
  if (compiled) return compiled;
  const files = readdirSync(dir).filter((f) => f.endsWith('.sol'));
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: Object.fromEntries(files.map((f) => [f, { content: readFileSync(join(dir, f), 'utf8') }])),
    settings: { evmVersion: 'shanghai', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  })));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  compiled = out.contracts;
  return compiled;
}

/** A deterministic, well-known private key for account i. */
export const keyOf = (i) => '0x' + (i + 1).toString(16).padStart(64, '0');
export const addressOf = (i) => ethers.computeAddress(keyOf(i)).toLowerCase();

export async function createEvm({ accounts = 24, startTime = 1_800_000_000, startBlock = 100 } = {}) {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Shanghai });
  // blockhash(n): deterministic and never zero for any block the test has "mined"
  const hashOf = (n) => hexToBytes(ethers.keccak256(ethers.toUtf8Bytes(`block-${n}`)));
  let number = startBlock, timestamp = startTime;
  const blockchain = { getBlock: async (n) => ({ hash: () => hashOf(Number(n)) }), putBlock: async () => {}, shallowCopy() { return this; } };
  const vm = await createVM({ common, blockchain });
  const arts = artifacts();
  const ifaces = new Map(); // address → ethers.Interface
  const allErrors = new ethers.Interface([...new Set(Object.values(arts).flatMap((byName) => Object.values(byName).flatMap((c) => c.abi.filter((x) => x.type === 'error').map((x) => JSON.stringify(x)))))].map((s) => JSON.parse(s)));
  for (let i = 0; i < accounts; i++) {
    await vm.stateManager.putAccount(createAddressFromString(addressOf(i)), createAccount({ balance: 10n ** 24n, nonce: 0n }));
  }
  const allRaw = [];
  const block = () => createBlock({ header: { number: BigInt(number), timestamp: BigInt(timestamp), gasLimit: 30_000_000n, baseFeePerGas: 0n } }, { common });
  const decodeRevert = (ret) => {
    const hex = bytesToHex(ret);
    if (hex.length < 10) return 'reverted';
    try { const e = allErrors.parseError(hex); if (e) return `${e.name}(${e.args.map(String).join(',')})`; } catch { /* not a custom error */ }
    try { const r = ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + hex.slice(10)); return `revert: ${r[0]}`; } catch { return `revert ${hex.slice(0, 10)}`; }
  };
  const run = async (fromIdx, to, data, { value = 0n } = {}) => {
    const caller = createAddressFromString(addressOf(fromIdx));
    const r = await vm.evm.runCall({ caller, origin: caller, to: to ? createAddressFromString(to) : undefined, data: hexToBytes(data), value, gasLimit: 20_000_000n, block: block() });
    const ex = r.execResult;
    if (ex.exceptionError) throw new Error(ex.exceptionError.error === 'revert' ? decodeRevert(ex.returnValue) : String(ex.exceptionError.error));
    number += 1; timestamp += 1; // every call is its own block, one second apart
    return { ret: bytesToHex(ex.returnValue), logs: ex.logs ?? [], created: r.createdAddress ? r.createdAddress.toString() : null, gas: ex.executionGasUsed };
  };
  const api = {
    vm, addressOf, keyOf,
    /** Deploy (file, name) with constructor args; returns the lowercase address. */
    deploy: async (file, name, args = [], from = 0) => {
      const { abi, evm } = arts[file][name];
      const iface = new ethers.Interface(abi);
      const data = '0x' + evm.bytecode.object + (args.length ? iface.encodeDeploy(args).slice(2) : '');
      const r = await run(from, null, data);
      ifaces.set(r.created.toLowerCase(), iface);
      return r.created.toLowerCase();
    },
    /** A state-changing call from account `from`; returns { logs: decoded, gas }. */
    send: async (from, to, fn, args = []) => {
      const iface = ifaces.get(to);
      const r = await run(from, to, iface.encodeFunctionData(fn, args));
      const raw = r.logs.map(([addr, topics, data], li) => ({ address: bytesToHex(addr), topics: topics.map(bytesToHex), data: bytesToHex(data), blockNumber: '0x' + (number - 1).toString(16), logIndex: '0x' + li.toString(16) }));
      const logs = raw.map((l) => { try { const p = ifaces.get(l.address.toLowerCase())?.parseLog(l); return p ? { name: p.name, args: p.args } : null; } catch { return null; } }).filter(Boolean);
      allRaw.push(...raw);
      return { logs, raw, gas: r.gas };
    },
    /** Every raw log of every send so far, eth_getLogs-shaped, for the protocol decoders. */
    allLogs: () => allRaw.slice(),
    /** A view call; returns the decoded result array. */
    read: async (to, fn, args = [], from = 0) => {
      const iface = ifaces.get(to);
      const r = await run(from, to, iface.encodeFunctionData(fn, args));
      number -= 1; timestamp -= 1; // a read does not mine
      return iface.decodeFunctionResult(fn, r.ret);
    },
    warp: (seconds) => { timestamp += seconds; },
    mine: (n = 1) => { number += n; timestamp += n; },
    now: () => timestamp, blockNumber: () => number,
    iface: (addr) => ifaces.get(addr),
  };
  void Address;
  return api;
}
