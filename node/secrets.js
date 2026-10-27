/** The secrets rule (docs/SETTLEMENT-ARCHITECTURE.md §11): a litnode install
 *  holds ONE stored secret, the node's own key (<dataDir>/identity.json and
 *  the announcer key beside it). Per-run secrets the node mints in memory (a
 *  gauntlet's ticket secret, LITNODE_GAUNTLET_TOKEN) are allowed: they never
 *  touch disk and die with the run. Anything else — a publisher's .env, a
 *  database URL, a service key, a player's wallet key — belongs in the
 *  studio's managed env, not on an operator's machine.
 *
 *  This module only DETECTS. What the node does with a finding is the policy:
 *  SECRETS_POLICY=warn (default until Season 0) logs it and reports it on
 *  /health and in `npm run host -- doctor`; SECRETS_POLICY=strict refuses to
 *  start a service or gauntlet whose environment would carry one. Names are
 *  reported, never values. */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const POLICIES = ['warn', 'strict'];
export const policyOf = (v) => (POLICIES.includes(String(v ?? '').toLowerCase()) ? String(v).toLowerCase() : 'warn');

/** Variable names that hold credentials by convention. Matched on the whole name, case-insensitively.
 *  Not secrets, and deliberately not matched: SEEDS (peer URLs), AIR_PARTNER_ID (a public app id), RELAY_KEYS /
 *  COURTS / VERIFIERS (public keys and hashes), *_PUBLIC_KEY(S). */
const SECRET_NAME_RES = [
  /SECRET/i, /PRIVATE_?KEY/i, /SERVICE_?(ROLE_?)?KEY/i, /PASSW(OR)?D/i, /API_?KEY/i, /ACCESS_?KEY/i,
  /AUTH_?TOKEN/i, /_TOKEN$/i, /^TOKEN$/i, /MNEMONIC/i, /SEED_?PHRASE/i, /JWT_?KEY/i, /SIGNING_?KEY/i,
  /^SUPABASE_(?!URL$|ANON_KEY$)/i, /^DATABASE_URL$/i, /^(POSTGRES|PG)_?(URL|PASSWORD|PRISMA_URL|URL_NON_POOLING)$/i,
  /^(OPERATOR|DEPLOYER|PUBLISHER|ADMIN)_KEY$/i,
  // A path to a key file is the key by another name (PB's COURT_IDENTITY).
  /_IDENTITY$/i, /KEY_?(FILE|PATH)$/i,
];
const NOT_SECRET_RES = [/PUBLIC_?KEYS?$/i, /_PUBKEY$/i, /^LITNODE_GAUNTLET_TOKEN$/i];

export const isSecretName = (name) => {
  const k = String(name);
  return !NOT_SECRET_RES.some((r) => r.test(k)) && SECRET_NAME_RES.some((r) => r.test(k));
};

/** The secret-shaped names in an env object (values ignored), sorted. `except`: names allowed here (per-run). */
export const secretNames = (env, { except = [] } = {}) => {
  const skip = new Set(except.map((k) => String(k).toUpperCase()));
  return Object.keys(env ?? {}).filter((k) => !skip.has(k.toUpperCase()) && isSecretName(k)).sort();
};

/** Content that is a credential whatever file it sits in. Used on the data folder and on release archives. */
export const SECRET_PATTERNS = [
  { id: 'pem-private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'json-private-key', re: /"(privateKey|private_key|secretKey|secret_key|mnemonic)"\s*:\s*"[^"]{16,}"/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: 'db-url-with-password', re: /\b(postgres(ql)?|mysql|mongodb(\+srv)?):\/\/[^:\s/@]+:[^@\s]+@/ },
  { id: 'stripe-live-key', re: /\b[sr]k_live_[A-Za-z0-9]{16,}/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { id: 'env-secret-line', test: (text) => envSecretLines(text).length > 0 },
];

/** A documentation placeholder, not a value: `<64 hex>`, `…`, `your-key`, `xxxx`, `${VAR}`. */
const PLACEHOLDER_RE = /^["']?(<[^>]*>|.*(…|\.\.\.).*|your[-_].*|x{4,}|\$\{[^}]+\}|%[A-Z_]+%)["']?$/i;

/** KEY=VALUE lines (env-file convention: an UPPER_CASE name) whose key is secret-shaped and whose value is a real
 *  value, not empty and not a placeholder. Lower-case names are code (`secretsPolicy = 'warn'`), not env. */
export const envSecretLines = (text) => String(text).split(/\r?\n/)
  .map((l) => /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(l))
  .filter((m) => m && m[2] && !/^["']?["']?$/.test(m[2]) && !PLACEHOLDER_RE.test(m[2]) && isSecretName(m[1]))
  .map((m) => m[1]);

/** Pattern ids found in a text. */
export const scanText = (text) => SECRET_PATTERNS.filter((p) => (p.test ? p.test(text) : p.re.test(text))).map((p) => p.id);

/** Files in <dataDir> the node itself owns that may hold its own key. */
export const OWN_KEY_FILES = ['identity.json', 'announcer.json'];
/** Folders of content-addressed data: never scanned (large, and their bytes are hashed public artifacts). */
const SKIP_DIRS = new Set(['deltas', 'ledgers', 'logs', 'rulesets', 'servers', 'verifiers', 'epochs', 'gauntlet-logs']);
const MAX_FILE = 1024 * 1024;

/** Scan a node's data folder (two levels deep) for anything but its own key. Returns findings
 *  [{ path, kind, detail }]: `proxies` (AIR proxy wallet keys, node/proxy.js), or a pattern id. */
export function scanDataDir(dataDir) {
  const findings = [];
  if (!dataDir || !existsSync(dataDir)) return findings;
  const proxies = join(dataDir, 'proxies');
  if (existsSync(proxies)) {
    let n = 0;
    try { n = readdirSync(proxies).filter((f) => f.endsWith('.json')).length; } catch { /* unreadable */ }
    if (n) findings.push({ path: 'proxies/', kind: 'proxies', detail: `${n} AIR proxy wallet key(s): player wallets held by this node` });
  }
  const walk = (dir, rel, depth) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (depth < 1 && !SKIP_DIRS.has(e.name) && e.name !== 'proxies') walk(join(dir, e.name), r, depth + 1); continue; }
      if (!e.isFile() || (depth === 0 && OWN_KEY_FILES.includes(e.name))) continue;
      try {
        if (statSync(join(dir, e.name)).size > MAX_FILE) continue;
        const ids = scanText(readFileSync(join(dir, e.name), 'utf8'));
        if (ids.length) findings.push({ path: r, kind: ids[0], detail: ids.join(', ') });
      } catch { /* unreadable: not ours to judge */ }
    }
  };
  walk(dataDir, '', 0);
  return findings;
}
