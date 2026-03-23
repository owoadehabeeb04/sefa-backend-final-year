const { DocumentAnalysisClient, AzureKeyCredential } = require('@azure/ai-form-recognizer');
const vision = require('@google-cloud/vision');

const {
  extractStatementDateRange,
  extractTransactionsFromPDFTextDetailed,
  getHeaderText,
  parseAmount,
  parseDate,
} = require('./parsing.service');

/**
 * OCR Service for extracting transactions from scanned PDFs
 * Primary: Azure AI Document Intelligence
 * Fallback: Google Cloud Vision
 */

const azureEndpoint =
  process.env.AZURE_DOCUMENT_ENDPOINT || process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
const azureApiKey =
  process.env.AZURE_DOCUMENT_API_KEY || process.env.AZURE_DOCUMENT_INTELLIGENCE_API_KEY;
const azureModelId = process.env.AZURE_DOCUMENT_MODEL_ID || 'prebuilt-layout';
let azureClient = null;

const isPlaceholderAzureEndpoint =
  azureEndpoint &&
  (azureEndpoint.includes('your-resource') || azureEndpoint.includes('example.com'));

if (azureEndpoint && azureApiKey && !isPlaceholderAzureEndpoint) {
  azureClient = new DocumentAnalysisClient(
    azureEndpoint,
    new AzureKeyCredential(azureApiKey),
  );
  console.log('✅ Azure OCR configured');
} else if (isPlaceholderAzureEndpoint) {
  console.warn('⚠️  Azure OCR endpoint appears to be a placeholder value; Azure OCR disabled.');
}

const getAzureConfigStatus = () => ({
  hasEndpoint: !!azureEndpoint,
  hasApiKey: !!azureApiKey,
  isPlaceholderEndpoint: !!isPlaceholderAzureEndpoint,
  modelId: azureModelId,
  endpointHost: (() => {
    if (!azureEndpoint) return null;
    try {
      return new URL(azureEndpoint).host;
    } catch (_error) {
      return 'invalid-endpoint-format';
    }
  })(),
  enabled: !!azureClient,
});

const getAzureErrorDetails = (error) => {
  const responseError = error?.response?.parsedBody?.error || error?.response?.body?.error;
  return {
    message: error?.message || 'Unknown Azure OCR error',
    name: error?.name || null,
    code: error?.code || responseError?.code || null,
    statusCode: error?.statusCode || error?.response?.status || null,
    details: responseError?.message || null,
  };
};

let googleClient = null;

if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  googleClient = new vision.ImageAnnotatorClient();
}

const normalizeCellText = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim();

const inferDirectionFromToken = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes(' dr') || normalized.endsWith('dr') || normalized.includes(' debit')) {
    return 'debit';
  }
  if (normalized.includes(' cr') || normalized.endsWith('cr') || normalized.includes(' credit')) {
    return 'credit';
  }
  if (/^\s*-/.test(normalized) || normalized.includes('(')) {
    return 'debit';
  }
  if (/^\s*\+/.test(normalized)) {
    return 'credit';
  }
  return null;
};

const findColumnIndex = (headers, aliases) =>
  headers.findIndex((header) => aliases.some((alias) => header.includes(alias)));

const buildDescriptionFromRow = (row, indices) => {
  const candidates = [
    row[indices.descColIndex],
    row[indices.refColIndex],
  ]
    .map(normalizeCellText)
    .filter(Boolean);

  if (candidates.length) {
    return candidates.join(' ').trim();
  }

  const ignored = new Set(
    [
      indices.dateColIndex,
      indices.debitColIndex,
      indices.creditColIndex,
      indices.amountColIndex,
      indices.balanceColIndex,
    ].filter((value) => value !== -1),
  );

  return Object.entries(row)
    .filter(([columnIndex]) => !ignored.has(Number(columnIndex)))
    .map(([, value]) => normalizeCellText(value))
    .filter(Boolean)
    .join(' ')
    .trim();
};

