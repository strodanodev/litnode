/** The contracts compile, and their ABIs carry what the node and the
 *  deploy tool rely on. There is no EVM in this repo's test tooling, so a
 *  contract's behaviour is exercised on Liteforge by tools/deploy-contracts
 *  and the migration; this suite is the compile gate that used to exist
 *  only inside the deploy tool, plus the interface facts the node code
 *  encodes by hand (protocol/staking.js, protocol/release.js) checked
 *  against the compiler's own view of the selectors.
 *    node --test demo/contracts.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import solc from 'solc';
import { selector } from '../protocol/keccak.js';
import { STANDING_OF, WITNESS_ELIGIBLE, NODE_OF, DELEGATE_OF, SET_DELEGATE, ADMIN_IS_CONTRACT } from '../protocol/staking.js';
import { STATUS_OF, REGISTER, REVOKE } from '../protocol/release.js';
import { BUILD_STATUS, TITLE_OF, BUILDS_OF, REGISTER_TITLE, SET_BUILD, REVOKE_BUILD, TRANSFER_FROM, OWNER_OF, ACTIVATION_DELAY } from '../protocol/title.js';

const dir = join(process.cwd(), 'contracts');
const files = readdirSync(dir).filter((f) => f.endsWith('.sol'));
const evmVersion = JSON.parse(readFileSync(join(dir, 'deploy.testnet.json'), 'utf8')).evmVersion;
const compiled = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: Object.fromEntries(files.map((f) => [f, { content: readFileSync(join(dir, f), 'utf8') }])),
  settings: { evmVersion, optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.methodIdentifiers'] } } },
})));
const abiOf = (file, name) => compiled.contracts[file][name];
/** function signature → 4-byte selector, as solc computed it */
const selectors = (file, name) => abiOf(file, name).evm.methodIdentifiers;

test('every contract compiles without errors', () => {
  const errors = (compiled.errors ?? []).filter((e) => e.severity === 'error');
  assert.deepEqual(errors.map((e) => e.formattedMessage), [], 'solc errors');
  for (const f of files) assert.ok(compiled.contracts[f], `${f} produced no contract`);
});

test('NodeStake v3: the v2 read survives; the v3 surface exists; no slasher role', () => {
  const s = selectors('NodeStake.sol', 'NodeStake');
  for (const sig of [STANDING_OF, WITNESS_ELIGIBLE, NODE_OF, DELEGATE_OF, SET_DELEGATE, ADMIN_IS_CONTRACT, 'mayActFor(bytes32,address)', 'slash(bytes32,uint16,bytes32)', 'setAdjudicator(address,bool)', 'MAX_TERM()', 'BPS()', 'adjudicators(address)', 'totalActive()', 'lockTerm()', 'eligibilityAge()', 'unbondingPeriod()']) {
    assert.ok(s[sig] !== undefined, `NodeStake lacks ${sig}`);
    assert.equal('0x' + s[sig], selector(sig), `protocol/keccak selector for ${sig} matches solc`);
  }
  assert.equal(s['slasher()'], undefined, 'v3 has no slasher address');
  const abi = abiOf('NodeStake.sol', 'NodeStake').abi;
  const ctor = abi.find((x) => x.type === 'constructor');
  assert.deepEqual(ctor.inputs.map((i) => i.name), ['token_', 'minStake_', 'lockTerm_', 'eligibilityAge_', 'unbondingPeriod_', 'admin_', 'treasury_']);
});

test('ReleaseRegistry: register / revoke / statusOf and the node-side selectors agree', () => {
  const s = selectors('ReleaseRegistry.sol', 'ReleaseRegistry');
  for (const sig of [STATUS_OF, REGISTER, REVOKE, 'activationDelay()', 'adminIsContract()', 'hashes()']) {
    assert.ok(s[sig] !== undefined, `ReleaseRegistry lacks ${sig}`);
    assert.equal('0x' + s[sig], selector(sig));
  }
});

