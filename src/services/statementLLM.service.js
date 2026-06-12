const fs = require('fs');
const path = require('path');

const {
  completeJson,
  completeJsonResponses,
} = require('./llm/azureOpenAI.service');
const {
  buildStatementExtractionPrompts,
  buildStatementMetadataPrompts,
  STATEMENT_TRANSACTION_JSON_SCHEMA,
} = require('./prompts/statementPrompts');

const MODEL_NAME = String(
  process.env.AZURE_OPENAI_MODEL_NAME || process.env.AZURE_OPENAI_DEPLOYMENT_NAME || 'azure-openai',
).trim();
const FILE_RESPONSE_TIMEOUT_MS = 180000;
const MAX_TEXT_CHUNK_CHARS = 9000;
const MAX_TABLE_ROWS_PER_CHUNK = 30;

const cleanString = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const toPositiveNumber = (value) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.abs(value);
  }

  const normalized = String(value)
    .replace(/₦|NGN/gi, '')
    .replace(/[,\s]/g, '')
    .trim();

  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.abs(parsed) : null;
};

const normalizeDirection = (value) => {
  const normalized = cleanString(value).toLowerCase();
  if (normalized === 'debit') return 'debit';
  if (normalized === 'credit') return 'credit';
  return 'unknown';
};

const resolveTransferClassification = ({ direction, description, transactionType }) => {
  const lowered = cleanString(`${description || ''} ${transactionType || ''}`).toLowerCase();

  if (
    lowered.includes('transfer from')
    || lowered.includes('received from')
    || lowered.includes('tfr from')
    || lowered.includes('trf from')
  ) {
    return 'income';
  }

  if (
    lowered.includes('transfer to')
    || lowered.includes('sent to')
    || lowered.includes('wallet topup')
    || lowered.includes('wallet top up')
    || lowered.includes('tfr to')
    || lowered.includes('trf to')
  ) {
    return 'expense';
  }

  if (direction === 'credit') {
    return 'income';
  }

  if (direction === 'debit') {
    return 'expense';
  }

  return 'unknown';
};

const normalizeClassification = (value, context = {}) => {
  const normalized = cleanString(value).toLowerCase();
  if (['income', 'expense'].includes(normalized)) {
    return normalized;
  }
  if (normalized === 'transfer') {
    return resolveTransferClassification(context);
  }
  return 'unknown';
};

const normalizeConfidence = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0.35;
  }
  return Number(Math.max(0, Math.min(parsed, 1)).toFixed(2));
};

const normalizeRow = (row = {}, index = 0) => {
  const description = cleanString(row.description);
  const transactionType = cleanString(row.transactionType) || null;
  const direction = normalizeDirection(row.direction);

  return {
    sourceIndex: Number(row.sourceIndex ?? index + 1),
    transactionDate: cleanString(row.transactionDate) || null,
    transactionTimeProvided: /[T\s]\d{2}:\d{2}(?::\d{2})?/.test(cleanString(row.transactionDate)),
    description,
    rawDescription: cleanString(row.rawDescription || row.description),
    counterParty: cleanString(row.counterParty) || null,
    transactionType,
    debit: toPositiveNumber(row.debit),
    credit: toPositiveNumber(row.credit),
    amount: toPositiveNumber(row.amount),
    balance: toPositiveNumber(row.balance),
    direction,
    classification: normalizeClassification(row.classification, {
      direction,
      description,
      transactionType,
    }),
    transactionId: cleanString(row.transactionId) || null,
    confidence: normalizeConfidence(row.confidence),
  };
};

const dedupeRows = (rows = []) => {
  const seen = new Set();
  const deduped = [];

  rows.forEach((row) => {
    const key = [
      cleanString(row.transactionDate || ''),
      cleanString(row.description || row.rawDescription || ''),
      String(row.amount ?? ''),
      String(row.debit ?? ''),
      String(row.credit ?? ''),
      cleanString(row.transactionId || ''),
    ].join('::');

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    deduped.push(row);
  });

  return deduped;
};

