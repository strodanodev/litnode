/** Observed node uptime. The dashboard samples the node every poll and
 *  keeps a week of 10-minute slots in localStorage, per node URL:
 *    { [slot]: [okSamples, totalSamples] }
 *  A slot with no samples means the dashboard was closed — it is shown as
 *  "unobserved", never as downtime. Process uptime (`uptimeMs` on /health)
 *  is the node's own word and is shown alongside. */
export const SLOT_MS = 10 * 60 * 1000;
const KEEP = 7 * 24 * 6; // a week of slots

const key = (url) => `cabinet.uptime.${url}`;

export function loadHistory(url) {
  try { return JSON.parse(localStorage.getItem(key(url))) ?? {}; } catch { return {}; }
}

/** Record one sample and persist. Returns the history. */
export function sample(url, online, now = Date.now()) {
  const h = loadHistory(url);
  const slot = Math.floor(now / SLOT_MS);
  const cur = h[slot] ?? [0, 0];
  h[slot] = [cur[0] + (online ? 1 : 0), cur[1] + 1];
  for (const k of Object.keys(h)) if (Number(k) < slot - KEEP) delete h[k];
  try { localStorage.setItem(key(url), JSON.stringify(h)); } catch { /* full or private */ }
  return h;
}

/** Slots for the last `n` slots ending now, oldest first: { slot, ok, total, state } */
export function slots(h, n, now = Date.now()) {
  const last = Math.floor(now / SLOT_MS);
  const out = [];
  for (let s = last - n + 1; s <= last; s++) {
    const [ok, total] = h[s] ?? [0, 0];
    out.push({ slot: s, ok, total, state: total === 0 ? 'none' : ok === total ? 'up' : ok === 0 ? 'down' : 'partial' });
  }
  return out;
}

/** Uptime % over the last `n` slots, counting only observed samples. */
export function uptimePct(h, n, now = Date.now()) {
  let ok = 0, total = 0;
  for (const s of slots(h, n, now)) { ok += s.ok; total += s.total; }
  return { pct: total ? (ok / total) * 100 : null, observedSlots: slots(h, n, now).filter((s) => s.total).length, ok, total };
}

/** Hours observed online (for reward projection): each observed slot
 *  contributes its online fraction of 10 minutes. */
export function hoursOnline(h, n, now = Date.now()) {
  let ms = 0;
  for (const s of slots(h, n, now)) if (s.total) ms += (s.ok / s.total) * SLOT_MS;
  return ms / 3_600_000;
}

export const fmtDuration = (ms) => {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${hh}h` : hh ? `${hh}h ${mm}m` : `${mm}m`;
};

/** SVG ring showing a percentage (0–100) or an empty ring for null. */
export function ring(pct, { size = 118, stroke = 9, color = '#8ce8ff', label = '', sub = '' } = {}) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const v = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  return `<svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(170,215,255,.14)" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="butt"
      stroke-dasharray="${((v / 100) * c).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})" style="filter:drop-shadow(0 0 6px ${color})"/>
    <text x="50%" y="50%" dy="-2" text-anchor="middle" class="ring-v">${pct == null ? '—' : `${pct.toFixed(pct >= 99.95 ? 0 : 1)}%`}</text>
    <text x="50%" y="50%" dy="16" text-anchor="middle" class="ring-l">${label}</text>
    ${sub ? `<text x="50%" y="50%" dy="28" text-anchor="middle" class="ring-s">${sub}</text>` : ''}
  </svg>`;
}

/** Status strip: one cell per slot. */
export function strip(slotList) {
  return `<div class="strip" title="last ${slotList.length} × 10 min">${slotList.map((s) => `<i class="${s.state}" title="${new Date(s.slot * SLOT_MS).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${s.total ? `${s.ok}/${s.total} up` : 'not observed'}"></i>`).join('')}</div>`;
}

/** 7 × 24 heatmap: rows = days (oldest first), cells = hours. */
export function heatmap(h, now = Date.now()) {
  const hourMs = 3_600_000;
  const lastHour = Math.floor(now / hourMs);
  const rows = [];
  for (let d = 6; d >= 0; d--) {
    const cells = [];
    for (let i = 23; i >= 0; i--) {
      const hour = lastHour - d * 24 - i;
      let ok = 0, total = 0;
      for (let k = 0; k < 6; k++) { const [a, b] = h[hour * 6 + k] ?? [0, 0]; ok += a; total += b; }
      const state = total === 0 ? 'none' : ok === total ? 'up' : ok === 0 ? 'down' : 'partial';
      cells.push(`<i class="${state}" title="${new Date(hour * hourMs).toLocaleString([], { weekday: 'short', hour: '2-digit' })} · ${total ? `${Math.round((ok / total) * 100)}% up` : 'not observed'}"></i>`);
    }
    rows.push(`<div class="hm-row"><span class="hm-day">${new Date((lastHour - d * 24) * hourMs).toLocaleDateString([], { weekday: 'short' })}</span>${cells.join('')}</div>`);
  }
  return `<div class="heatmap">${rows.join('')}</div>`;
}
