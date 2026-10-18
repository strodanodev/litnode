/** A stand-in for a title's match server SHIPPED AS A SERVER BUNDLE (node/server-bundle.js): what a node spawns
 *  per placed match after fetching the bundle by hash from a peer. Reads only the GAUNTLET_* environment the
 *  node sets, verifies join tickets at its WebSocket gate, echoes traffic, and on `end:<a>-<b>` signs an attested
 *  outcome as this node's court and posts it to the node — the fake court's loop, with nothing machine-local:
 *  its court key lives in GAUNTLET_STATE_DIR (the per-title directory the node gives a bundle), created there
 *  on first use when the operator did not provision one. demo/server-bundle.test.mjs packs this file with
 *  protocol/keys.js + canonical.js beside it (the bundle is self-contained, as a real one is).
 *
 *  env: GAUNTLET_PORT · GAUNTLET_SECRET · GAUNTLET_SEATS (JSON) · GAUNTLET_MATCH_ID · GAUNTLET_NODE_URL
 *       GAUNTLET_PLACED_MODE · GAUNTLET_STATE_DIR · GAUNTLET_SERVER (the bundle's hash, echoed) · GAUNTLET_RULESET */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { sign, generateKeypair } from './protocol/keys.js';

const port = Number(process.env.GAUNTLET_PORT);
const secret = process.env.GAUNTLET_SECRET;
const seats = JSON.parse(process.env.GAUNTLET_SEATS ?? '[]');
const matchId = process.env.GAUNTLET_MATCH_ID;
const rulesetId = process.env.GAUNTLET_RULESET ?? 'pickle-brawl.v1';
const stateDir = process.env.GAUNTLET_STATE_DIR;
if (!stateDir) throw new Error('GAUNTLET_STATE_DIR is not set');
mkdirSync(stateDir, { recursive: true });
const keyFile = join(stateDir, 'court.json');
if (!existsSync(keyFile)) writeFileSync(keyFile, JSON.stringify(await generateKeypair()));
const identity = JSON.parse(readFileSync(keyFile, 'utf8'));

const verify = (ticket) => {
  const dot = ticket.indexOf('.');
  const payload = ticket.slice(0, dot);
  if (createHmac('sha256', secret).update(payload).digest('base64url') !== ticket.slice(dot + 1)) return null;
  const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  return c.matchId === matchId && c.exp > Date.now() ? c : null;
};
const frame = (text) => { const b = Buffer.from(text); const h = b.length < 126 ? Buffer.from([0x81, b.length]) : Buffer.from([0x81, 126, b.length >> 8, b.length & 255]); return Buffer.concat([h, b]); };
const unframe = (buf) => { const len0 = buf[1] & 127; let off = 2, len = len0; if (len0 === 126) { len = buf.readUInt16BE(2); off = 4; } const mask = buf.subarray(off, off + 4); const data = Buffer.from(buf.subarray(off + 4, off + 4 + len)); for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4]; return { text: data.toString('utf8'), rest: buf.subarray(off + 4 + len) }; };

const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ bundled: true, matchId, seats: seats.length, server: process.env.GAUNTLET_SERVER ?? null, court: identity.publicKey, cwd: process.cwd(), argv1: process.argv[1] })); });
const clients = new Set();
server.on('upgrade', (req, socket) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let seated = null, buf = Buffer.alloc(0);
  socket.on('data', async (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      if ((buf[0] & 15) === 8) { socket.end(); return; }
      const { text, rest } = unframe(buf); buf = rest;
      if (!seated) {
        let msg; try { msg = JSON.parse(text); } catch { socket.write(frame('refused:malformed')); socket.end(); return; }
        const c = verify(msg.ticket ?? '');
        if (!c) { socket.write(frame('refused:bad_ticket')); socket.end(); return; }
        seated = c; clients.add(socket);
        socket.write(frame(`seated:${c.sub}:${c.team}:${c.slot}:${c.mode}`));
        continue;
      }
      const end = /^end:(\d+)-(\d+)$/.exec(text);
      if (end) {
        const scoreA = Number(end[1]), scoreB = Number(end[2]);
        const report = { matchId, mode: seated.mode, scoreA, scoreB, winnerTeam: scoreA > scoreB ? 0 : scoreB > scoreA ? 1 : null, courtUrl: process.env.GAUNTLET_PUBLIC_URL, ticks: 100, claims: seats.map((s) => ({ sub: s.sub, team: s.team, slot: s.slot })) };
        const teams = [report.claims.filter((c) => c.team === 0).map((c) => c.sub), report.claims.filter((c) => c.team === 1).map((c) => c.sub)];
        const sig = await sign('attest', { matchId, rulesetId, report }, identity.privateKey);
        const r = await fetch(`${process.env.GAUNTLET_NODE_URL}/ledger`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'attested', matchId, rulesetId, mode: process.env.GAUNTLET_PLACED_MODE ?? 'casual', participants: [...teams[0], ...teams[1]], teams, report, attestor: { id: identity.publicKey, sig } }) });
        const j = await r.json();
        for (const c of clients) c.write(frame(`settled:${r.status}:${j.attestation ?? j.error}`));
        continue;
      }
      for (const c of clients) c.write(frame(`echo:${text}`));
    }
  });
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});
server.listen(port, '127.0.0.1', () => console.log(`bundled server on :${port} for ${matchId} (${seats.length} seats)`));
process.on('SIGTERM', () => process.exit(0));
