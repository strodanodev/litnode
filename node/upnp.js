/** UPnP IGD port mapping — what a torrent client does to be reachable
 *  behind a home router: find the gateway with SSDP, ask it to forward a
 *  port to us, ask it for the public IP. No third party. Zero dependencies.
 *
 *  Routers that refuse (UPnP off, CGNAT, corporate) just make this report
 *  false; the node then stays outbound-only, which still works for a witness. */
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { request } from 'node:http';

const SSDP = { addr: '239.255.255.250', port: 1900 };
const TARGETS = ['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:device:InternetGatewayDevice:2'];
const SERVICES = ['urn:schemas-upnp-org:service:WANIPConnection:2', 'urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1'];

const get = (url) => new Promise((resolve, reject) => {
  const req = request(url, { method: 'GET', timeout: 5000 }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
  req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); req.end();
});
const soap = (url, service, action, args) => new Promise((resolve, reject) => {
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  const req = request(url, { method: 'POST', timeout: 8000, headers: { 'content-type': 'text/xml; charset="utf-8"', 'content-length': Buffer.byteLength(body), SOAPAction: `"${service}#${action}"` } }, (res) => {
    let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => (res.statusCode === 200 ? resolve(b) : reject(new Error(`${action}: HTTP ${res.statusCode} ${/<errorDescription>([^<]*)/.exec(b)?.[1] ?? ''}`.trim()))));
  });
  req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); req.end(body);
});

/** 100.64.0.0/10: the ISP is NATting us too. No mapping on our router can
 *  make this host reachable on IPv4; only an outbound tunnel can. */
export const isCgnat = (ip) => { const m = /^100\.(\d+)\./.exec(ip ?? ''); return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127; };

/** The LAN address we would tell the router to forward to. */
export function lanAddress() {
  for (const list of Object.values(networkInterfaces())) for (const i of list) if (i.family === 'IPv4' && !i.internal) return i.address;
  return null;
}

/** SSDP discovery → the gateway's WAN*Connection control URL. */
export async function discover({ timeoutMs = 3000 } = {}) {
  const locations = await new Promise((resolve) => {
    const sock = createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Set();
    sock.on('message', (m) => { const loc = /^LOCATION:\s*(.+)$/im.exec(String(m))?.[1]?.trim(); if (loc) found.add(loc); });
    sock.on('error', () => resolve([...found]));
    sock.bind(0, () => {
      for (const st of TARGETS) {
        const msg = `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP.addr}:${SSDP.port}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;
        sock.send(msg, SSDP.port, SSDP.addr);
      }
    });
    setTimeout(() => { try { sock.close(); } catch { /* closed */ } resolve([...found]); }, timeoutMs);
  });
  for (const loc of locations) {
    try {
      const { body } = await get(loc);
      for (const svc of SERVICES) {
        const i = body.indexOf(svc); if (i < 0) continue;
        const ctrl = /<controlURL>([^<]+)<\/controlURL>/.exec(body.slice(i))?.[1];
        if (!ctrl) continue;
        return { location: loc, service: svc, control: new URL(ctrl, loc).href, name: /<friendlyName>([^<]*)/.exec(body)?.[1] ?? 'gateway' };
      }
    } catch { /* next candidate */ }
  }
  return null;
}

/** Map externalPort → internalPort on this host. Lease in seconds (0 = permanent). */
export async function map(gw, { externalPort, internalPort = externalPort, protocol = 'TCP', description = 'litnode', leaseSeconds = 0 }) {
  const client = lanAddress();
  await soap(gw.control, gw.service, 'AddPortMapping', { NewRemoteHost: '', NewExternalPort: externalPort, NewProtocol: protocol, NewInternalPort: internalPort, NewInternalClient: client, NewEnabled: 1, NewPortMappingDescription: description, NewLeaseDuration: leaseSeconds });
  return { externalPort, internalPort, protocol, client };
}
export async function unmap(gw, { externalPort, protocol = 'TCP' }) {
  await soap(gw.control, gw.service, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: externalPort, NewProtocol: protocol });
}
export async function externalIp(gw) {
  const r = await soap(gw.control, gw.service, 'GetExternalIPAddress', {});
  return /<NewExternalIPAddress>([^<]*)/.exec(r)?.[1] ?? null;
}

/** Open the given ports on the gateway and keep them open (re-mapped every
 *  `refreshMs`, since some routers drop permanent leases on reboot). Reports
 *  what happened; never throws into the caller. */
export function keepMapped(ports, { log = () => {}, refreshMs = 30 * 60_000, description = 'litnode', gateway = null } = {}) {
  let gw = gateway, ip = null, mapped = [], lastError = null, timer = null, stopped = false;
  const run = async () => {
    try {
      gw ??= await discover();
      if (!gw) { lastError = 'no UPnP gateway answered (UPnP off on the router, or a second router in front)'; return; }
      ip = await externalIp(gw);
      if (isCgnat(ip)) log(`upnp: the router's WAN address ${ip} is carrier-grade NAT — the ISP shares one public IP; port mapping cannot make this node reachable. Use TUNNEL=quick or a seed on another line.`);
      const ok = [];
      for (const p of ports) { try { await map(gw, { externalPort: p.external, internalPort: p.internal, description: `${description} ${p.label ?? ''}`.trim(), leaseSeconds: 3600 * 2 }); ok.push(p); } catch (e) { lastError = `${p.external}: ${e.message}`; } }
      const before = mapped.map((p) => p.external).join(',');
      mapped = ok;
      if (ok.length && before !== ok.map((p) => p.external).join(',')) log(`upnp: ${gw.name} forwards ${ok.map((p) => `${p.external}→${p.internal}`).join(', ')} to ${lanAddress()}; public IP ${ip}`);
      if (ok.length) lastError = null;
    } catch (e) { lastError = e.message; }
  };
  const first = run().then(() => { if (!stopped) timer = setInterval(run, refreshMs); });
  return {
    ready: first,
    status: () => ({ gateway: gw?.name ?? null, publicIp: ip, cgnat: ip ? isCgnat(ip) : null, mapped: mapped.map((p) => ({ external: p.external, internal: p.internal })), lastError }),
    async stop() { stopped = true; clearInterval(timer); if (gw) for (const p of mapped) await unmap(gw, { externalPort: p.external }).catch(() => {}); },
  };
}
