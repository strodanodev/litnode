/** Generate a litnode identity file: { publicKey, privateKey } as hex.
 *    node tools/keygen.mjs [outPath]      default: ./identity.json
 *  Used for the Pickle Brawl court's COURT_IDENTITY, or any attesting host. */
import { existsSync, writeFileSync } from 'node:fs';
import { generateKeypair } from '../protocol/keys.js';

const out = process.argv[2] ?? 'identity.json';
if (existsSync(out)) { console.error(`${out} exists; not overwriting`); process.exit(1); }
const kp = await generateKeypair();
writeFileSync(out, JSON.stringify(kp, null, 2) + '\n');
console.log(`wrote ${out}\npublicKey (the attestor id): ${kp.publicKey}`);
