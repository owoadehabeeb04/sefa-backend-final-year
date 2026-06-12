const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');

const multer = require('multer');
const pdfParse = require('pdf-parse');

const { errorResponse } = require('../utils/response');
const { scoreStatementTextQuality } = require('./statementQuality.service');
const { cleanCell } = require('./statementStructure.service');

const execFileAsync = promisify(execFile);
const TEMP_DIR = path.join(os.tmpdir(), 'sefa-statement-imports');
const OCR_OUTPUT_DIR = path.join(TEMP_DIR, 'ocr');
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set(['.pdf']);
const SUPPORTED_MIME_TYPES = new Set(['application/pdf']);

fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(OCR_OUTPUT_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, TEMP_DIR),
  filename: (_req, file, callback) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    callback(null, `${Date.now()}-${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
  },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(String(file.originalname || '')).toLowerCase();
    const isSupported =
      SUPPORTED_MIME_TYPES.has(file.mimetype)
      || SUPPORTED_EXTENSIONS.has(extension);

    if (!isSupported) {
      return callback(new Error('Only PDF bank statements are supported right now.'));
    }

    return callback(null, true);
  },
});

const statementUploadMiddleware = (req, res, next) => {
  upload.single('file')(req, res, (error) => {
    if (!error) {
      return next();
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return errorResponse(res, 'Statement file must be 10 MB or smaller.', 400);
    }

    return errorResponse(
      res,
      error.message || 'We could not upload this statement. Please try again.',
      400,
    );
  });
};

const safeUnlink = async (targetPath) => {
  if (!targetPath) return;
  await fs.promises.unlink(targetPath).catch(() => undefined);
};

const performPdfParse = async (filePath) => {
  const buffer = await fs.promises.readFile(filePath);
  const parsed = await pdfParse(buffer);
  return {
    text: String(parsed.text || '').trim(),
    metadata: {
      info: parsed.info || {},
      numPages: parsed.numpages || 0,
    },
  };
};

const parseCsvLine = (line = '', delimiter = ',') => {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const nextChar = line[index + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === delimiter && !inQuotes) {
      values.push(cleanCell(current));
      current = '';
      continue;
    }

    current += char;
  }

  values.push(cleanCell(current));
  return values;
};

const detectCsvDelimiter = (text = '') => {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5);

  const delimiters = [',', ';', '\t'];
  let best = { delimiter: ',', score: 0 };

  delimiters.forEach((delimiter) => {
    const score = lines.reduce((total, line) => total + (line.split(delimiter).length > 1 ? 1 : 0), 0);
    if (score > best.score) {
      best = { delimiter, score };
    }
  });

  return best.delimiter;
};

const buildUnreadableStatementMessage = (fileKind, suggestions = []) => {
  const introByKind = {
    pdf: 'We could not find enough readable transaction details in this PDF statement.',
    image: 'We could not find enough readable transaction details in this statement image.',
    xlsx: 'We could not find enough usable transaction rows in this Excel statement.',
  };

  const intro = introByKind[fileKind] || 'We could not read enough transaction details from this statement.';
  const extra = suggestions.filter(Boolean).join(' ');
  return `${intro} ${extra}`.trim();
};

const extractExcelContent = async (filePath) => {
  let XLSX;
  try {
    XLSX = require('xlsx');
  } catch (_error) {
    throw new Error('Excel statement support requires the xlsx dependency to be installed.');
  }

  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const firstSheetName = workbook.SheetNames?.[0];
  if (!firstSheetName) {
    throw new Error('We could not read any worksheet from this Excel statement.');
  }

  const worksheet = workbook.Sheets[firstSheetName];
  const tableRows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    raw: false,
    defval: '',
  }).map((row) => Array.isArray(row) ? row.map(cleanCell) : []);

  return {
    text: tableRows.map((row) => row.join(' | ')).join('\n'),
    tableRows: tableRows.filter((row) => row.some(Boolean)),
    extractionMethod: 'xlsx_parse',
    qualityScore: 1,
    qualityIssues: [],
    metadata: {
      sheetName: firstSheetName,
      rowCount: tableRows.length,
    },
  };
};

const renderPdfForOcr = async (filePath) => {
  const outputDir = await fs.promises.mkdtemp(path.join(OCR_OUTPUT_DIR, 'pages-'));
  const previewName = path.basename(filePath, path.extname(filePath));

  try {
    await execFileAsync('/usr/bin/qlmanage', ['-t', '-s', '2400', '-o', outputDir, filePath]);
  } catch (error) {
    throw new Error('OCR fallback is unavailable because PDF page rendering failed on this device.');
  }

  const files = await fs.promises.readdir(outputDir);
  const imagePath =
    files
      .filter((file) => file.startsWith(previewName) && file.endsWith('.png'))
      .map((file) => path.join(outputDir, file))[0]
    || null;

  if (!imagePath) {
    throw new Error('OCR fallback is unavailable because no preview image could be generated.');
  }

  return {
    outputDir,
    imagePaths: [imagePath],
  };
};

const performOcrFallback = async (filePath) => {
  let outputDir = null;
  try {
    let Tesseract;
    try {
      Tesseract = require('tesseract.js');
    } catch (_error) {
      throw new Error('OCR fallback requires the tesseract.js dependency to be installed.');
    }

    const texts = [];
    let imagePaths = [filePath];

    if (String(path.extname(filePath || '')).toLowerCase() === '.pdf') {
      const rendered = await renderPdfForOcr(filePath);
      outputDir = rendered.outputDir;
      imagePaths = rendered.imagePaths;
    }

    for (const imagePath of imagePaths) {
      const result = await Tesseract.recognize(imagePath, 'eng');
      texts.push(String(result?.data?.text || '').trim());
    }

    return texts.filter(Boolean).join('\n');
  } finally {
    if (outputDir) {
      await fs.promises.rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
};

const detectFileType = ({ filePath, fileName = '', mimeType = '' } = {}) => {
  const extension = path.extname(filePath || fileName).toLowerCase();
  if (
    extension === '.xlsx'
    || extension === '.xls'
    || mimeType === 'application/vnd.ms-excel'
    || mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    return 'xlsx';
  }
  if (
    extension === '.png'
    || extension === '.jpg'
    || extension === '.jpeg'
    || extension === '.webp'
    || String(mimeType || '').startsWith('image/')
  ) {
    return 'image';
  }
  return 'pdf';
};

const extractPdfContent = async (filePath) => {
  const pdfResult = await performPdfParse(filePath);
  const pdfQuality = scoreStatementTextQuality(pdfResult.text);

  if (pdfQuality.score >= 0.7) {
    return {
      text: pdfResult.text,
      tableRows: null,
      extractionMethod: 'pdf_parse',
      qualityScore: pdfQuality.score,
      qualityIssues: pdfQuality.issues,
      metadata: pdfResult.metadata,
    };
  }

  const ocrText = await performOcrFallback(filePath);
  const ocrQuality = scoreStatementTextQuality(ocrText);

  if (!ocrText || ocrQuality.score < 0.4) {
    throw new Error(
      buildUnreadableStatementMessage('pdf', [
        'This usually happens when the file is not an actual bank statement, the scan is blurry, or the dates, descriptions, and amounts are not clearly visible.',
        'Upload a clearer bank statement PDF or a clean scan that shows the transaction table.',
      ]),
    );
  }

  return {
    text: ocrText,
    tableRows: null,
    extractionMethod: 'tesseract_ocr',
    qualityScore: ocrQuality.score,
    qualityIssues: ocrQuality.issues,
    metadata: pdfResult.metadata,
  };
};

const extractImageContent = async (filePath) => {
  const ocrText = await performOcrFallback(filePath);
  const imageQuality = scoreStatementTextQuality(ocrText);

  if (!ocrText || imageQuality.score < 0.35) {
    throw new Error(
      buildUnreadableStatementMessage('image', [
        'The photo or scan may be too blurry, cropped, dark, or missing part of the transaction table.',
        'Upload a brighter, flatter image where the dates, descriptions, and amounts are fully visible.',
      ]),
    );
  }

  return {
    text: ocrText,
    tableRows: null,
    extractionMethod: 'image_ocr',
    qualityScore: imageQuality.score,
    qualityIssues: imageQuality.issues,
    metadata: {
      source: 'image',
    },
  };
};

const extractStatementContent = async (filePath, fileMeta = {}) => {
  const fileType = detectFileType({ filePath, ...fileMeta });

  if (fileType === 'xlsx') {
    return {
      ...(await extractExcelContent(filePath)),
      fileType,
    };
  }

  if (fileType === 'image') {
    return {
      ...(await extractImageContent(filePath)),
      fileType,
    };
  }

  return {
    ...(await extractPdfContent(filePath)),
    fileType,
  };
};

module.exports = {
  MAX_FILE_SIZE_BYTES,
  SUPPORTED_EXTENSIONS,
  SUPPORTED_MIME_TYPES,
  detectFileType,
  extractStatementContent,
  extractStatementText: extractPdfContent,
  safeUnlink,
  statementUploadMiddleware,
};
