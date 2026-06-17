const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/**
 * pdfToImages — convert PDF pages to PNG images for AI-first vision extraction.
 *
 * Design:
 *  - Uses `pdf-to-img` (pure JS via pdfjs + node-canvas prebuilt binaries, no
 *    system ghostscript/imagemagick). It is an ESM-only package, so it is loaded
 *    lazily with a dynamic import() from this CommonJS module.
 *  - Every page becomes a temporary PNG under a per-conversion temp directory so
 *    the originals can be cleaned up after the AI has read them.
 *  - `isPdfImageConversionAvailable()` lets callers degrade gracefully (fall back
 *    to sending the whole PDF as a file) when the library/native canvas is missing.
 */

const PAGE_IMAGE_DIR = path.join(os.tmpdir(), 'sefa-statement-imports', 'pages');

// Render scale (pdfjs units → pixels). ~1.5 keeps statement text legible while
// keeping the image payload (and therefore vision latency/tokens) reasonable.
const DEFAULT_SCALE = 1.5;
const DEFAULT_MAX_PAGES = 40;
const DEFAULT_BATCH_SIZE = 2; // 1–3 pages per AI call

let cachedPdfFn; // memoized dynamic import of pdf-to-img's `pdf` function

const ensurePageDir = () => {
  fs.mkdirSync(PAGE_IMAGE_DIR, { recursive: true });
  return PAGE_IMAGE_DIR;
};

/**
 * Lazily resolve the ESM `pdf` function. Returns null if the package or its
 * native canvas dependency cannot be loaded in this environment.
 */
const loadPdfFn = async () => {
  if (cachedPdfFn !== undefined) return cachedPdfFn;
  try {
    const mod = await import('pdf-to-img');
    cachedPdfFn = mod.pdf || mod.default || null;
  } catch (_error) {
    cachedPdfFn = null;
  }
  return cachedPdfFn;
};

/**
 * Whether PDF→image conversion is usable here. Cheap probe that also loads the
 * native canvas binding once.
 */
const isPdfImageConversionAvailable = async () => {
  const pdfFn = await loadPdfFn();
  return typeof pdfFn === 'function';
};

class PdfTooLargeError extends Error {
  constructor(pageCount, maxPages) {
    super(`This statement has ${pageCount} pages. SEFA can read up to ${maxPages} pages at a time.`);
    this.name = 'PdfTooLargeError';
    this.code = 'PDF_TOO_LARGE';
    this.pageCount = pageCount;
    this.maxPages = maxPages;
  }
}

/**
 * Convert a PDF file into per-page PNG images written to a temp directory.
 *
 * @param {string} filePath - path to the source PDF
 * @param {Object} [options]
 * @param {number} [options.scale=DEFAULT_SCALE]
 * @param {number} [options.maxPages=DEFAULT_MAX_PAGES] - throws PdfTooLargeError above this
 * @param {(info: {pageNumber:number,totalPages:number,imagePath:string}) => void} [options.onPage]
 * @returns {Promise<{ pageCount:number, pages: Array<{pageNumber:number,imagePath:string,mimeType:string,byteSize:number}> }>}
 */
const convertPdfToPageImages = async (filePath, options = {}) => {
  const scale = Number(options.scale) > 0 ? Number(options.scale) : DEFAULT_SCALE;
  const maxPages = Number(options.maxPages) > 0 ? Number(options.maxPages) : DEFAULT_MAX_PAGES;

  const pdfFn = await loadPdfFn();
  if (typeof pdfFn !== 'function') {
    throw new Error('PDF to image conversion is not available in this environment.');
  }

  const document = await pdfFn(filePath, { scale });
  const totalPages = Number(document.length) || 0;

  if (totalPages === 0) {
    return { pageCount: 0, pages: [] };
  }
  if (totalPages > maxPages) {
    throw new PdfTooLargeError(totalPages, maxPages);
  }

  const dir = ensurePageDir();
  const batchId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const pages = [];

  let pageNumber = 0;
  for await (const pageBuffer of document) {
    pageNumber += 1;
    const imagePath = path.join(dir, `${batchId}-p${pageNumber}.png`);
    await fs.promises.writeFile(imagePath, pageBuffer);
    const entry = {
      pageNumber,
      imagePath,
      mimeType: 'image/png',
      byteSize: pageBuffer.length,
    };
    pages.push(entry);
    if (typeof options.onPage === 'function') {
      options.onPage({ pageNumber, totalPages, imagePath });
    }
  }

  return { pageCount: pages.length, pages };
};

/**
 * Group page entries into small batches (1–3 pages per AI call by default).
 */
const chunkPages = (pages = [], batchSize = DEFAULT_BATCH_SIZE) => {
  const size = Math.min(Math.max(Number(batchSize) || DEFAULT_BATCH_SIZE, 1), 3);
  const batches = [];
  for (let i = 0; i < pages.length; i += size) {
    batches.push(pages.slice(i, i + size));
  }
  return batches;
};

/**
 * Read a page image as a base64 data URL for multimodal model input.
 */
const readPageAsDataUrl = async (page) => {
  const buffer = await fs.promises.readFile(page.imagePath);
  return `data:${page.mimeType || 'image/png'};base64,${buffer.toString('base64')}`;
};

/**
 * Best-effort cleanup of generated page images. Never throws.
 */
const cleanupPageImages = async (pages = []) => {
  await Promise.all(
    (pages || []).map((page) =>
      fs.promises.unlink(page.imagePath).catch(() => undefined)
    )
  );
};

module.exports = {
  PAGE_IMAGE_DIR,
  PdfTooLargeError,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_PAGES,
  isPdfImageConversionAvailable,
  convertPdfToPageImages,
  chunkPages,
  readPageAsDataUrl,
  cleanupPageImages,
};
