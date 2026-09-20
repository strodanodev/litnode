/** Backdrop: a black CRT screen — flickering static, a drifting scan band,
 *  and a cyan wireframe mesh whose vertices drift in slow orbits. Redrawn
 *  every frame on a fixed canvas. */
export function paintBackdrop(canvas) {
  const ctx = canvas.getContext('2d');

  // small offscreen buffer for TV static, stretched over the frame each tick
  const noise = document.createElement('canvas');
  noise.width = 160; noise.height = 90;
  const nctx = noise.getContext('2d');
  const nimg = nctx.createImageData(noise.width, noise.height);

  let w = 0, h = 0, dpr = 1;
  let pts = [], edges = [];

  const seedRnd = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

  function layout() {
    dpr = Math.min(devicePixelRatio || 1, 1.5);
    w = innerWidth; h = innerHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const rnd = seedRnd(11);
    const n = Math.min(70, Math.round((w * h) / 40000));
    pts = [];
    for (let i = 0; i < n; i++) {
      pts.push({ bx: rnd() * w, by: rnd() * h, x: 0, y: 0, amp: 10 + rnd() * 20, phase: rnd() * Math.PI * 2, speed: 0.15 + rnd() * 0.3 });
    }
    edges = [];
    for (let i = 0; i < pts.length; i++) {
      const near = pts
        .map((q, j) => ({ j, d: (q.bx - pts[i].bx) ** 2 + (q.by - pts[i].by) ** 2 }))
        .filter((e) => e.j !== i)
        .sort((a, b) => a.d - b.d)
        .slice(0, 2);
      for (const { j } of near) if (j > i) edges.push([i, j]);
    }
  }

  function drawStatic(alpha) {
    const data = nimg.data;
    for (let i = 0; i < data.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
    }
    nctx.putImageData(nimg, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = alpha;
    ctx.drawImage(noise, 0, 0, w, h);
    ctx.globalAlpha = 1;
  }

  function frame(t) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    drawStatic(0.05 + Math.random() * 0.035);

    const secs = t / 1000;
    for (const p of pts) {
      p.x = p.bx + Math.sin(secs * p.speed + p.phase) * p.amp;
      p.y = p.by + Math.cos(secs * p.speed * 0.8 + p.phase) * p.amp * 0.6;
    }

    ctx.lineWidth = 1.6;
    ctx.strokeStyle = 'rgba(150,235,255,.7)';
    ctx.shadowColor = 'rgba(140,232,255,.85)'; ctx.shadowBlur = 12;
    ctx.beginPath();
    for (const [i, j] of edges) { ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y); }
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = 'rgba(210,248,255,.85)';
    for (const p of pts) ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);

    // a faint scan band drifting down the screen, CRT-refresh style
    const bandY = ((secs * 90) % (h + 60)) - 30;
    const band = ctx.createLinearGradient(0, bandY - 30, 0, bandY + 30);
    band.addColorStop(0, 'rgba(160,240,255,0)');
    band.addColorStop(0.5, 'rgba(160,240,255,.06)');
    band.addColorStop(1, 'rgba(160,240,255,0)');
    ctx.fillStyle = band; ctx.fillRect(0, 0, w, h);

    // vignette toward the edges, like a tube's curvature
    const vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.4, w / 2, h / 2, Math.max(w, h) * 0.8);
    vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.32)');
    ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h);

    requestAnimationFrame(frame);
  }

  layout();
  requestAnimationFrame(frame);

  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(layout, 150); });
}
