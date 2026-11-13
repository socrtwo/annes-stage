import { defineConfig, type Plugin } from 'vite';

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/** Files the service worker caches only when first used (large and optional), not at install. */
const LAZY = [/(^|\/)dictionary-[^/]*\.js$/, /\.map$/, /(^|\/)sw\.js$/, /third-party-notices\.txt$/];
/** Kinds of files precached at install: the app shell and everything it loads. */
const PRECACHE_EXT = /\.(js|mjs|css|woff2?|html|webmanifest|json|svg|png|ico|webp)$/i;

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

/**
 * Writes the build's file list and a build hash into dist/sw.js (copied from public/sw.js), so each
 * build gets its own cache with every asset precached. The dev server serves public/sw.js as is.
 */
function swPrecache(): Plugin {
  let outDir = 'dist';
  return {
    name: 'sw-precache',
    apply: 'build',
    configResolved(c) { outDir = c.build.outDir.startsWith('/') ? c.build.outDir : join(c.root, c.build.outDir); },
    closeBundle() {
      const swPath = join(outDir, 'sw.js');
      if (!existsSync(swPath)) return;
      const files = listFiles(outDir).map((p) => relative(outDir, p).split(sep).join('/')).sort();
      const pre = files.filter((f) => PRECACHE_EXT.test(f) && !LAZY.some((r) => r.test(f)));
      const hash = createHash('sha256');
      for (const f of files) { if (f !== 'sw.js') { hash.update(f); hash.update(readFileSync(join(outDir, f))); } }
      const build = `${pkg.version}-${hash.digest('hex').slice(0, 12)}`;
      const src = readFileSync(swPath, 'utf8');
      const BUILD_RE = /const BUILD = '__BUILD__';/;
      const PRE_RE = /const PRECACHE = \/\*__PRECACHE__\*\/\[\];/;
      if (!BUILD_RE.test(src) || !PRE_RE.test(src)) throw new Error('sw-precache: placeholders missing from public/sw.js');
      const out = src.replace(PRE_RE, () => `const PRECACHE = ${JSON.stringify(pre.map((f) => `./${f}`))};`).replace(BUILD_RE, () => `const BUILD = ${JSON.stringify(build)};`);
      writeFileSync(swPath, out);
      const bytes = pre.reduce((n, f) => n + statSync(join(outDir, f)).size, 0);
      this.info?.(`sw.js: ${pre.length} files precached (${(bytes / 1048576).toFixed(1)} MB), build ${build}`);
    },
  };
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  base: './',
  plugins: [swPrecache()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: 0,
  },
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts'],
  },
} as any);