const extractTransactionsFromTable = (table) => {
  const headers = [];
  for (const cell of table.cells || []) {
    if (cell.rowIndex === 0) {
      headers[cell.columnIndex] = normalizeCellText(cell.content).toLowerCase();
    }
  }

  const dateColIndex = findColumnIndex(headers, ['date', 'posting', 'value']);
  const descColIndex = findColumnIndex(headers, ['description', 'narration', 'details', 'remark']);
  const debitColIndex = findColumnIndex(headers, ['debit', 'withdrawal', 'outflow']);
  const creditColIndex = findColumnIndex(headers, ['credit', 'deposit', 'inflow']);
  const amountColIndex = findColumnIndex(headers, ['amount', 'value']);
  const balanceColIndex = findColumnIndex(headers, ['balance']);
  const refColIndex = findColumnIndex(headers, ['reference', 'ref', 'session', 'tranid']);

  if (dateColIndex === -1) {
    return {
      headers: headers.filter(Boolean),
      transactions: [],
    };
  }

  const rows = {};
  for (const cell of table.cells || []) {
    if (cell.rowIndex === 0) {
      continue;
    }

    if (!rows[cell.rowIndex]) {
      rows[cell.rowIndex] = {};
    }
    rows[cell.rowIndex][cell.columnIndex] = normalizeCellText(cell.content);
  }

  let lastDate = null;
  const transactions = [];

  for (const rowIndex of Object.keys(rows).sort((left, right) => Number(left) - Number(right))) {
    const row = rows[rowIndex];
    const explicitDate = parseDate(row[dateColIndex]);
    const date = explicitDate || lastDate;

    if (explicitDate) {
      lastDate = explicitDate;
    }

    const debit = debitColIndex !== -1 ? parseAmount(row[debitColIndex]) : null;
    const credit = creditColIndex !== -1 ? parseAmount(row[creditColIndex]) : null;
    const amountToken = row[amountColIndex] || row[debitColIndex] || row[creditColIndex] || '';
    const amount =
      debit || credit || (amountColIndex !== -1 ? parseAmount(row[amountColIndex]) : null);
    const direction =
      debit
        ? 'debit'
        : credit
          ? 'credit'
          : inferDirectionFromToken(amountToken);

    const description = buildDescriptionFromRow(row, {
      dateColIndex,
      descColIndex,
      debitColIndex,
      creditColIndex,
      amountColIndex,
      balanceColIndex,
      refColIndex,
    });

    if (!date || !amount || !direction || !description) {
      continue;
    }

    transactions.push({
      date,
      description,
      amount: Math.abs(amount),
      type: direction,
      direction,
      reference: normalizeCellText(row[refColIndex]),
      balance: balanceColIndex !== -1 ? parseAmount(row[balanceColIndex]) : null,
    });
  }

  return {
    headers: headers.filter(Boolean),
    transactions,
  };
};

const parseContentForTransactionsDetailed = (content) => {
  const parsed = extractTransactionsFromPDFTextDetailed(content || '');
  return {
    transactions: parsed.transactions,
    headerText: parsed.headerText || getHeaderText(content),
    rawText: parsed.rawText || String(content || ''),
    tableHeaders: parsed.tableHeaders || [],
    statementDateRange: parsed.statementDateRange || extractStatementDateRange(content),
  };
};

const extractTransactionsFromScannedPDFDetailed = async (fileBuffer) => {
  if (azureClient) {
    console.log('🔵 Using Azure Document Intelligence for OCR');
    try {
      return await extractWithAzure(fileBuffer);
    } catch (azureError) {
      const azureErrorDetails = getAzureErrorDetails(azureError);
      console.error('❌ Azure OCR failed with details:', azureErrorDetails);

      if (googleClient) {
        console.log('🟡 Azure failed, trying Google Cloud Vision');
        try {
          return await extractWithGoogle(fileBuffer);
        } catch (googleError) {
          throw new Error(
            `Both OCR services failed: Azure=${azureErrorDetails.message}; Google=${googleError.message}`,
          );
        }
      }

      throw new Error(`Azure OCR failed: ${azureErrorDetails.message}`);
    }
  }

  if (!azureClient) {
    console.warn('⚠️  Azure OCR is not enabled. Config status:', getAzureConfigStatus());
  }

  if (googleClient) {
    console.log('🟡 Falling back to Google Cloud Vision for OCR');
    return extractWithGoogle(fileBuffer);
  }

  throw new Error('No OCR service configured (Azure or Google)');
};