const buildTextChunks = (text = '') => {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return [];
  }

  const chunks = [];
  let current = [];
  let currentLength = 0;

  lines.forEach((line, index) => {
    const serializedLine = `[${index + 1}] ${line}`;
    const nextLength = currentLength + serializedLine.length + 1;

    if (current.length > 0 && nextLength > MAX_TEXT_CHUNK_CHARS) {
      chunks.push(current.join('\n'));
      current = [];
      currentLength = 0;
    }

    current.push(serializedLine);
    currentLength += serializedLine.length + 1;
  });

  if (current.length > 0) {
    chunks.push(current.join('\n'));
  }

  return chunks;
};

const buildTableChunks = (tableRows = []) => {
  const rows = Array.isArray(tableRows)
    ? tableRows.filter((row) => Array.isArray(row) && row.some((cell) => cleanString(cell)))
    : [];
  if (!rows.length) {
    return [];
  }

  const headerRow = rows[0];
  const dataRows = rows.slice(1);
  const chunks = [];

  for (let index = 0; index < dataRows.length; index += MAX_TABLE_ROWS_PER_CHUNK) {
    const chunkRows = dataRows.slice(index, index + MAX_TABLE_ROWS_PER_CHUNK);
    chunks.push(
      [
        `HEADER | ${headerRow.map((cell) => cleanString(cell)).join(' | ')}`,
        ...chunkRows.map((row, rowIndex) => `ROW ${index + rowIndex + 1} | ${row.map((cell) => cleanString(cell)).join(' | ')}`),
      ].join('\n'),
    );
  }

  return chunks;
};

const buildChunks = ({ text = '', tableRows = null }) => {
  const tableChunks = buildTableChunks(tableRows);
  if (tableChunks.length > 0) {
    return tableChunks;
  }
  return buildTextChunks(text);
};

const summarizeConfidence = (rows = []) => {
  if (!rows.length) {
    return {
      averageConfidence: 0,
      highConfidenceCount: 0,
      mediumConfidenceCount: 0,
      lowConfidenceCount: 0,
      unknownConfidenceCount: 0,
    };
  }

  let total = 0;
  const summary = {
    averageConfidence: 0,
    highConfidenceCount: 0,
    mediumConfidenceCount: 0,
    lowConfidenceCount: 0,
    unknownConfidenceCount: 0,
  };

  rows.forEach((row) => {
    const confidence = normalizeConfidence(row.confidence);
    total += confidence;

    if (confidence >= 0.8) {
      summary.highConfidenceCount += 1;
    } else if (confidence >= 0.6) {
      summary.mediumConfidenceCount += 1;
    } else if (confidence > 0) {
      summary.lowConfidenceCount += 1;
    } else {
      summary.unknownConfidenceCount += 1;
    }
  });

  summary.averageConfidence = Number((total / rows.length).toFixed(2));
  return summary;
};

const inferMimeType = ({ filePath = '', mimeType = '', fileType = '' }) => {
  if (mimeType) {
    return mimeType;
  }

  const extension = String(path.extname(filePath || '')).toLowerCase();
  if (fileType === 'pdf' || extension === '.pdf') return 'application/pdf';
  if (fileType === 'csv' || extension === '.csv') return 'text/csv';
  if (fileType === 'xlsx' || extension === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (extension === '.xls') return 'application/vnd.ms-excel';
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  return 'application/octet-stream';
};

const buildFileDataUrl = async ({ filePath, mimeType }) => {
  const buffer = await fs.promises.readFile(filePath);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
};

const extractFileTransactions = async ({
  filePath,
  fileName,
  mimeType,
  fileType,
}) => {
  const promptConfig = buildStatementExtractionPrompts({
    fileType,
    chunkIndex: 0,
    totalChunks: 1,
    chunkLabel: 'uploaded_file',
    serializedChunk:
      'Treat the uploaded bank statement file as the primary source of truth. Read the file directly and return only the extracted transactions in the requested JSON schema.',
  });

  const fileData = await buildFileDataUrl({ filePath, mimeType });
  const completion = await completeJsonResponses({
    feature: 'statement-transaction-extraction',
    instructions: promptConfig.system,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `${promptConfig.prompt}\n\nUse the uploaded file itself as the main source. Do not rely on assumptions.`,
          },
          {
            type: 'input_file',
            filename: fileName || path.basename(filePath),
            file_data: fileData,
            detail: 'high',
          },
        ],
      },
    ],
    jsonSchema: {
      name: 'statement_transactions',
      schema: STATEMENT_TRANSACTION_JSON_SCHEMA,
    },
    timeoutMs: FILE_RESPONSE_TIMEOUT_MS,
    maxRetries: 0,
  });

  const transactions = Array.isArray(completion?.json?.transactions)
    ? completion.json.transactions
    : [];

  return transactions.map((row, index) => normalizeRow(row, index));
};

