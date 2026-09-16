/** Cabinet SDK, game side. Drop into any web game that runs inside the
 *  arcade launcher. Safe when there is no launcher (standalone tab): every
 *  call is a no-op and `inCabinet` is false.
 *
 *    import { connectCabinet } from './sdk-client.js';
 *    const cab = connectCabinet();
 *    cab.onInit((i) => console.log(i.player.id, i.node.url, i.node.online));
 *    cab.onInit((i) => { if (i.match) joinRelay(i.match.wsAddr, i.match.matchId, i.player.id); });
 *    cab.exit();   // back to the launcher
 *
 *  init = { type:'cabinet:init', version:1, player:{id, guest, name}, node:{url, online},
 *           game:{id, title}, match?:{matchId, host, witness, wsAddr, beacon, participants} }
 *  `match` is present only when the player queued through the cabinet and the
 *  cabinet verified the host against the placement rule (BUILD-SPEC §5). A
 *  title that receives it joins THAT relay under player.id, which is the key
 *  the node will settle the ledger against. */
export function connectCabinet() {
  const inCabinet = window.parent !== window;
  const listeners = new Set();
  let init = null;
  if (inCabinet) {
    window.addEventListener('message', (e) => {
      if (e.source === window.parent && e.data?.type === 'cabinet:init') { init = e.data; for (const l of listeners) l(init); }
    });
    window.parent.postMessage({ type: 'cabinet:hello' }, '*');
  }
  return {
    inCabinet,
    get init() { return init; },
    onInit(l) { listeners.add(l); if (init) l(init); },
    exit() { if (inCabinet) window.parent.postMessage({ type: 'cabinet:exit' }, '*'); },
  };
}