const extractTransactionsFromScannedPDF = async (fileBuffer) => {
  const result = await extractTransactionsFromScannedPDFDetailed(fileBuffer);
  return result.transactions;
};

const extractWithAzure = async (fileBuffer) => {
  const poller = await azureClient.beginAnalyzeDocument(azureModelId, fileBuffer);
  const { tables, content } = await poller.pollUntilDone();

  const tableHeaders = new Set();
  const tableTransactions = [];

  if (tables?.length) {
    console.log(`📊 Found ${tables.length} table(s) in document`);
    for (const table of tables) {
      const extracted = extractTransactionsFromTable(table);
      extracted.headers.forEach((header) => tableHeaders.add(header));
      tableTransactions.push(...extracted.transactions);
    }
  }

  const contentParsed = parseContentForTransactionsDetailed(content || '');
  const selectedTransactions =
    contentParsed.transactions.length > tableTransactions.length
      ? contentParsed.transactions
      : tableTransactions;

  console.log(`✅ Azure extracted ${selectedTransactions.length} transactions`);

  return {
    provider: 'azure',
    transactions: selectedTransactions,
    rawText: String(content || ''),
    headerText: getHeaderText(content),
    tableHeaders: Array.from(tableHeaders),
    statementDateRange: contentParsed.statementDateRange || extractStatementDateRange(content),
  };
};

const extractWithGoogle = async (fileBuffer) => {
  try {
    const [result] = await googleClient.documentTextDetection({
      image: { content: fileBuffer.toString('base64') },
    });
    const fullTextAnnotation = result.fullTextAnnotation;

    if (!fullTextAnnotation || !fullTextAnnotation.text) {
      throw new Error('No text detected in document');
    }

    const text = fullTextAnnotation.text;
    console.log(`📝 Google extracted ${text.length} characters`);

    const parsed = parseContentForTransactionsDetailed(text);

    console.log(`✅ Google extracted ${parsed.transactions.length} transactions`);
    return {
      provider: 'google',
      transactions: parsed.transactions,
      rawText: text,
      headerText: parsed.headerText,
      tableHeaders: [],
      statementDateRange: parsed.statementDateRange,
    };
  } catch (error) {
    throw new Error(`Google OCR failed: ${error.message}`);
  }
};

const validateExtractedTransactions = (transactions) => {
  const valid = [];
  const invalid = [];

  for (const transaction of transactions) {
    if (
      transaction.date instanceof Date &&
      !Number.isNaN(transaction.date.getTime()) &&
      transaction.amount > 0 &&
      transaction.description
    ) {
      valid.push(transaction);
    } else {
      invalid.push({
        transaction,
        reason: !transaction.date
          ? 'Invalid date'
          : !transaction.amount
            ? 'Invalid amount'
            : !transaction.description
              ? 'Missing description'
              : 'Unknown',
      });
    }
  }

  return {
    valid,
    invalid,
    totalExtracted: transactions.length,
    validCount: valid.length,
    invalidCount: invalid.length,
    successRate: transactions.length > 0 ? ((valid.length / transactions.length) * 100).toFixed(2) : 0,
  };
};

const checkOCRAvailability = () => ({
  azure: {
    configured: !!(azureEndpoint && azureApiKey),
    endpoint: azureEndpoint ? '***configured***' : null,
  },
  google: {
    configured: !!process.env.GOOGLE_APPLICATION_CREDENTIALS,
    credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS || null,
  },
  available: !!(azureClient || googleClient),
});

module.exports = {
  checkOCRAvailability,
  extractTransactionsFromScannedPDFDetailed,
  extractTransactionsFromScannedPDF,
  extractTransactionsFromTable,
  extractWithAzure,
  extractWithGoogle,
  validateExtractedTransactions,
};
