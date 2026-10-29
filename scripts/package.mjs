/**
 * Creates two ZIP files in release/:
 *   multi-platform-product-exporter-v<version>-extension.zip  the built dist/ folder
 *   multi-platform-product-exporter-v<version>-source.zip     the source project
 *                                                             (without node_modules, dist, release)
 * Run with `npm run package` (which builds first).
 */
import JSZip from 'jszip';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version, name } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const EXCLUDED = new Set(['node_modules', 'dist', 'release', '.git', '.e2e']);

async function addDirectory(zip, dir, prefix, exclude = new Set()) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (exclude.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const zipPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await addDirectory(zip, full, zipPath, exclude);
    else zip.file(zipPath, await readFile(full));
  }
}

async function writeZip(zip, file) {
  const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  await writeFile(file, data);
  console.log(`Created ${path.relative(root, file)} (${(data.length / 1024).toFixed(1)} KB)`);
}

await mkdir(path.join(root, 'release'), { recursive: true });

const extensionZip = new JSZip();
await addDirectory(extensionZip, path.join(root, 'dist'), '');
await writeZip(extensionZip, path.join(root, 'release', `${name}-v${version}-extension.zip`));

const sourceZip = new JSZip();
await addDirectory(sourceZip, root, name, EXCLUDED);
await writeZip(sourceZip, path.join(root, 'release', `${name}-v${version}-source.zip`));
