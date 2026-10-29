/**
 * Validates the built extension in dist/ (run automatically by `npm run build`,
 * or on its own with `npm run validate`).
 *
 * Checks: manifest structure and permissions, that every referenced file
 * exists, icons are real PNGs, HTML pages load only local scripts (MV3 CSP),
 * and every JavaScript file parses.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const EXPECTED_PERMISSIONS = new Set(['activeTab', 'scripting', 'downloads', 'offscreen', 'storage']);
const REQUIRED_FILES = ['manifest.json', 'background.js', 'content.js', 'popup/popup.html', 'popup/popup.js', 'popup/popup.css', 'offscreen/offscreen.html', 'offscreen/offscreen.js'];

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
}

async function checkHtml(dist, relative, errors) {
  const file = path.join(dist, relative);
  const html = await readFile(file, 'utf8');
  const dir = path.dirname(file);
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = match[1].match(/\bsrc\s*=\s*"([^"]+)"/i)?.[1];
    if (!src) {
      if (match[2].trim()) errors.push(`${relative}: inline <script> is blocked by the MV3 content security policy`);
      continue;
    }
    if (/^(https?:)?\/\//i.test(src)) errors.push(`${relative}: remote script "${src}" is not allowed in MV3`);
    else if (!(await exists(path.join(dir, src)))) errors.push(`${relative}: script "${src}" not found`);
  }
  for (const match of html.matchAll(/<(?:link|img)\b[^>]*\b(?:href|src)\s*=\s*"([^"]+)"/gi)) {
    const ref = match[1];
    if (/^(https?:)?\/\//i.test(ref)) errors.push(`${relative}: remote resource "${ref}"`);
    else if (!(await exists(path.join(dir, ref)))) errors.push(`${relative}: resource "${ref}" not found`);
  }
}

export async function validateDist(dist) {
  const errors = [];
  const warnings = [];

  if (!(await exists(dist))) return { errors: [`${dist} does not exist. Run "npm run build" first.`], warnings };
  for (const file of REQUIRED_FILES) {
    if (!(await exists(path.join(dist, file)))) errors.push(`Missing ${file}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
  } catch (error) {
    errors.push(`manifest.json is not valid JSON: ${error.message}`);
    return { errors, warnings };
  }

  if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
  if (!manifest.name) errors.push('manifest.name is required');
  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version || '')) errors.push('manifest.version must be 1-4 dot-separated integers');
  if (!manifest.background?.service_worker) errors.push('background.service_worker is required');
  else if (!(await exists(path.join(dist, manifest.background.service_worker)))) errors.push(`service worker ${manifest.background.service_worker} not found`);
  if (!manifest.action?.default_popup) errors.push('action.default_popup is required');
  else if (!(await exists(path.join(dist, manifest.action.default_popup)))) errors.push(`popup ${manifest.action.default_popup} not found`);

  for (const permission of manifest.permissions || []) {
    if (!EXPECTED_PERMISSIONS.has(permission)) errors.push(`Unexpected permission "${permission}" (update scripts/validate.mjs if intended)`);
  }
  for (const permission of EXPECTED_PERMISSIONS) {
    if (!(manifest.permissions || []).includes(permission)) errors.push(`Missing permission "${permission}"`);
  }
  if (manifest.host_permissions?.length) warnings.push('host_permissions are granted at install time; image hosts should stay in optional_host_permissions');
  if (manifest.content_scripts?.length) warnings.push('content_scripts run on every matching page; this extension injects on demand instead');
  for (const pattern of manifest.optional_host_permissions || []) {
    if (!/^https:\/\/[a-z0-9.-]+\/\*$/.test(pattern)) errors.push(`optional host permission "${pattern}" should be an exact https://host/* pattern`);
  }

  const icons = { ...(manifest.icons || {}), ...(manifest.action?.default_icon || {}) };
  for (const [size, file] of Object.entries(icons)) {
    const full = path.join(dist, file);
    if (!(await exists(full))) {
      errors.push(`icon ${size}: ${file} not found`);
      continue;
    }
    const bytes = await readFile(full);
    if (bytes.readUInt32BE(0) !== 0x89504e47) errors.push(`icon ${file} is not a PNG`);
    else if (bytes.readUInt32BE(16) !== Number(size) || bytes.readUInt32BE(20) !== Number(size)) {
      errors.push(`icon ${file} is ${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}, expected ${size}x${size}`);
    }
  }

  for (const page of ['popup/popup.html', 'offscreen/offscreen.html']) {
    if (await exists(path.join(dist, page))) await checkHtml(dist, page, errors);
  }

  for (const file of (await listFiles(dist)).filter((f) => f.endsWith('.js'))) {
    const code = await readFile(file, 'utf8');
    try {
      // Compiles without running, which is enough to catch syntax errors.
      new vm.Script(code, { filename: path.relative(dist, file) });
    } catch (error) {
      errors.push(`${path.relative(dist, file)}: ${error.message}`);
    }
    // JSZip's bundled setImmediate polyfill has a `new Function` fallback for string
    // handlers; JSZip only passes functions, so that branch never runs. Ignore it.
    const withoutKnownPolyfill = code.replace(/"function"\s*!=\s*typeof (\w+)\s*&&\s*\(\1\s*=\s*new Function\(""\s*\+\s*\1\)\)/g, '');
    if (/\beval\s*\(|new Function\s*\(/.test(withoutKnownPolyfill)) {
      warnings.push(`${path.relative(dist, file)} contains eval/new Function (blocked by MV3 CSP at runtime)`);
    }
  }

  return { errors, warnings, manifest };
}

export function printReport({ errors, warnings }) {
  for (const warning of warnings) console.warn(`  warning: ${warning}`);
  for (const error of errors) console.error(`  ERROR: ${error}`);
  console.log(errors.length ? `Validation failed with ${errors.length} error(s).` : `Validation passed${warnings.length ? ` with ${warnings.length} warning(s)` : ''}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const report = await validateDist(path.join(root, 'dist'));
  printReport(report);
  process.exit(report.errors.length ? 1 : 0);
}
