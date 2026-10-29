/**
 * Runs the adapter for a saved page and prints what the extension would detect.
 * Useful for checking an adapter against a real page without loading Chrome.
 *
 *   npm run try-adapter -- <saved-page.html> <original-page-url> [--limit 25] [--sponsored] [--json]
 *
 * Example:
 *   npm run try-adapter -- C:\Users\me\Desktop\amazon.html "https://www.amazon.com/s?k=headphones"
 *
 * Save the page from Chrome DevTools (Console): copy(document.documentElement.outerHTML)
 * and paste into a .html file. That captures the rendered DOM, including
 * lazy-loaded cards, which "Save page as… HTML only" does not.
 */
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { scanDocument } from '../src/content/scan.js';

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] === '--limit'));
const [file, pageUrl] = positional;
if (!file || !pageUrl) {
  console.error('Usage: npm run try-adapter -- <saved-page.html> <original-page-url> [--limit 25] [--sponsored] [--json]');
  process.exit(2);
}
const limitIndex = args.indexOf('--limit');
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 100;

const html = await readFile(file, 'utf8');
const { window } = new JSDOM(html, { url: pageUrl });
const result = scanDocument(window.document, pageUrl, { limit, includeSponsored: args.includes('--sponsored') });

if (args.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
if (!result.ok) {
  console.error(`Scan failed (${result.error.code}): ${result.error.message}`);
  process.exit(1);
}

console.log(`Platform: ${result.platform.name}   Page type: ${result.pageType}`);
console.log(`Cards found: ${result.cardsFound}   Products detected: ${result.detectedCount}   Showing: ${result.products.length}`);
for (const warning of result.warnings) console.log(`Warning: ${warning}`);
console.table(
  result.products.map((p) => ({
    id: p.product_id,
    name: p.product_name.length > 50 ? `${p.product_name.slice(0, 49)}…` : p.product_name,
    price: p.price ? `${p.price} ${p.currency}` : '',
    image: p.image_url ? new URL(p.image_url).pathname.split('/').pop().slice(0, 40) : '(none)',
    sponsored: p.sponsored ? 'yes' : '',
  })),
);
if (Object.keys(result.skippedSummary).length) {
  console.log('Skipped:');
  for (const [reason, count] of Object.entries(result.skippedSummary)) console.log(`  ${count} x ${reason}`);
}
