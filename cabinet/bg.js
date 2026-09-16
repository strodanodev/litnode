/** Backdrop: a painted-sky gradient with soft clouds under a cyan wireframe
 *  mesh, drawn once to a fixed canvas. Drop the brand art in as `bg.jpg`
 *  next to index.html and it is used instead of the procedural sky — the
 *  wireframe still goes on top. */
export function paintBackdrop(canvas) {
  const draw = (img) => {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    const w = innerWidth, h = innerHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    if (img) {
      const s = Math.max(w / img.width, h / img.height);
      ctx.drawImage(img, (w - img.width * s) / 2, (h - img.height * s) / 2, img.width * s, img.height * s);
    } else {
      const sky = ctx.createLinearGradient(0, 0, w * 0.3, h);
      sky.addColorStop(0, '#3d8ea8'); sky.addColorStop(0.4, '#6db8cf'); sky.addColorStop(0.68, '#e8ab8c'); sky.addColorStop(1, '#3d5f7e');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
      let seed = 7;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
      for (let i = 0; i < 34; i++) {
        const cx = rnd() * w, cy = rnd() * h * 0.85, r = 120 + rnd() * 260;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        const peach = rnd() > 0.45;
        g.addColorStop(0, peach ? 'rgba(255,200,165,.75)' : 'rgba(235,248,255,.6)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      }
    }

    // wireframe: scattered vertices joined to their nearest neighbours
    let seed = 11;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const pts = [];
    const n = Math.round((w * h) / 26000);
    for (let i = 0; i < n; i++) pts.push({ x: rnd() * w, y: rnd() * h });
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(160,240,255,.55)';
    ctx.shadowColor = 'rgba(140,232,255,.6)'; ctx.shadowBlur = 4;
    ctx.beginPath();
    for (const p of pts) {
      const near = pts.filter((q) => q !== p).map((q) => ({ q, d: (q.x - p.x) ** 2 + (q.y - p.y) ** 2 })).sort((a, b) => a.d - b.d).slice(0, 3);
      for (const { q } of near) { ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(200,245,255,.5)';
    for (const p of pts) ctx.fillRect(p.x - 1, p.y - 1, 2, 2);

    // readability: darken, and fade toward the bottom
    ctx.fillStyle = 'rgba(6,10,18,.12)'; ctx.fillRect(0, 0, w, h);
    const fade = ctx.createLinearGradient(0, h * 0.55, 0, h);
    fade.addColorStop(0, 'rgba(6,10,18,0)'); fade.addColorStop(1, 'rgba(6,10,18,.42)');
    ctx.fillStyle = fade; ctx.fillRect(0, 0, w, h);
  };

  const img = new Image();
  img.onload = () => draw(img);
  img.onerror = () => draw(null);
  img.src = './bg.jpg';
  let t = 0;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => draw(img.complete && img.naturalWidth ? img : null), 150); });
}
