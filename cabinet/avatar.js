/** Identicons from a player's public key — a 5×5 mirrored pixel pattern in
 *  a hue derived from the key, so every player has a stable face without
 *  uploading anything. Also the photo-upload helper for the profile card. */
const cache = new Map();

export function identicon(id, size = 64) {
  const key = `${id}|${size}`;
  if (cache.has(key)) return cache.get(key);
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  const hue = h % 360;
  const bits = [];
  let x = h || 1;
  for (let i = 0; i < 15; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; bits.push((x >>> 0) % 3 !== 0); }
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = `hsl(${hue} 30% 14%)`;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = `hsl(${hue} 80% 62%)`;
  const cell = size / 6, off = cell / 2;
  for (let r = 0; r < 5; r++) for (let col = 0; col < 3; col++) {
    if (!bits[r * 3 + col]) continue;
    ctx.fillRect(off + col * cell, off + r * cell, cell, cell);
    ctx.fillRect(off + (4 - col) * cell, off + r * cell, cell, cell);
  }
  const url = c.toDataURL();
  cache.set(key, url);
  return url;
}

/** Resize an uploaded image to a square data URL small enough for localStorage. */
export function fileToAvatar(file, size = 160) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.86));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
