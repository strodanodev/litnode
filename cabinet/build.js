/** #/build — the arcade's developer docs: the SDK instructions and a
 *  "for dummies" walk through how the mesh works, drawn as diagrams.
 *
 *  Static content, no node needed: it renders the same on every node's
 *  cabinet and on arcade.litvm.games. The source of truth for the words is
 *  docs/SDK.md in the litnode repository; keep the two in step (the
 *  cabinet test checks the version stamp below against the package). The
 *  diagrams are generated from step lists, not hand-drawn, so a change to
 *  the flow is one array edit. */
import { CABINET_VERSION } from './version.js';

const REPO = 'https://github.com/strodanodev/litnode';
const doc = (p) => `${REPO}/blob/master/${p}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ─────────────────────────────────────────────── diagrams ──
// A flow: boxes left to right, wrapping to new rows, arrows between them.
// Each step: { t: title, s?: subtitle, k?: 'you'|'node'|'chain'|'player'|'arcade' }.
const TONE = { you: 'var(--peach)', node: 'var(--cyan)', chain: 'var(--green)', player: 'var(--purple)', arcade: 'var(--gold)' };
function flow(steps, { perRow = 4, w = 232, h = 62, gx = 26, gy = 40 } = {}) {
  const rows = Math.ceil(steps.length / perRow);
  const W = Math.min(steps.length, perRow) * w + (Math.min(steps.length, perRow) - 1) * gx + 8;
  const H = rows * h + (rows - 1) * gy + 8;
  let svg = '';
  steps.forEach((st, i) => {
    const r = Math.floor(i / perRow), c = i % perRow;
    const x = 4 + c * (w + gx), y = 4 + r * (h + gy);
    const tone = TONE[st.k ?? 'node'];
    svg += `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="rgba(9,13,22,.55)" stroke="${tone}" stroke-width="1.2"/>`;
    svg += `<rect x="${x}" y="${y}" width="4" height="${h}" fill="${tone}"/>`;
    svg += `<text x="${x + 14}" y="${y + 24}" fill="var(--fg)" font-family="var(--head)" font-size="13" font-weight="600">${esc(st.t)}</text>`;
    if (st.s) svg += `<text x="${x + 14}" y="${y + 44}" fill="var(--dim)" font-family="var(--mono)" font-size="10">${esc(st.s)}</text>`;
    svg += '</g>';
    if (i < steps.length - 1) {
      if (c < perRow - 1) svg += `<path d="M${x + w} ${y + h / 2} h${gx - 8}" stroke="var(--edge2)" stroke-width="1.5" marker-end="url(#arr)" fill="none"/>`;
      else { const ny = y + h + gy; svg += `<path d="M${x + w / 2} ${y + h} v${gy / 2 - 2} H${4 + w / 2} V${ny - 6}" stroke="var(--edge2)" stroke-width="1.5" marker-end="url(#arr)" fill="none"/>`; }
    }
  });
  return `<svg class="diagram" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"><defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--edge2)"/></marker></defs>${svg}</svg>`;
}
// Layers: stacked bands with a label and what lives there.
function layers(bands, { w = 700, h = 44, gap = 6 } = {}) {
  const H = bands.length * (h + gap) + 4;
  let svg = '';
  bands.forEach((b, i) => {
    const y = 2 + i * (h + gap), tone = TONE[b.k ?? 'node'];
    svg += `<rect x="2" y="${y}" width="${w - 4}" height="${h}" rx="3" fill="rgba(9,13,22,.55)" stroke="${tone}" stroke-width="1.2"/>`;
    svg += `<text x="16" y="${y + 19}" fill="${tone}" font-family="var(--mono)" font-size="10.5" letter-spacing="1.5">${esc(b.t.toUpperCase())}</text>`;
    svg += `<text x="16" y="${y + 35}" fill="var(--fg2)" font-family="var(--head)" font-size="12.5">${esc(b.s)}</text>`;
  });
  return `<svg class="diagram" viewBox="0 0 ${w} ${H}" width="${w}" height="${H}" role="img">${svg}</svg>`;
}
const legend = () => `<div class="dg-legend">${Object.entries({ you: 'yours', node: 'a node', chain: 'litVM chain', player: 'the player', arcade: 'the arcade' }).map(([k, v]) => `<span><i style="background:${TONE[k]}"></i>${v}</span>`).join('')}</div>`;

// ─────────────────────────────────────────────── content ──
const cmd = (s) => `<pre class="cmd">${esc(s)}</pre>`;
const p = (s) => `<p>${s}</p>`;
const ul = (items) => `<ul class="doc-list">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
const t = (rows, head) => `<div class="tbl"><table>${head ? `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>` : ''}<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const a = (href, text) => `<a class="link" href="${href}" target="_blank" rel="noopener">${text}</a>`;

const dummies = () => `
${p('You have a game. Players play it. At the end, somebody has to say who won, and everybody else has to be able to trust that. That is the whole problem. Here is how the mesh solves it, one picture at a time.')}
<h4>1. What happens to one match</h4>
${flow([
  { t: 'Player finds a match', s: 'signs a queue entry', k: 'player' },
  { t: 'Arcade verifies', s: 'recomputes the draw itself', k: 'arcade' },
  { t: 'Node places it', s: 'beacon from a chain block', k: 'node' },
  { t: 'Host commits', s: 'MatchBook: match + 3 witnesses', k: 'chain' },
  { t: 'You run the match', s: 'your server, relay or client', k: 'you' },
  { t: 'One record leaves', s: 'input log or signed report', k: 'you' },
  { t: 'Host settles', s: 'replays it in a sandbox', k: 'node' },
  { t: '3 witnesses attest', s: 'other operators, same hash?', k: 'node' },
  { t: 'Chain finalizes', s: '2 agree, nobody dissents', k: 'chain' },
  { t: 'Ladder updates', s: 'folded from chain events', k: 'arcade' },
])}
${legend()}
${p('Nothing on the ladder comes from anyone\'s word. A match is a signed input log (or, for games that cannot be replayed, a signed report from your own court). The host node re-runs it, three witness nodes under other operators re-run it too, and the result is only <b>official</b> once the chain says they agreed. A witness that reaches a different answer files a dispute, and nine more nodes are drawn to settle it.')}
<h4>2. Who holds which key</h4>
${layers([
  { t: 'Player key', s: 'An ed25519 key in the browser. Signs queue entries and the end of every match. Can be bound to a wallet once.', k: 'player' },
  { t: 'Node key', s: 'identity.json on the node. Signs heartbeats, placements, deltas. What NodeStake bonds.', k: 'node' },
  { t: 'Hot key (delegate)', s: 'A small EVM key the node runs with. Pays gas for commit, settle, attest, finalize. Never holds the bond.', k: 'node' },
  { t: 'Operator wallet', s: 'Bonds the node, names the delegate. Lives in your shell for one command, never on the node.', k: 'you' },
  { t: 'Court or relay key', s: 'Your server\'s identity. Signs outcome reports (attested) or input logs (relay). The node lists it in COURTS or RELAY_KEYS.', k: 'you' },
  { t: 'Publisher wallet', s: 'Holds the title as an ERC-721 on TitleRegistry and bonds the host that lists it. Transfer the token to hand the title over.', k: 'you' },
])}
${p('No single key can do everything, on purpose. A leaked hot key costs gas, not a bond. A leaked court key costs one title\'s reports until you rotate it. The wallet that matters is never on a server.')}
<h4>3. Three ways in</h4>
${flow([
  { t: 'A. Bring your backend', s: 'your server posts one record', k: 'you' },
  { t: 'bridge signs it', s: 'as your court or relay', k: 'node' },
  { t: 'node settles', s: 'attested or relay-labelled', k: 'node' },
], { perRow: 3 })}
${flow([
  { t: 'B. Run it on the node', s: 'no hosting anywhere else', k: 'you' },
  { t: 'node spawns your server', s: 'per match, seats the players', k: 'node' },
  { t: 'your server reports', s: 'over loopback; placed: true', k: 'node' },
], { perRow: 3 })}
${flow([
  { t: 'C. Build from scratch', s: 'one deterministic file', k: 'you' },
  { t: 'client records inputs', s: 'the arcade shell signs for them', k: 'player' },
  { t: 'node replays', s: 'players-signed, can be OFFICIAL', k: 'node' },
], { perRow: 3 })}
<h4>4. What a result can be called</h4>
${flow([
  { t: 'host', s: 'the host\'s word only', k: 'node' },
  { t: 'relay', s: 'your key signed the log', k: 'you' },
  { t: 'attested', s: 'your court signed the outcome', k: 'you' },
  { t: 'players', s: 'both players signed', k: 'player' },
  { t: 'OFFICIAL', s: 'placed, witnessed, final on chain', k: 'chain' },
], { perRow: 5, w: 196, gx: 18 })}
${p('Left to right, more trust. Only a replayable match that the mesh placed, both players signed and the witnesses agreed on becomes official. An attested game is on the ladder, labelled, and stays there.')}
<h4>5. A node\'s life</h4>
${flow([
  { t: 'init', s: 'node.env + identity', k: 'you' },
  { t: 'start', s: 'supervised, self-updating', k: 'node' },
  { t: 'bond', s: '1 tLITVM, your wallet', k: 'chain' },
  { t: 'delegate', s: 'hot key + a little gas', k: 'chain' },
  { t: 'publish', s: 'tunnel, proof, announce', k: 'node' },
  { t: 'enroll', s: 'the nine-seat pool', k: 'chain' },
  { t: 'host + witness', s: 'commit, attest, settle', k: 'node' },
  { t: 'earn (phase 3)', s: 'per-match fee split', k: 'chain' },
], { perRow: 4 })}
${p('Every step is one command, and the Nodes page shows the same checklist live, read from the node and the chain. A node that is not bonded still listens; only a bonded one is drawn.')}
`;

const sdk = () => `
${p(`This is the SDK contract as of litnode <span class="mono">${esc(CABINET_VERSION)}</span>. The words are the same as ${a(doc('docs/SDK.md'), 'docs/SDK.md')} in the repository; the code is the proof. Everything is Apache-2.0.`)}
<h4>Prerequisites</h4>
${t([
  ['Node.js 20+', 'the node and every tool; a game engine of your own may need 22+'],
  ['the repository', `<span class="mono">git clone ${REPO}</span> then <span class="mono">npm install</span> once`],
  ['cloudflared', 'public reachability with no router or certificate; on PATH'],
  ['a wallet with test tokens', 'tLITVM to bond (faucet in the arcade), a little zkLTC for the hot key (Caldera faucet)'],
  ['an agent, optionally', '<span class="mono">host</span>, <span class="mono">bridge</span> and <span class="mono">fleet</span> answer in JSON with <span class="mono">--json</span>; the skills in <span class="mono">.claude/skills</span> walk each path'],
])}
<h4>1. Which kind of title</h4>
${cmd('npm run bridge -- assess --input-log yes|no --deterministic yes|no --engine-open yes|no')}
${t([
  ['replayable', 'per-tick inputs, deterministic, bundles as one import-free module', 'the node re-runs it; witnesses re-run it; can be OFFICIAL'],
  ['attested', 'anything else: float physics, closed engine, no input log', 'your court signs the outcome; the node validates it; labelled, never official'],
], ['kind', 'you have', 'the mesh does'])}
<h4>2. The title file</h4>
${cmd('npm run create-title -- my-game.v1 "My Game"\nnpm run conformance -- titles/my-game.v1.mjs\nnpm run bundle:title -- titles/my-game.v1.mjs      # rulesets/my-game.v1.js + .json { buildHash }')}
${p('Replayable: <span class="mono">init / step / done / serialize / view / scores</span> and a manifest with <span class="mono">display</span>. Attested: <span class="mono">validate(report)</span> and <span class="mono">scores(report, participants, teams)</span>. Integers or <span class="mono">seededRandom</span>; never the clock, the network or storage. The conformance suite is the gate every node runs before loading you.')}
<h4>3. Claim it</h4>
${cmd('export PUBLISHER_KEY=0x...                  # the wallet that holds the title; bond the host from this same wallet (step 5)\nnpm run publish:title -- register rulesets/my-game.v1.js\nnpm run publish:title -- set-build rulesets/my-game.v1.js   # a retune, active after the delay\nnpm run publish:title -- status rulesets/my-game.v1.js')}
${p('A title is an ERC-721 on TitleRegistry: whoever holds it is the publisher. Nodes load a build from the chain\'s word. The arcade lists a registered title only while a bonded node from the same wallet hosts it; registered but unhosted is not listed and nothing is lost.')}
<h4>4A. Bring your backend</h4>
${cmd('npm run bridge -- key --kind attested --ruleset my-game.v1     # prints COURTS=my-game.v1:<publicKey> for the node operator\nexport BRIDGE_TOKEN=<random, 16+ chars>\nnpm run bridge -- serve --port 8480 --node auto --ruleset my-game.v1 --kind attested\n# or, with no server change:\nnpm run bridge -- watch --adapter jsonl --source ./results.jsonl --node auto --ruleset my-game.v1 --kind attested\nnpm run bridge -- check <matchId> --node auto --ruleset my-game.v1')}
${p('Your server POSTs the unsigned submission to the bridge at match end; the bridge signs and forwards it. <span class="mono">--node auto</span> finds the live node through NodeDirectory on chain. Attested shape: <span class="mono">{ kind, matchId, rulesetId, mode, participants, teams, report }</span>. Replayable: <span class="mono">{ matchId, rulesetId, buildHash, mode, participants, entries: [{k, inputs}], signatures? }</span>.')}
<h4>4B. Run your match server on the node</h4>
${cmd('{ "command": "${node}", "args": ["node_modules/tsx/dist/cli.mjs", "services/court/src/court.ts"], "cwd": "/your/checkout",\n  "env": { "PORT": "${port}", "COURT_TICKET_SECRET": "${secret}", "COURT_PUBLIC_URL": "${publicUrl}",\n           "LITNODE_SEATS": "${seats}", "LITNODE_URL": "${nodeUrl}", "COURT_IDENTITY": "/path/court-key.json" },\n  "portRange": [7777, 7787], "readyMs": 120000, "ttlMs": 900000, "settledGraceMs": 5000 }\n# node.env:  GAUNTLETS=my-game.v1=./gauntlets/my-game.json   RELAY_PORT=8478')}
${p('The node spawns your process for each match it hosts, mints one HMAC join ticket per placed player (<span class="mono">{ sub, matchId, team, slot, mode, exp }</span>), serves them at <span class="mono">https://&lt;wsAddr host&gt;/&lt;room&gt;/ticket?player=&lt;key&gt;</span>, proxies <span class="mono">wss://&lt;wsAddr&gt;/&lt;room&gt;</span> to it, and ends it a few seconds after the match settles. Your client reads <span class="mono">?ws&amp;room&amp;player&amp;match</span> from the arcade launch, fetches its ticket, joins.')}
<h4>4C. Build from scratch</h4>
${cmd("import title from './my-game.v1.mjs';\nimport { connectShell, createSim, createRecorder, matchSeed, externalAgents, settle } from './litnode/sdk/client.js';\nconst shell = await connectShell();              // cabinet:init → { player, node, match, chain }\nconst m = shell.match;                           // matchId, hostAddr, participants, mode, buildHash, wsAddr\nconst sim = createSim(title, { seed: matchSeed(m), participants: m.participants, ctx: { agents: externalAgents(m.participants) } });\nconst rec = createRecorder({ matchId: m.matchId, participants: m.participants, rulesetId: 'my-game.v1', buildHash: m.buildHash, mode: m.mode });\n// each tick:  sim.step(inputs); rec.record(inputs); render(sim.view());\n// at the end: await settle({ nodeUrl: m.hostAddr, recorder: rec, signers: { [me]: shell, [them]: theirSig } });   // me = shell.player.id; theirSig over your transport")}
${p('The client imports the same file the node replays. The arcade shell signs the ledger head for the player (<span class="mono">cabinet:sign</span>), so the key never enters your game. Transport between players is yours.')}
<h4>The arcade shell protocol</h4>
${t([
  ['game → shell', '<span class="mono">cabinet:hello</span>', 'ask for init'],
  ['shell → game', '<span class="mono">cabinet:init { player, node, game, chain, match? }</span>', 'identity, the node, the contract set, the placement'],
  ['game → shell', '<span class="mono">cabinet:sign { body }</span>', 'the player\'s signature over { matchId, ticks, head, buildHash }, only for the match launched'],
  ['shell → game', '<span class="mono">cabinet:signed { matchId, player, sig }</span>', 'or { error }'],
  ['game → shell', '<span class="mono">cabinet:played { matchId }</span>', 'the placed match was played; the arcade closes the title'],
  ['game → shell', '<span class="mono">cabinet:exit</span>', 'back to the launcher'],
], ['direction', 'message', 'meaning'])}
${p(`Drop-in helper: ${a(doc('cabinet/sdk-client.js'), 'cabinet/sdk-client.js')} (init and exit only, a no-op outside the arcade; to sign, use connectShell from sdk/client.js). Launch URL for a placed match: <span class="mono">?ws=&lt;relay&gt;&amp;room=LIT-…&amp;player=&lt;key&gt;&amp;match=&lt;id&gt;&amp;build=&lt;hash&gt;</span>.`)}
<h4>5. Run a node</h4>
${cmd('npm run host -- init --operator my-studio --roles mesh,host,witness,settler --rulesets ./rulesets/my-game.v1.js --tunnel quick\nnpm run host -- doctor && npm run host -- start --detach\nexport OPERATOR_KEY=0x...                          # your wallet, this shell only\nnpm run host -- bond                            # 1 tLITVM on testnet\nnpm run delegate -- <nodeId> <announcer address> --fund 0.005   # the hot key the node sends with\nnpm run host -- publish --fund 0.02             # tunnel, proof of possession, announce on NodeDirectory\nnpm run enroll -- <nodeId>                      # the nine-seat escalation pool\nunset OPERATOR_KEY\nnpm run host -- install-service && npm run host -- verify')}
${p('Or do the same from the Nodes page with a wallet: Bond this node, name the delegate, enroll, and a live setup checklist read from the node\'s signed <span class="mono">/fleet</span>. <span class="mono">npm run fleet</span> is the same document in a terminal; <span class="mono">npm run fleet -- relay</span> walks a title\'s path from the outside.')}
<h4>6. What settles, exactly</h4>
${t([
  ['commit', 'host\'s hot key, at placement', 'the match and its three drawn witnesses, under other operators'],
  ['settle', 'host, when the record lands', 'result hash, ledger sha256, build, participants, scores'],
  ['attest ×3', 'each witness, inside the window', 'the hash it reached itself; a different hash is a dispute'],
  ['finalize', 'anyone, after the window', 'two agree and none dissent → final; otherwise escalated'],
  ['escalate / resolve', 'anyone posts the ledger; nine drawn from the enrolled pool', 'stake-weighted majority; losers are slashed through NodeStake'],
  ['propose (hourly)', 'the settler', 'the hour\'s finalized set as a Merkle root on EpochAnchor'],
], ['call', 'who, when', 'what it carries'])}
${p('Ladders are a fold over these events in block order, so every node and the arcade derive the same tables from RPC alone. Elo stays off chain. Windows and slash sizes live in the contract and are read at start.')}
<h4>7. Said plainly</h4>
${ul([
  'Testnet contracts, unaudited. No fees, rewards or credits reconcile on chain yet; the per-match fee split is phase 3.',
  'The character registry is deployed and empty: every match hydrates external, zero-stat agents until one is forged.',
  'An attested title cannot become official by configuration; the path is on your side (seeded randomness, integer math, an input log).',
  'One-time secrets never pass through a flag or a file in the repo: keys are read from the shell, once.',
  `The full list of known gaps: ${a(doc('SPEC.md#4-known-gaps-and-honest-zeroes'), 'SPEC.md section 4')}.`,
])}
<h4>Where things are</h4>
${t([
  [a(doc('docs/SDK.md'), 'docs/SDK.md'), 'this page, in the repository'],
  [a(doc('docs/PUBLISHERS.md'), 'docs/PUBLISHERS.md'), 'the map: paths, vocabulary, the seven developer steps'],
  [a(doc('docs/HOST-YOUR-TITLE.md'), 'docs/HOST-YOUR-TITLE.md'), 'the title contract and the rules of recognition'],
  [a(doc('docs/BRING-YOUR-BACKEND.md'), 'docs/BRING-YOUR-BACKEND.md'), 'bridge, gauntlet loops, node discovery'],
  [a(doc('docs/BUILD-FROM-SCRATCH.md'), 'docs/BUILD-FROM-SCRATCH.md'), 'the client SDK and the shell protocol'],
  [a(doc('docs/HOST-A-NODE.md'), 'docs/HOST-A-NODE.md'), 'the node harness, stage by stage'],
  [a(doc('docs/PUBLISHER-BONDS.md'), 'docs/PUBLISHER-BONDS.md'), 'titles as tokens, host grants, escalation seats'],
  [a(doc('docs/UNIVERSAL-LOGIN.md'), 'docs/UNIVERSAL-LOGIN.md'), 'sign in with AIR, proxy wallets, one profile'],
  [a(doc('.claude/skills'), '.claude/skills'), 'host-a-node, migrate-a-title, build-a-title, host-a-title'],
])}
`;

export function renderBuild(el) {
  el.innerHTML = `
    <div class="page-h"><h2>Build on the mesh</h2><div class="dim">The developer docs. Two reads: the short one with pictures, and the SDK contract.</div></div>
    <div class="tabs doc-tabs" role="tablist">
      <button data-doc="dummies" class="on" role="tab">For dummies</button>
      <button data-doc="sdk" role="tab">SDK instructions</button>
    </div>
    <section class="panel doc" data-doc-body="dummies"><div class="panel-h"><h3>How everything works</h3><span class="more">five pictures</span></div><div class="panel-b doc-b">${dummies()}</div></section>
    <section class="panel doc" data-doc-body="sdk" hidden><div class="panel-h"><h3>SDK instructions</h3><span class="more">litnode ${esc(CABINET_VERSION)}</span></div><div class="panel-b doc-b">${sdk()}</div></section>`;
  for (const b of el.querySelectorAll('[data-doc]')) b.addEventListener('click', () => {
    for (const x of el.querySelectorAll('[data-doc]')) x.classList.toggle('on', x === b);
    for (const s of el.querySelectorAll('[data-doc-body]')) s.hidden = s.dataset.docBody !== b.dataset.doc;
    try { localStorage.setItem('cabinet.doc', b.dataset.doc); } catch { /* fine */ }
  });
  try { const want = localStorage.getItem('cabinet.doc'); if (want) el.querySelector(`[data-doc="${want}"]`)?.click(); } catch { /* fine */ }
}
