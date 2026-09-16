/** Run one litnode from environment variables.
 *
 *    PORT=7801 OPERATOR=publisher RULESETS=./rulesets/agent-fighter.v1.js npm run node
 *    PORT=7802 OPERATOR=guild-a SEEDS=http://127.0.0.1:7801 npm run node
 *
 *  RPC and NODE_STAKE default from contracts/deployed.testnet.json when it
 *  exists; OFFLINE=1 forces the local beacon and no stake reads. */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNode } from './litnode.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deployedPath = join(root, 'contracts', 'deployed.testnet.json');
const deployed = existsSync(deployedPath) ? JSON.parse(readFileSync(deployedPath, 'utf8')) : {};
const env = process.env;
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

const node = await createNode({
  dataDir: env.DATA_DIR ?? join(root, 'data', env.OPERATOR ?? 'node'),
  port: Number(env.PORT ?? 7801),
  host: env.HOST ?? '127.0.0.1',
  publicAddr: env.PUBLIC_ADDR ?? null,
  operator: env.OPERATOR ?? 'dev',
  roles: list(env.ROLES).length ? list(env.ROLES) : ['mesh', 'host', 'witness'],
  region: env.REGION ?? 'local',
  // The relay this node fronts (wss://… for browsers on https pages). Only a
  // node with a relay advertises one; the lobby launches against it.
  wsAddr: env.WS_ADDR ?? null,
  seeds: list(env.SEEDS),
  rulesets: list(env.RULESETS),
  rpc: env.OFFLINE ? null : (env.RPC ?? deployed.rpc ?? 'https://liteforge.rpc.caldera.xyz/http'),
  offline: !!env.OFFLINE,
  nodeStake: env.NODE_STAKE ?? deployed.NodeStake?.address ?? null,
  log: (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`),
});
console.log(`health: ${node.addr}/health`);
const bail = async () => { await node.stop(); process.exit(0); };
process.on('SIGINT', bail);
process.on('SIGTERM', bail);
