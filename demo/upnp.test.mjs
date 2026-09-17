/** UPnP port mapping (node/upnp.js) against a fake gateway: the SOAP calls
 *  are well-formed, the router's external IP is read, a CGNAT address is
 *  recognised, and the node reports all of it on /health.upnp.
 *    node --test demo/upnp.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { map, unmap, externalIp, isCgnat, lanAddress } from '../node/upnp.js';
import { createNode } from '../node/litnode.js';

/** A gateway that speaks just enough UPnP: device description + one WANIPConnection control URL. */
function fakeGateway(publicIp) {
  const calls = [];
  const srv = createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      if (req.url === '/desc.xml') { res.setHeader('content-type', 'text/xml'); return res.end('<root><device><friendlyName>FakeRouter</friendlyName><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl</controlURL></service></serviceList></device></root>'); }
      if (req.url === '/ctl') {
        const action = /SOAPAction: "?[^#]+#(\w+)/i.exec(`SOAPAction: ${req.headers.soapaction}`)?.[1];
        calls.push({ action, body: b });
        if (action === 'GetExternalIPAddress') return res.end(`<s:Envelope><s:Body><u:GetExternalIPAddressResponse><NewExternalIPAddress>${publicIp}</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>`);
        if (action === 'AddPortMapping' && /<NewExternalPort>7801</.test(b)) return res.end('<s:Envelope><s:Body><u:AddPortMappingResponse/></s:Body></s:Envelope>');
        if (action === 'AddPortMapping') { res.statusCode = 500; return res.end('<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>718</errorCode><errorDescription>ConflictInMappingEntry</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>'); }
        if (action === 'DeletePortMapping') return res.end('<s:Envelope><s:Body><u:DeletePortMappingResponse/></s:Body></s:Envelope>');
      }
      res.statusCode = 404; res.end();
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => { const base = `http://127.0.0.1:${srv.address().port}`; resolve({ gw: { location: `${base}/desc.xml`, service: 'urn:schemas-upnp-org:service:WANIPConnection:1', control: `${base}/ctl`, name: 'FakeRouter' }, calls, close: () => srv.close() }); }));
}

test('upnp: SOAP mapping, external IP, refusal surfaced, CGNAT detected', async () => {
  const g = await fakeGateway('100.86.12.34');
  try {
    assert.equal(await externalIp(g.gw), '100.86.12.34');
    assert.equal(isCgnat('100.86.12.34'), true, '100.64/10 is carrier-grade NAT');
    assert.equal(isCgnat('112.210.227.213'), false);
    const m = await map(g.gw, { externalPort: 7801, internalPort: 7801, leaseSeconds: 60 });
    assert.equal(m.client, lanAddress());
    const add = g.calls.find((c) => c.action === 'AddPortMapping');
    assert.match(add.body, /<NewProtocol>TCP<\/NewProtocol>/); assert.match(add.body, /<NewLeaseDuration>60<\/NewLeaseDuration>/);
    await assert.rejects(map(g.gw, { externalPort: 80 }), /ConflictInMappingEntry/);
    await unmap(g.gw, { externalPort: 7801 });
    assert.ok(g.calls.some((c) => c.action === 'DeletePortMapping'));
  } finally { g.close(); }
});

test('upnp: the node reports it on /health.upnp and names CGNAT as the reason it cannot be reached', { timeout: 20_000 }, async (t) => {
  const g = await fakeGateway('100.86.12.34');
  const tmp = mkdtempSync(join(tmpdir(), 'litnode-upnp-'));
  const node = await createNode({ dataDir: tmp, offline: true, heartbeatMs: 200, operator: 'u', roles: ['mesh'], upnp: true, upnpGateway: g.gw, updates: false });
  t.after(async () => { await node.stop().catch(() => {}); g.close(); rmSync(tmp, { recursive: true, force: true }); });
  await node.upnp.ready;
  const h = await (await fetch(`${node.addr}/health`)).json();
  assert.equal(h.upnp.gateway, 'FakeRouter');
  assert.equal(h.upnp.publicIp, '100.86.12.34');
  assert.equal(h.upnp.cgnat, true);
  assert.deepEqual(h.upnp.mapped, []);
  assert.match(h.upnp.lastError, /ConflictInMappingEntry/);
});
