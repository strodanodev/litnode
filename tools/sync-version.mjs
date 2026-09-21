#!/usr/bin/env node
/** Keep cabinet/version.js equal to package.json — run by `npm version` (the "version" lifecycle script), so a
 *  bump can never leave the arcade's copy saying yesterday's release. demo/cabinet.test.mjs asserts equality. */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const file = join(root, 'cabinet', 'version.js');
const was = readFileSync(file, 'utf8');
const now = was.replace(/CABINET_VERSION = '[^']*'/, `CABINET_VERSION = '${version}'`);
if (now !== was) { writeFileSync(file, now); console.log(`cabinet/version.js → ${version}`); }
else console.log(`cabinet/version.js already ${version}`);
if (process.argv.includes('--stage')) execFileSync('git', ['add', file], { cwd: root, stdio: 'inherit' });
