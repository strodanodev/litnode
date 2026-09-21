/** Quick-tunnel names resolve through Cloudflare's DoH, not the machine's
 *  resolver: a name asked one second early is NXDOMAIN there for the zone's
 *  1800 s minimum, and that is how the desktop lost its public URL for 38
 *  minutes on 21 Sep 2026.
 *    node --test demo/dns.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { install, resolveDoh, flush } from '../node/dns.js';

const doh = (table) => async (url) => {
  const name = new URL(url).searchParams.get('name');
  const a = table[name];
  if (a === 'down') throw new Error('doh down');
  return { ok: true, json: async () => (a ? { Status: 0, Answer: a.map((ip) => ({ type: 1, TTL: 60, data: ip })) } : { Status: 3, Answer: [] }) };
};

test('resolveDoh: a positive answer, NXDOMAIN, and the second endpoint when the first is down', async () => {
  const f = doh({ 'x.trycloudflare.com': ['104.16.1.1', '104.16.1.2'] });
  const r = await resolveDoh('x.trycloudflare.com', { fetchImpl: f });
  assert.deepEqual(r.addresses.map((a) => a.address), ['104.16.1.1', '104.16.1.2']); assert.equal(r.ttl, 60);
  const n = await resolveDoh('nope.trycloudflare.com', { fetchImpl: f });
  assert.equal(n.addresses.length, 0); assert.equal(n.status, 3);
  let calls = 0;
  const flaky = async (url) => { calls++; if (calls === 1) throw new Error('first endpoint down'); return f(url); };
  assert.equal((await resolveDoh('x.trycloudflare.com', { fetchImpl: flaky })).addresses.length, 2);
  assert.equal(calls, 2, 'fell through to the second endpoint');
});

test('install: dns.lookup answers trycloudflare names from DoH (cached for the TTL, negatives not cached) and leaves other names to the system', async () => {
  const table = { 'new.trycloudflare.com': undefined };
  let dohCalls = 0;
  install({ fetchImpl: async (u) => { dohCalls++; return doh(table)(u); } });
  const lookup = (host, opts = {}) => new Promise((res, rej) => dns.lookup(host, opts, (e, a, fam) => (e ? rej(e) : res(opts.all ? a : { address: a, family: fam }))));
  // not yet published: ENOTFOUND, and asked again next time (no negative cache)
  await assert.rejects(lookup('new.trycloudflare.com'), (e) => e.code === 'ENOTFOUND');
  table['new.trycloudflare.com'] = ['104.16.9.9'];
  assert.deepEqual(await lookup('new.trycloudflare.com'), { address: '104.16.9.9', family: 4 });
  const before = dohCalls;
  assert.deepEqual(await lookup('new.trycloudflare.com', { all: true }), [{ address: '104.16.9.9', family: 4 }]);
  assert.equal(dohCalls, before, 'a positive answer is cached');
  flush();
  await lookup('new.trycloudflare.com');
  assert.equal(dohCalls, before + 1, 'asked again after a flush');
  // the system resolver still answers everything else
  const lo = await lookup('localhost');
  assert.ok(['127.0.0.1', '::1'].includes(lo.address));
  assert.equal(dohCalls, before + 1, 'localhost never went to DoH');
});
