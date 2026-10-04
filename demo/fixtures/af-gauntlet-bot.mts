/** A headless Agent Fighter player for demo/af-gauntlet.test.mjs, run with the Agent Fighter checkout's
 *  tsx. It plays one placed match on a gauntlet with its seat ticket, using the title's own reference
 *  agent (packages/server/src/agent-session.ts). The test plays the arcade: at the end the bot prints the
 *  ledger the server named and ITS OWN record of the log; the test checks the head, signs, and answers.
 *
 *    stdout: LEDGER {"ledger":{head,ticks},"entries":[…]}   then   RESULT {reason,winner,ticks}
 *    stdin:  SIG <128 hex>   or   REFUSE */
import { createInterface } from 'node:readline';

const env = process.env;
const { playOneMatch } = await import(env.BOT_SESSION_URL!);
const lines: string[] = [];
let waiter: ((l: string) => void) | null = null;
createInterface({ input: process.stdin }).on('line', (l) => { if (waiter) { const w = waiter; waiter = null; w(l); } else lines.push(l); });
const nextLine = (): Promise<string> => new Promise((r) => { const l = lines.shift(); if (l !== undefined) r(l); else waiter = r; });

const r = await playOneMatch({
  url: env.BOT_WS, name: env.BOT_NAME, character: env.BOT_CHAR, skill: 60, aiSeed: Number(env.BOT_SEED),
  charactersDir: env.BOT_CHARS, paceMs: 1, mode: 'friendly', room: env.BOT_ROOM, ticket: env.BOT_TICKET,
  signLedger: async (ledger: unknown, entries: unknown) => {
    process.stdout.write(`LEDGER ${JSON.stringify({ ledger, entries })}\n`);
    const l = await nextLine();
    return l.startsWith('SIG ') ? l.slice(4).trim() : null;
  },
});
process.stdout.write(`RESULT ${JSON.stringify({ reason: r.result.reason, winner: r.result.winner, ticks: r.result.ledger?.ticks ?? null })}\n`);
process.exit(0);
