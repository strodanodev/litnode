/** Headless Agent Fighter players for the tests that run the real per-match server (demo/af-gauntlet.test.mjs,
 *  demo/publisher-offline.test.mjs): an Agent Fighter checkout (AF_ROOT, default E:/NPC/AGENT FIGHTER/agent-fighter)
 *  with node_modules, its tsx, and demo/fixtures/af-gauntlet-bot.mts. The test plays the arcade for each bot: it
 *  checks the head of the bot's OWN log and signs it with the player's key. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chainHead, ledgerBody, signLedger } from '../../protocol/log.js';
import { signSeat } from '../../protocol/challenge.js';

export const AF = resolve(process.env.AF_ROOT ?? 'E:/NPC/AGENT FIGHTER/agent-fighter');
const TSX = join(AF, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const BOT = join(process.cwd(), 'demo', 'fixtures', 'af-gauntlet-bot.mts');
/** false when there is no checkout to run: the tests skip. */
export const haveAf = existsSync(TSX) && existsSync(join(AF, 'packages', 'server', 'src', 'gauntlet-server.ts'));

/** The gauntlet config for this checkout, from gauntlets/agent-fighter.json: bots play faster than real time
 *  (a gauntlet has no economy for the pace check to guard). */
export const afGauntlet = (cfg) => ({ ...cfg, cwd: AF, env: { ...cfg.env, AF_NO_PACE_CHECK: '1' } });

/** Claim a seat on a gateway room with the player's signature over its challenge. */
export async function claimSeat(gatewayUrl, room, kp) {
  const { challenge } = await (await fetch(`${gatewayUrl}/${room}/ticket?player=${kp.publicKey}`)).json();
  const sig = await signSeat(challenge, kp.privateKey);
  const r = await fetch(`${gatewayUrl}/${room}/ticket?player=${kp.publicKey}&nonce=${challenge.nonce}&sig=${sig}`);
  if (r.status !== 200) throw new Error(`seat claim: HTTP ${r.status}`);
  return r.json();
}

/** Run one bot; play the arcade for it: check the head of its own log, sign, answer. */
export const runBot = ({ kp, ws, ticket, room, name, char, seed, match }) => new Promise((resolveBot, reject) => {
  const child = spawn(process.execPath, [TSX, BOT], {
    cwd: AF, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BOT_SESSION_URL: pathToFileURL(join(AF, 'packages', 'server', 'src', 'agent-session.ts')).href, BOT_WS: ws, BOT_TICKET: ticket, BOT_ROOM: room, BOT_NAME: name, BOT_CHAR: char, BOT_SEED: String(seed), BOT_CHARS: join(AF, 'characters') },
  });
  let buf = '', err = '', signedHead = null, result = null;
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.on('data', async (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (line.startsWith('LEDGER ')) {
        const { ledger, entries } = JSON.parse(line.slice(7));
        // What the arcade does (cabinet:sign with entries): the head of the player's OWN record, not the host's word.
        const own = chainHead(entries);
        if (own !== ledger.head || entries.length !== ledger.ticks) { child.stdin.write('REFUSE\n'); continue; }
        signedHead = own;
        const sig = await signLedger(ledgerBody({ matchId: match.matchId, ticks: entries.length, head: own, buildHash: match.buildHash ?? null }), kp);
        child.stdin.write(`SIG ${sig}\n`);
      } else if (line.startsWith('RESULT ')) result = JSON.parse(line.slice(7));
    }
  });
  child.on('exit', (code) => (result ? resolveBot({ ...result, signedHead }) : reject(new Error(`bot ${name} exited ${code} without a result: ${err.slice(-800)}`))));
});
