/** A stand-in for a title's headless match server (Pickle Brawl's court),
 *  spawned by node/gauntlet.js in tests. Reads the same environment the
 *  real court gets, verifies join tickets at its WebSocket gate, and on
 *  `end:<a>-<b>` from any seated client signs an attested outcome report
 *  and posts it to the node — the whole loop, without a game engine.
 *
 *  env: PORT · COURT_TICKET_SECRET · COURT_PUBLIC_URL · LITNODE_SEATS (JSON)
 *       LITNODE_URL · COURT_IDENTITY (path) · GAUNTLET_MATCH_ID */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { sign } from '../../protocol/keys.js';

const port = Number(process.env.PORT);
const secret = process.env.COURT_TICKET_SECRET;
const seats = JSON.parse(process.env.LITNODE_SEATS ?? '[]');
const identity = process.env.COURT_IDENTITY ? JSON.parse(readFileSync(process.env.COURT_IDENTITY, 'utf8')) : null;
const matchId = process.env.GAUNTLET_MATCH_ID;
if (process.env.FAKE_COURT_CRASH === '1') { console.error('fake court: crashing on purpose'); process.exit(3); }
if (process.env.FAKE_COURT_SLOW_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_COURT_SLOW_MS)));

const verify = (ticket) => {
  const dot = ticket.indexOf('.');
  const payload = ticket.slice(0, dot);
  if (createHmac('sha256', secret).update(payload).digest('base64url') !== ticket.slice(dot + 1)) return null;
  const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  return c.matchId === matchId && c.exp > Date.now() ? c : null;
};

// Minimal RFC 6455 server: text frames only, no fragmentation, enough for a test.
const frame = (text) => { const b = Buffer.from(text); const h = b.length < 126 ? Buffer.from([0x81, b.length]) : Buffer.from([0x81, 126, b.length >> 8, b.length & 255]); return Buffer.concat([h, b]); };
const unframe = (buf) => { const len0 = buf[1] & 127; let off = 2, len = len0; if (len0 === 126) { len = buf.readUInt16BE(2); off = 4; } const mask = buf.subarray(off, off + 4); const data = Buffer.from(buf.subarray(off + 4, off + 4 + len)); for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4]; return { text: data.toString('utf8'), rest: buf.subarray(off + 4 + len) }; };

const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ court: true, matchId, seats: seats.length, publicUrl: process.env.COURT_PUBLIC_URL })); });
const clients = new Set();
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let seated = null, buf = Buffer.alloc(0);
  socket.on('data', async (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 15;
      if (op === 8) { socket.end(); return; }
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
        const report = { matchId, mode: seated.mode, scoreA, scoreB, winnerTeam: scoreA > scoreB ? 0 : scoreB > scoreA ? 1 : null, courtUrl: process.env.COURT_PUBLIC_URL, ticks: 100, claims: seats.map((s) => ({ sub: s.sub, team: s.team, slot: s.slot })) };
        const id = (c) => (/^[0-9a-f]{64}$/.test(c.sub) ? c.sub : `pb:${c.sub}`);
        const teams = [report.claims.filter((c) => c.team === 0).map(id), report.claims.filter((c) => c.team === 1).map(id)];
        const sig = await sign('attest', { matchId, rulesetId: 'pickle-brawl.v1', report }, identity.privateKey);
        const r = await fetch(`${process.env.LITNODE_URL}/ledger`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'attested', matchId, rulesetId: 'pickle-brawl.v1', mode: process.env.GAUNTLET_PLACED_MODE ?? 'casual', participants: [...teams[0], ...teams[1]], teams, report, attestor: { id: identity.publicKey, sig } }) });
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
server.listen(port, '127.0.0.1', () => console.log(`fake court on :${port} for ${matchId} (${seats.length} seats)`));
process.on('SIGTERM', () => process.exit(0));
