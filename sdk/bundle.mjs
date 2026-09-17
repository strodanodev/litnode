/** Inline a title and everything it imports into the one-file artifact the
 *  mesh pins by hash. esbuild does the work (devDependency); no minify, so
 *  the bytes that settle are the bytes you can read. Returns the source. */
export async function bundleTitle(entry) {
  let esbuild;
  try { esbuild = await import('esbuild'); } catch { throw new Error('esbuild is not installed — run `npm install` in litnode'); }
  const r = await esbuild.build({
    entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
    write: false, minify: false, treeShaking: true, legalComments: 'none', logLevel: 'silent',
  });
  return r.outputFiles[0].text.replace(/\/\/# sourceMappingURL=.*$/m, '');
}

/** Does this source still need bundling (static or dynamic imports)? */
export const needsBundle = (source) => /^\s*import\s[\s\S]*?from\s*['"]/m.test(source) || /\bimport\s*\(/.test(source);
