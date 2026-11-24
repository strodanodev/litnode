/** State files written whole or not at all.
 *
 *  `writeFileSync` truncates the target and then writes: a crash, a power cut or a full disk in between leaves a file
 *  that is empty or half a JSON document, and the reader that parses every file in a folder at start then throws
 *  before the node listens (audit of 10 Nov 2026: one torn delta stopped the node booting). So: write a sibling temp
 *  file, flush it, and rename it over the target. A rename within one directory replaces the old file in one step on
 *  NTFS and on POSIX filesystems; a reader sees the old bytes or the new ones.
 *
 *  A failed write removes its temp file and throws: the caller decides whether that is fatal. Zero dependencies. */
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';

let seq = 0;
export function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${++seq}.tmp`;
  let fd = null;
  try {
    fd = openSync(tmp, 'w');
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    try { fsyncSync(fd); } catch { /* a filesystem that cannot flush (some network mounts): the rename still stands */ }
    closeSync(fd); fd = null;
    renameSync(tmp, file);
  } catch (e) {
    if (fd != null) { try { closeSync(fd); } catch { /* already closed */ } }
    try { unlinkSync(tmp); } catch { /* never created */ }
    throw e;
  }
}

/** Parse a JSON state file. Unreadable or torn → `fallback`, with the damaged file moved aside as
 *  `<file>.corrupt-<time>` so nothing is silently lost and the next start does not trip on it again.
 *  `onCorrupt(file, error, movedTo)` reports it. */
export function readJsonOr(file, fallback, onCorrupt = () => {}) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return fallback; }
  try { return JSON.parse(text); }
  catch (e) {
    let moved = null;
    try { moved = `${file}.corrupt-${Date.now()}`; renameSync(file, moved); } catch { moved = null; }
    onCorrupt(file, e, moved);
    return fallback;
  }
}
