/** The LITNODE Control Plane download: one place for what the header's DOWNLOAD button, the Arcade
 *  page's banner and the #/download page say. The Control Plane is the Windows app (an MSI) that runs a
 *  litnode in the tray with its own runtime; it is built in the website repository, not here.
 *
 *  A new Control Plane build changes only CONTROL_PLANE below: version, the litnode it embeds, the
 *  download url, the installer's file name, SHA-256 (its release's SHA256SUMS.txt) and size. */
export const CONTROL_PLANE = {
  version: '0.1.12',
  litnode: '0.11.18',          // the node it installs; it then updates itself through signed, registered releases
  // A GitHub release that is NOT marked Latest (tag control-plane-v<version>): nodes take their updates from
  // the Latest release, so this one is invisible to them. `gh release create … --latest=false`.
  url: 'https://github.com/strodanodev/litnode/releases/download/control-plane-v0.1.12/LITNODE-Control-Setup-0.1.12-litnode-0.11.18.msi',
  release: 'https://github.com/strodanodev/litnode/releases/tag/control-plane-v0.1.12',
  host: 'GitHub',              // where `url` points, said on the button's caption
  file: 'LITNODE-Control-Setup-0.1.12-litnode-0.11.18.msi',
  sha256: 'A6ECB09A88BF645803C68489BC750F267A56ED7CED067360763A50ED9BF0A760',
  sizeMB: 167,
  platform: 'Windows 10/11 · x64',
};

const RELEASES = 'https://github.com/strodanodev/litnode/releases/latest';
const GUIDE = 'https://github.com/strodanodev/litnode/blob/master/docs/OPERATORS.md';
const GAS_FAUCET = 'https://liteforge.hub.caldera.xyz';

const DL_ICON = '<svg class="dl-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5v8.2m0 0L4.8 6.5M8 9.7l3.2-3.2M2.5 11.5v2.5h11v-2.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square"/></svg>';
export const downloadIcon = DL_ICON;

/** The Arcade page's strip: one line of why, and the DOWNLOAD NOW button (to #/download, which explains
 *  the SmartScreen warning and the checksum before anyone runs the installer). */
export function arcadeBanner() {
  const c = CONTROL_PLANE;
  return `<section class="dl-banner" aria-label="Download the LITNODE Control Plane">
    <div class="dl-banner-txt">
      <span class="dl-eyebrow">LITNODE Control Plane · ${c.platform}</span>
      <h2>Run a node. Host the matches you play.</h2>
      <p>One installer, no terminal: your node runs in the tray, verifies matches for the mesh and counts toward ranked play.</p>
    </div>
    <div class="dl-banner-cta">
      <a class="dl-cta" href="#/download">${DL_ICON}<span>DOWNLOAD NOW</span></a>
      <span class="dl-meta">v${c.version} · ${c.sizeMB} MB · free</span>
    </div>
  </section>`;
}

/** The #/download page. `panel` and `esc` are app.js's own helpers, so it renders like every other page. */
export function downloadPage({ panel, esc }) {
  const c = CONTROL_PLANE;
  const hero = `<div class="dl-hero">
      <div class="dl-hero-txt">
        <span class="dl-eyebrow">For node operators · ${esc(c.platform)}</span>
        <h2>LITNODE Control Plane <span class="dl-ver">v${esc(c.version)}</span></h2>
        <p>The Windows app for running a litnode: it installs the node with its own runtime, keeps it running in the system tray, and gives you the live mesh, a console and one-click restart and update. No terminal, no Node.js install.</p>
        <div class="dl-row">
          <a class="dl-cta big" href="${esc(c.url)}" download>${DL_ICON}<span>DOWNLOAD NOW</span></a>
          <span class="dl-meta">${esc(c.file)}<br>${c.sizeMB} MB · from ${esc(c.host)} (<a class="link" href="${esc(c.release)}" target="_blank" rel="noopener">release page</a>) · bundles litnode ${esc(c.litnode)}, updates itself</span>
        </div>
        <div class="dl-sha"><span class="dim">SHA-256</span> <code>${esc(c.sha256)}</code> <button class="link" data-copy-now="${esc(c.sha256)}">copy</button></div>
        <div class="dim dl-alt">macOS, Linux, or a folder you run yourself: the <a class="link" href="${RELEASES}" target="_blank" rel="noopener">release zips</a>. Step by step for every platform: <a class="link" href="${GUIDE}" target="_blank" rel="noopener">the operator guide</a>.</div>
      </div>
    </div>`;
  const install = `<ol class="steps">
      <li><b>Download</b> the installer and check it before you run it. In PowerShell, in the download folder: <code>Get-FileHash .\\${esc(c.file)}</code> must print the SHA-256 above.</li>
      <li><b>Run the .msi.</b> It installs for your Windows user only (no administrator needed) and needs about 1 GB free.</li>
      <li><b>SmartScreen</b> may say "Windows protected your PC" (unknown publisher): this build is not code-signed yet, so the checksum is the check. <b>More info → Run anyway</b>, once it matched.</li>
      <li><b>The first-run guide</b> asks for a name, the port (7801), your region and reachability. Choose <b>Quick Tunnel</b> to be publicly reachable: it downloads and verifies <code>cloudflared</code> for you. Leave the seed blank: the node finds the mesh on chain.</li>
      <li><b>Bond.</b> The guide opens your node's page at <code>http://127.0.0.1:7801/#/node</code>. Connect a fresh browser wallet on litVM LiteForge with a little zkLTC (<a class="link" href="${GAS_FAUCET}" target="_blank" rel="noopener">free faucet</a>), then in the Operator panel: faucet tLITVM, bond, delegate and fund the announcer, and top up the hot key.</li>
    </ol>`;
  const youGet = `<ul class="dl-list">
      <li><b>Your own node</b>, started at sign-in and kept running from the tray.</li>
      <li><b>Network</b>: the mesh as a live graph, gossip health and peer latency.</li>
      <li><b>Console</b>: the node's own output, with Restart, Reconnect and Apply update.</li>
      <li><b>Arcade</b>: every title on the mesh, playable, with who hosts it.</li>
      <li><b>Signed updates</b>: the node only applies releases signed by the litnode key and registered on chain.</li>
    </ul>`;
  const know = `<ul class="dl-list">
      <li>Everything runs on the litVM LiteForge <b>testnet</b>: tokens are free from faucets and have no value.</li>
      <li>Your node pays a little gas for the matches it hosts and witnesses, from its hot key.</li>
      <li>Ranked results go on chain once <b>four operators</b> (four wallets) are online, so every node counts.</li>
      <li>If <b>Restart</b> changes nothing: tray icon → <b>Quit</b>, then open the Control Plane again.</li>
      <li>Settings the app has no screen for go in Windows user variables (<code>setx NAME value</code>), not <code>node.env</code>: the app rewrites that file on every start.</li>
      <li>Stuck? The <a class="link" href="${GUIDE}#troubleshooting" target="_blank" rel="noopener">troubleshooting table</a>, or open an issue on <a class="link" href="https://github.com/strodanodev/litnode/issues" target="_blank" rel="noopener">GitHub</a>.</li>
    </ul>`;
  return `<div class="page-h"><h1 class="chrome">Download</h1><span class="dim">run a litnode on Windows — one installer, no terminal</span></div>
    <div class="home">
      ${panel('LITNODE Control Plane', hero, '', 's12 dl-hero-panel')}
      ${panel('Install in five steps', install, '', 's6')}
      ${panel('What you get', youGet, '', 's6')}
      ${panel('Good to know', know, `<a class="more" href="#/node">your node ›</a>`, 's12')}
    </div>`;
}
