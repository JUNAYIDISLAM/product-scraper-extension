/**
 * Builds the loadable extension into dist/.
 *
 *   npm run build          one-off build + validation
 *   npm run watch          rebuild JavaScript on change (static files copied once)
 *
 * Each entry point is bundled (with JSZip) into a single classic script,
 * because Chrome content scripts cannot be ES modules.
 */
import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printReport, validateDist } from './validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

const ENTRY_POINTS = [
  { in: 'src/background/service-worker.js', out: 'background' },
  { in: 'src/content/content.js', out: 'content' },
  { in: 'src/popup/popup.js', out: 'popup/popup' },
  { in: 'src/offscreen/offscreen.js', out: 'offscreen/offscreen' },
];

const STATIC_FILES = [
  ['manifest.json', 'manifest.json'],
  ['src/popup/popup.html', 'popup/popup.html'],
  ['src/popup/popup.css', 'popup/popup.css'],
  ['src/offscreen/offscreen.html', 'offscreen/offscreen.html'],
  ['icons', 'icons'],
  ['LICENSE', 'LICENSE'],
];

const esbuildOptions = {
  absWorkingDir: root,
  entryPoints: ENTRY_POINTS,
  outdir: dist,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome116'],
  minify: false,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'eof',
  logLevel: 'info',
};

async function copyStatic() {
  for (const [from, to] of STATIC_FILES) {
    const target = path.join(dist, to);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(root, from), target, { recursive: true });
  }
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

if (watch) {
  await copyStatic();
  const ctx = await context(esbuildOptions);
  await ctx.watch();
  console.log('Watching for changes. Reload the extension in chrome://extensions after each rebuild.');
} else {
  await build(esbuildOptions);
  await copyStatic();
  const report = await validateDist(dist);
  printReport(report);
  if (report.errors.length) process.exit(1);
  console.log(`\nBuild complete: ${dist}\nLoad this folder with "Load unpacked" in chrome://extensions.`);
}
