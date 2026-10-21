/** sdk/court — the court client for an attested litnode title. See README.md. */

export type Bytes = Uint8Array | ArrayBuffer | ArrayBufferView | string;
export type Fetch = (input: string, init?: Record<string, unknown>) => Promise<{ status?: number; ok?: boolean; headers?: { get(name: string): string | null }; text?(): Promise<string>; json?(): Promise<unknown> }>;

export const ATTEST_TAG: 'attest';
export const WHOAMI_TAG: 'whoami';
export const LOG_MAX_BYTES: number;
export const LOG_PROTOCOL: 4;
export const SETTLING_ROLES: readonly ['host', 'settler', 'relay'];
export const CONTRACTS_URL: string;
export const DEFAULT_RPCS: readonly string[];
export const DEFAULT_CONTRACTS: Readonly<{ generation: number; NodeDirectory: string; NodeStake: string }>;
export const SELECTORS: Readonly<{ keys: string; keysPage: string; entryOf: string; standingOf: string }>;
export const FRESH_S: number;
export const STAT_NAME_RE: RegExp;
export const STATS_MAX_NAMES: number;

/** The court key: ed25519 as hex (`npm run bridge -- key`), or a signer held elsewhere (KMS/HSM). */
export type Identity =
  | { publicKey: string; privateKey: string }
  | { publicKey: string; sign(bytes: Uint8Array): Promise<string | Uint8Array> | string | Uint8Array };

/** Settlement v4: inside the signed report, so safe on any node version. */
export interface Commitments {
  logFormat: string;
  /** Lowercase hex sha256 of the exact log bytes, or null when there is no log. */
  inputsHash: string | null;
  finalHash: string | null;
  verifierHash: string | null;
}
/** participant → counter name (/^[a-zA-Z][a-zA-Z0-9]{0,31}$/, at most 32) → non-negative integer. */
export type Stats = Record<string, Record<string, number>>;

export interface Report { commitments?: Commitments; stats?: Stats; [field: string]: unknown }
export interface Attestor { id: string; sig: string }

export interface Envelope {
  kind: 'attested';
  matchId: string;
  rulesetId: string;
  mode: 'ranked' | 'casual';
  participants: string[];
  teams?: [string[], string[]];
  report: Report;
  attestor: Attestor;
  meta?: Record<string, unknown>;
}
export interface EnvelopeFields {
  matchId: string;
  rulesetId: string;
  mode?: 'ranked' | 'casual';
  participants: string[];
  teams?: [string[], string[]];
  report: Report;
  meta?: Record<string, unknown>;
}

export function canonical(value: unknown): string;
export function toHex(bytes: ArrayLike<number>): string;
export function fromHex(hex: string): Uint8Array;
export function signingBytes(tag: string, body: unknown): Uint8Array;
export function attestBody(env: { matchId: string; rulesetId: string; report: Report }): { matchId: string; rulesetId: string; report: Report };

export function signReport(body: { matchId: string; rulesetId: string; report: Report }, identity: Identity): Promise<Attestor>;
export function verifySignature(tag: string, body: unknown, sigHex: string, publicKeyHex: string): Promise<boolean>;
export function verifyEnvelope(env: Envelope): Promise<boolean>;
export function checkReport(report: unknown, participants?: string[] | null): string[];
export function checkEnvelope(env: unknown): string[];
/** Throws a TypeError listing every problem. */
export function envelope(fields: EnvelopeFields & { attestor: Attestor }): Envelope;
export function attest(fields: EnvelopeFields, identity: Identity): Promise<Envelope>;

export function inputsHash(bytes: Bytes): Promise<string>;
/** Throws a RangeError past LOG_MAX_BYTES. */
export function encodeLog(bytes: Bytes): string;
export function decodeLog(b64: string): Uint8Array;
export function makeCommitments(o: { logFormat: string; log?: Bytes | null; finalHash?: string | null; verifierHash?: string | null }): Promise<Commitments>;

export interface DiscoveryOptions {
  rulesetId?: string | null;
  /** { NodeDirectory, NodeStake, generation? } as addresses, or the arcade contracts.json shape. Default: read contractsUrl, else DEFAULT_CONTRACTS. */
  contracts?: Record<string, unknown> | null;
  contractsUrl?: string;
  /** One URL, a comma-separated list or an array, preferred first. Default: contracts.json's rpc, then DEFAULT_RPCS. */
  rpc?: string | string[] | null;
  fetch?: Fetch;
  /** Node ids or URLs to pass over (one that just refused, say). */
  exclude?: string[];
  /** Requests in flight at once (RPC and node probes). Default 4. */
  concurrency?: number;
  /** Floor between RPC request starts, per second; 0 = none. Default 8 (the gateway 429s past ~25/s per IP). */
  maxRps?: number;
  /** Base of the jittered exponential backoff. Default 500 ms. */
  backoffMs?: number;
  /** 'auto' (default): keysPage(offset, limit) on generation 4+, falling back to keys(). */
  keysPage?: 'auto' | boolean;
  timeoutMs?: number;
}
export interface Seed { nodeId: string; url: string; wsAddr: string | null; updatedAt: number; operator: string }
export interface Directory { seeds: Seed[]; keys: number; via: 'keys' | 'keysPage'; contracts: { NodeDirectory: string; NodeStake: string; generation: number | null; source: string }; rpc: string }
export interface Settler {
  url: string; nodeId: string; operator: string; updatedAt: number; wsAddr: string | null;
  protocol: number; version: string | null; roles: string[];
  candidates: number; tried: Array<{ url: string; reason: string }>;
  via: 'keys' | 'keysPage'; rpc: string; contracts: Directory['contracts'];
}

export function readDirectory(o?: DiscoveryOptions & { pageSize?: number; now?: number }): Promise<Directory>;
export function proveNode(url: string, nodeId: string, o?: { fetch?: Fetch; maxSkewMs?: number; timeoutMs?: number; backoffMs?: number }): Promise<{ ok: boolean; reason?: string }>;
/** Throws when no seed qualifies; the error carries `tried` and `candidates`. */
export function findSettler(o?: DiscoveryOptions): Promise<Settler>;

export function decodeBytes32Array(hexRet: string): string[];
export function decodeEntry(hexRet: string): { url: string; wsAddr: string; updatedAt: number; announcer: string | null };
export function decodeStanding(hexRet: string): { operator: string; amount: bigint; active: boolean };

export interface SettleOptions {
  /** An origin, a findSettler() result, or 'auto' (default). */
  node?: string | { url: string } | 'auto';
  /** The exact log bytes; sent only to a node whose /health says protocol >= 4. */
  log?: Bytes | null;
  fetch?: Fetch;
  /** Retries for transient failures (network, timeout, 408, 429, 5xx). Default 3. */
  retries?: number;
  backoffMs?: number;
  /** POST /ledger timeout. Default 30 s. */
  timeoutMs?: number;
  /** findSettler options when node is 'auto'. */
  discovery?: DiscoveryOptions;
}
export interface SettleResult {
  status: 'settled' | 'already' | 'refused' | 'unreachable';
  matchId: string;
  node: string | null;
  delta?: Record<string, unknown>;
  error?: string;
  httpStatus?: number | null;
  protocol?: number;
  logAttached: boolean;
}
/** Never throws for a network failure; throws for a caller error (log too big, or not hashing to report.commitments.inputsHash). */
export function settle(env: Envelope | Record<string, unknown>, o?: SettleOptions): Promise<SettleResult>;
