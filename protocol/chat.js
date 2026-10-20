/** Node chat (docs/NODE-CHAT.md). Pure: what a message is, its id, what a
 *  receiver refuses, and the root of a ring of them.
 *
 *  A message is one more signed envelope on the gossip every node already
 *  pushes — `seal(CHAT_TAG, { v, at, text }, nodeKey)` — verified before it is
 *  held or forwarded, like a heartbeat or a queue entry. Its id is derived from
 *  signer, time and text, so the same message arriving from two peers is one
 *  message. No rooms, no replies, no edits, no deletes: a global, public,
 *  plain-text line between operators. Every table a stranger can add to has a
 *  ceiling (the constants below), and the rate limit is over the messages'
 *  own timestamps, so every node refuses the same flood whatever order the
 *  gossip delivered it in. */
import { h } from './canonical.js';
import { buildTree } from './epoch.js';

export const CHAT_TAG = 'chat';
export const CHAT_VERSION = 1;
export const CHAT_MAX_CHARS = 280;              // code points, after trim
export const CHAT_PAST_MS = 24 * 3600_000;      // older than this: not held (the ring's TTL)
export const CHAT_FUTURE_MS = 60_000;           // stamped further ahead than the receiver's clock: refused
export const CHAT_RING = 200;                   // messages held and served
export const CHAT_UNBONDED_RING = 16;           // held from unbonded keys in total; never forwarded
export const CHAT_RATE_WINDOW_MS = 15_000;      // per key: at most CHAT_BURST messages whose timestamps fall in any window this long
export const CHAT_BURST = 3;
export const CHAT_PUSH_WINDOW_MS = 120_000;     // what a tick pushes; the whole ring goes in a reply when the pusher is behind
export const CHAT_PER_MESSAGE = 64;             // envelopes looked at per gossip message
export const CHAT_SEEN_MAX = 64;                // peers remembered per message for the seen-by count

const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/; // every control character but newline

/** The body a sender seals: trimmed text, stamped now. Throws on text a receiver would refuse. */
export function chatBody(text, now = Date.now()) {
  const body = { v: CHAT_VERSION, at: now, text: String(text ?? '').trim() };
  const why = chatProblem({ body, signer: 'x', sig: 'x' }, { now });
  if (why) throw new Error(why === 'malformed' ? `a message is 1..${CHAT_MAX_CHARS} characters of plain text` : why);
  return body;
}

/** The message's id: signer, time and text — never sent, always derived. */
export const chatId = (env) => h(CHAT_TAG, { signer: env.signer, at: env.body.at, text: env.body.text });

/** Why a receiver refuses an envelope on its face, before any signature work: 'malformed' | 'window' | null. */
export function chatProblem(env, { now = Date.now() } = {}) {
  const b = env?.body;
  if (!b || typeof env.signer !== 'string' || typeof env.sig !== 'string') return 'malformed';
  if (b.v !== CHAT_VERSION || !Number.isInteger(b.at) || typeof b.text !== 'string') return 'malformed';
  if (b.text !== b.text.trim() || CONTROL.test(b.text)) return 'malformed';
  const n = [...b.text].length;
  if (n < 1 || n > CHAT_MAX_CHARS) return 'malformed';
  if (b.at < now - CHAT_PAST_MS || b.at > now + CHAT_FUTURE_MS) return 'window';
  return null;
}

/** The rate limit, order-independent: `held` is the timestamps already held for this signer; a new message at `at`
 *  is refused when CHAT_BURST of them already fall within CHAT_RATE_WINDOW_MS of it. */
export const chatRateOk = (held, at) => held.filter((t) => Math.abs(t - at) < CHAT_RATE_WINDOW_MS).length < CHAT_BURST;

/** The root over a set of ids (sorted, deduplicated — protocol/epoch.js). Empty ring → the empty-epoch root. */
export const chatRoot = (ids) => buildTree(ids).root;