const extractChunkTransactions = async ({
  serializedChunk,
  fileType,
  chunkIndex,
  totalChunks,
}) => {
  const promptConfig = buildStatementExtractionPrompts({
    fileType,
    chunkIndex,
    totalChunks,
    chunkLabel: `chunk-${chunkIndex + 1}`,
    serializedChunk,
  });

  const completion = await completeJson({
    feature: 'statement-transaction-extraction',
    ...promptConfig,
    maxTokens: 2200,
    temperature: 0.1,
  });

  const transactions = Array.isArray(completion?.json?.transactions)
    ? completion.json.transactions
    : [];

  return transactions.map((row, rowIndex) => normalizeRow(row, rowIndex));
};

const extractStatementTransactions = async ({
  filePath,
  fileName = '',
  mimeType = '',
  fileType = 'unknown',
  text = '',
  tableRows = null,
} = {}) => {
  const shouldUseFilePrompt = ['pdf', 'image'].includes(fileType);

  if (!shouldUseFilePrompt && !text && (!Array.isArray(tableRows) || !tableRows.length)) {
    return {
      rows: [],
      metadata: {
        provider: 'azure-openai',
        model: MODEL_NAME,
        extractionMode: shouldUseFilePrompt ? 'file_prompt' : 'table_prompt',
        chunkCount: 0,
        confidenceSummary: summarizeConfidence([]),
      },
    };
  }

  let rows = [];
  let extractionMode = 'table_prompt';
  let chunkCount = 1;

  if (shouldUseFilePrompt) {
    const normalizedMimeType = inferMimeType({ filePath, mimeType, fileType });
    rows = await extractFileTransactions({
      filePath,
      fileName,
      mimeType: normalizedMimeType,
      fileType,
    });
    extractionMode = 'file_prompt';
  } else {
    const chunks = buildChunks({ text, tableRows });
    chunkCount = chunks.length;

    for (let index = 0; index < chunks.length; index += 1) {
      const extracted = await extractChunkTransactions({
        serializedChunk: chunks[index],
        fileType,
        chunkIndex: index,
        totalChunks: chunks.length,
      });

      extracted.forEach((row) => rows.push(row));
    }
  }

  const dedupedRows = dedupeRows(rows).map((row) => ({
    transactionDate: row.transactionDate,
    description: row.description,
    rawDescription: row.rawDescription,
    counterParty: row.counterParty,
    transactionType: row.transactionType,
    debit: row.debit,
    credit: row.credit,
    amount: row.amount,
    balance: row.balance,
    direction: row.direction,
    classification: row.classification,
    transactionId: row.transactionId,
    confidence: row.confidence,
  }));

  return {
    rows: dedupedRows,
    metadata: {
      provider: 'azure-openai',
      model: MODEL_NAME,
      extractionMode,
      chunkCount,
      confidenceSummary: summarizeConfidence(dedupedRows),
    },
  };
};

const summarizeStatementMetadata = async ({
  fileName = '',
  fileType = 'unknown',
  extractedRows = [],
} = {}) => {
  try {
    const promptConfig = buildStatementMetadataPrompts({
      fileName,
      fileType,
      contentPreview: '',
      extractedRows,
    });

    const completion = await completeJson({
      feature: 'statement-metadata-summary',
      ...promptConfig,
      maxTokens: 300,
      temperature: 0.1,
    });

    const result = completion?.json || {};
    return {
      bankName: cleanString(result.bankName) || null,
      currency: cleanString(result.currency || 'NGN') || 'NGN',
    };
  } catch (_error) {
    return {
      bankName: null,
      currency: 'NGN',
    };
  }
};

module.exports = {
  extractStatementTransactions,
  summarizeStatementMetadata,
};
