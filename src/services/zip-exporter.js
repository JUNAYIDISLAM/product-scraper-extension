/**
 * Builds the export ZIP:
 *
 *   products.csv
 *   export-report.json
 *   images/<platform>/<name-slug>-<product-id>/main.<ext>
 *
 * Every product gets its own folder, so image files can never collide, and
 * the CSV `image` column always holds the exact path written to the ZIP (or
 * '' when that product's image could not be downloaded).
 */
import JSZip from 'jszip';
import { productsToCsv } from './csv-exporter.js';
import { mapWithConcurrency } from './image-downloader.js';
import { CSV_COLUMNS } from './product-normalizer.js';
import { buildProductFolderName, makeUnique } from '../utils/filename.js';
import { ErrorCodes, ExporterError } from '../utils/errors.js';

export const CSV_FILENAME = 'products.csv';
export const REPORT_FILENAME = 'export-report.json';
export const IMAGE_ROOT = 'images';
export const DEFAULT_CONCURRENCY = 3;

/**
 * Assigns a unique folder to each product, in order.
 * @returns {{ product: object, folder: string }[]}
 */
export function planImageFolders(products) {
  const usedByPlatform = new Map();
  return products.map((product) => {
    if (!usedByPlatform.has(product.platform)) usedByPlatform.set(product.platform, new Set());
    const folderName = makeUnique(buildProductFolderName(product), usedByPlatform.get(product.platform));
    return { product, folder: `${IMAGE_ROOT}/${product.platform}/${folderName}` };
  });
}

export function imagePath(folder, ext) {
  return `${folder}/main.${ext}`;
}

function csvRow(product, imageUrl, image) {
  const row = {};
  for (const column of CSV_COLUMNS) row[column] = product[column] ?? '';
  row.image_url = imageUrl;
  row.image = image;
  return row;
}

/**
 * @param {object[]} products sanitised products (see sanitizeProductForExport)
 * @param {object} options
 * @param {(candidates: string[], platformId: string) => Promise<object>} options.downloadImage
 * @param {(progress: object) => void} [options.onProgress]
 * @param {'blob'|'uint8array'} [options.outputType]
 * @returns {Promise<{ data: Blob|Uint8Array, summary: object, csv: string, report: object }>}
 */
export async function buildExportZip(products, {
  downloadImage,
  onProgress = () => {},
  concurrency = DEFAULT_CONCURRENCY,
  outputType = 'blob',
  generatedAt = new Date(),
  source = null,
} = {}) {
  if (!Array.isArray(products) || products.length === 0) {
    throw new ExporterError(ErrorCodes.NO_PRODUCTS, 'There are no products to export.');
  }
  if (typeof downloadImage !== 'function') throw new TypeError('downloadImage must be a function');

  const plan = planImageFolders(products);
  const zip = new JSZip();
  const rows = new Array(plan.length);
  const failures = [];
  const progress = { phase: 'images', total: plan.length, completed: 0, succeeded: 0, failed: 0, percent: 0 };
  const emit = (extra = {}) => onProgress({ ...progress, ...extra });
  emit();

  await mapWithConcurrency(plan, concurrency, async ({ product, folder }, index) => {
    let result;
    try {
      result = await downloadImage(product.image_candidates || [], product.platform);
    } catch (error) {
      result = { ok: false, error: { code: error?.code || ErrorCodes.UNKNOWN, message: error?.message || String(error) } };
    }
    if (result?.ok) {
      const path = imagePath(folder, result.ext);
      zip.file(path, result.bytes, { binary: true, compression: 'STORE', date: generatedAt });
      rows[index] = csvRow(product, result.url, path);
      progress.succeeded += 1;
    } else {
      rows[index] = csvRow(product, product.image_url || '', '');
      failures.push({
        platform: product.platform,
        product_id: product.product_id,
        product_name: product.product_name,
        image_url: product.image_url || '',
        code: result?.error?.code || ErrorCodes.UNKNOWN,
        reason: result?.error?.message || 'Image download failed',
      });
      progress.failed += 1;
    }
    progress.completed += 1;
    progress.percent = Math.round((progress.completed / progress.total) * 90);
    emit({ lastProduct: product.product_name });
  });

  const csv = productsToCsv(rows);
  zip.file(CSV_FILENAME, csv, { compression: 'DEFLATE', date: generatedAt });

  const failureReasons = {};
  for (const failure of failures) failureReasons[failure.reason] = (failureReasons[failure.reason] || 0) + 1;
  const summary = {
    products: plan.length,
    imagesSaved: progress.succeeded,
    imagesFailed: progress.failed,
    failureReasons,
    platforms: [...new Set(products.map((p) => p.platform))],
  };
  const report = {
    tool: 'Multi-Platform Product Exporter',
    generatedAt: generatedAt.toISOString(),
    source,
    summary,
    imageFailures: failures,
    notes: [
      'The "image" column in products.csv is the path of the downloaded image inside this ZIP, or empty if the download failed.',
      'Prices are copied from the search results page at export time and may change.',
    ],
  };
  zip.file(REPORT_FILENAME, `${JSON.stringify(report, null, 2)}\n`, { compression: 'DEFLATE', date: generatedAt });

  emit({ phase: 'zipping', percent: 90 });
  let data;
  try {
    data = await zip.generateAsync(
      { type: outputType, compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/zip' },
      (meta) => emit({ phase: 'zipping', percent: 90 + Math.round(meta.percent / 10) }),
    );
  } catch (error) {
    throw new ExporterError(ErrorCodes.ZIP_FAILED, `Could not create the ZIP file: ${error?.message || error}`);
  }
  emit({ phase: 'zipped', percent: 100 });
  return { data, summary, csv, report };
}
