/** A stand-in publisher service for demo/services.test.mjs: HTTP on PORT, echoes what the
 *  node gave it, exits on /crash, echoes WebSocket text frames. */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const env = (k) => process.env[k] ?? null;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/crash') { res.end('bye'); setTimeout(() => process.exit(7), 20); return; }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      path: url.pathname, search: url.search, method: req.method, body, proto: req.headers['x-forwarded-proto'] ?? null,
      name: env('LITNODE_SERVICE'), secret: env('SECRET_FROM_FILE'), peer: env('PEER_URL'), pub: env('PUBLIC_URL'), operatorKey: env('OPERATOR_KEY'), pid: process.pid,
    }));
  });
});
server.on('upgrade', (req, socket) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on('data', (d) => {
    if ((d[0] & 15) === 8) { socket.end(); return; }
    const len = d[1] & 127; const mask = d.subarray(2, 6); const data = Buffer.from(d.subarray(6, 6 + len));
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    const out = Buffer.from(`svc:${req.url}:${data}`);
    socket.write(Buffer.concat([Buffer.from([0x81, out.length]), out]));
  });
  socket.on('error', () => {});
});
server.listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