test('TitleRegistry: an ERC-721 with no admin; the node-side selectors agree', () => {
  const s = selectors('TitleRegistry.sol', 'TitleRegistry');
  for (const sig of [BUILD_STATUS, TITLE_OF, BUILDS_OF, REGISTER_TITLE, SET_BUILD, REVOKE_BUILD, TRANSFER_FROM, OWNER_OF, ACTIVATION_DELAY, 'titleIdOf(string)', 'balanceOf(address)', 'approve(address,uint256)', 'getApproved(uint256)', 'setApprovalForAll(address,bool)', 'isApprovedForAll(address,address)', 'safeTransferFrom(address,address,uint256)', 'safeTransferFrom(address,address,uint256,bytes)', 'supportsInterface(bytes4)', 'tokenURI(uint256)', 'name()', 'symbol()']) {
    assert.ok(s[sig] !== undefined, `TitleRegistry lacks ${sig}`);
    assert.equal('0x' + s[sig], selector(sig));
  }
  assert.equal(s['admin()'], undefined, 'no admin: the token holder is the only authority');
  assert.equal(s['setParams(address,uint64)'], undefined);
  const ctor = abiOf('TitleRegistry.sol', 'TitleRegistry').abi.find((x) => x.type === 'constructor');
  assert.deepEqual(ctor.inputs.map((i) => i.name), ['activationDelay_']);
});

test('MatchBook: constructor, the reader interface it declares on NodeStake v3, and that it can only slash through NodeStake', () => {
  const s = selectors('MatchBook.sol', 'MatchBook');
  for (const sig of ['commit(bytes32,bytes32,bytes32,bytes32,bytes32[3])', 'settle(bytes32,bytes32,bytes32,bytes32,bytes32[],int64[],bytes32[])', 'attest(bytes32,bytes32,bytes32)', 'finalize(bytes32)', 'escalate(bytes32,bytes)', 'resolve(bytes32)', 'expire(bytes32)', 'enroll(bytes32)', 'totalWindow()', 'adminIsContract()', 'matchOf(bytes32)']) assert.ok(s[sig] !== undefined, `MatchBook lacks ${sig}`);
  const ctor = abiOf('MatchBook.sol', 'MatchBook').abi.find((x) => x.type === 'constructor');
  assert.deepEqual(ctor.inputs.map((i) => i.name), ['stake_', 'p', 'admin_']);
  assert.deepEqual(ctor.inputs[1].components.map((c) => c.name), ['settleWindow', 'attestWindow', 'escalationWindow', 'drawDelay', 'hostSlashBps', 'witnessSlashBps']);
  // every function MatchBook and EpochAnchor call on NodeStake exists there with the same shape
  const ns = abiOf('NodeStake.sol', 'NodeStake').abi;
  for (const f of [...abiOf('MatchBook.sol', 'INodeStakeV3').abi, ...abiOf('EpochAnchor.sol', 'INodeStakeV3Reader').abi].filter((x) => x.type === 'function')) {
    const real = ns.find((x) => x.type === 'function' && x.name === f.name && x.inputs.length === f.inputs.length);
    assert.ok(real, `NodeStake lacks ${f.name}`);
    assert.deepEqual(real.inputs.map((i) => i.type), f.inputs.map((i) => i.type), `${f.name} inputs`);
    assert.deepEqual(real.outputs.map((o) => o.type), f.outputs.map((o) => o.type), `${f.name} outputs`);
  }
  assert.equal(s['slash(bytes32,uint16,bytes32)'], undefined, 'MatchBook exposes no slash of its own; it is an adjudicator on NodeStake');
});

test('EpochAnchor v3: delegate-sent, stake-weighted, the v2 reads survive', () => {
  const s = selectors('EpochAnchor.sol', 'EpochAnchor');
  for (const sig of ['propose(uint64,bytes32,bytes32)', 'rootOf(uint64)', 'verifyInclusion(uint64,bytes32,bytes32[],bool[])', 'standing(uint64,bytes32)', 'quorumBps()', 'adminIsContract()']) assert.ok(s[sig] !== undefined, `EpochAnchor lacks ${sig}`);
  assert.equal(s['quorum()'], undefined, 'the v2 count quorum is gone');
  const ctor = abiOf('EpochAnchor.sol', 'EpochAnchor').abi.find((x) => x.type === 'constructor');
  assert.deepEqual(ctor.inputs.map((i) => i.type), ['address', 'uint16', 'address']);
});

test('readers of NodeStake keep the v2 standingOf shape', () => {
  // NodeDirectory, NodeBadge and EpochAnchor each declare a reader interface; the tuple must match v3's.
  const want = abiOf('NodeStake.sol', 'NodeStake').abi.find((x) => x.name === 'standingOf');
  for (const [file, name] of [['NodeDirectory.sol', 'INodeStakeReader'], ['NodeBadge.sol', 'INodeStake'], ['EpochAnchor.sol', 'INodeStakeV3Reader']]) {
    const got = abiOf(file, name).abi.find((x) => x.name === 'standingOf');
    assert.deepEqual(got.outputs.map((o) => o.type), want.outputs.map((o) => o.type), `${file} ${name}.standingOf`);
  }
});
