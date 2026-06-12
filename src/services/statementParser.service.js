const {
  cleanCell,
  detectStructureFromTableRows,
  detectStructureFromText,
  detectFormatFromColumnMap,
  extractDatePrefix,
  hasTimeComponent,
  isDateLike,
  parseDateValue,
  parseMoney,
} = require('./statementStructure.service');
const { extractStatementTransactions } = require('./statementLLM.service');

const REF_REGEX = /^[A-Za-z0-9][A-Za-z0-9_./-]{5,}$/;
const LOW_CONFIDENCE_THRESHOLD = 0.45;

const defaultRow = () => ({
  transactionDate: null,
  description: '',
  counterParty: null,
  transactionType: null,
  debit: 0,
  credit: 0,
  amount: 0,
  direction: 'unknown',
  classification: 'unknown',
  balance: null,
  transactionId: null,
  confidence: 0,
  status: 'needs_review',
  validationErrors: [],
  rawDescription: '',
  transactionTimeProvided: false,
});

const buildRowOutcome = (row) => {
  const result = { ...defaultRow(), ...row };
  const validationErrors = Array.isArray(result.validationErrors) ? [...new Set(result.validationErrors.filter(Boolean))] : [];

  if (!result.transactionDate || Number.isNaN(new Date(result.transactionDate).getTime())) {
    validationErrors.push('Missing transaction date');
  }

  if (!result.amount || Number(result.amount) <= 0) {
    validationErrors.push('Missing amount');
  }

  if (!['debit', 'credit', 'unknown'].includes(result.direction)) {
    result.direction = 'unknown';
  }

  if (result.direction === 'debit') {
    result.classification = 'expense';
    result.debit = Math.abs(Number(result.debit || result.amount || 0));
    result.credit = 0;
  } else if (result.direction === 'credit') {
    result.classification = 'income';
    result.credit = Math.abs(Number(result.credit || result.amount || 0));
    result.debit = 0;
  } else {
    result.classification = 'unknown';
    validationErrors.push('Could not determine whether this row is debit or credit');
  }

  if (!result.description) {
    result.description = result.counterParty || result.transactionType || result.rawDescription || '';
  }

  result.amount = Math.abs(Number(result.amount || result.debit || result.credit || 0));
  result.debit = Math.abs(Number(result.debit || 0));
  result.credit = Math.abs(Number(result.credit || 0));
  result.balance = result.balance === null || result.balance === undefined ? null : Number(result.balance);
  result.validationErrors = validationErrors;
  result.confidence = Number(Math.max(Math.min(Number(result.confidence || 0), 1), 0).toFixed(2));
  result.status = validationErrors.length > 0 || result.confidence < 0.6 ? 'needs_review' : 'ready';

  return result;
};

const parseIndicatorDirection = (value) => {
  const normalized = cleanCell(value).toLowerCase();
  if (!normalized) return 'unknown';
  if (['dr', 'debit', 'withdrawal', 'money out', 'outflow'].some((token) => normalized.includes(token))) {
    return 'debit';
  }
  if (['cr', 'credit', 'deposit', 'money in', 'inflow'].some((token) => normalized.includes(token))) {
    return 'credit';
  }
  return 'unknown';
};

const normalizeColumnKey = (columnMap = {}, field) => columnMap[field];

const mergeContinuationRows = (rows, structure) => {
  const merged = [];
  const descriptionIndex = normalizeColumnKey(structure.columnMap, 'description');
  const counterPartyIndex = normalizeColumnKey(structure.columnMap, 'counterParty');
  const dateIndex = normalizeColumnKey(structure.columnMap, 'date');
  const amountIndex = normalizeColumnKey(structure.columnMap, 'amount');
  const debitIndex = normalizeColumnKey(structure.columnMap, 'debit');
  const creditIndex = normalizeColumnKey(structure.columnMap, 'credit');

  rows.forEach((row) => {
    const hasDate = dateIndex !== undefined && parseDateValue(row[dateIndex]);
    const hasAmount =
      (amountIndex !== undefined && parseMoney(row[amountIndex]) !== null)
      || (debitIndex !== undefined && parseMoney(row[debitIndex]) !== null)
      || (creditIndex !== undefined && parseMoney(row[creditIndex]) !== null);

    if (!hasDate && !hasAmount && merged.length) {
      const previous = merged[merged.length - 1];
      if (descriptionIndex !== undefined && row[descriptionIndex]) {
        previous[descriptionIndex] = cleanCell(`${previous[descriptionIndex] || ''} ${row[descriptionIndex]}`);
      }
      if (counterPartyIndex !== undefined && row[counterPartyIndex]) {
        previous[counterPartyIndex] = cleanCell(`${previous[counterPartyIndex] || ''} ${row[counterPartyIndex]}`);
      }
      return;
    }

    merged.push([...row]);
  });

  return merged;
};

const normalizeRowFromColumns = (row, structure) => {
  const columnMap = structure.columnMap || {};
  const format = structure.detectedFormat || detectFormatFromColumnMap(columnMap);

  const getValue = (field) => {
    const index = columnMap[field];
    return index === undefined ? '' : row[index];
  };

  const dateValue = getValue('date');
  const descriptionValue = getValue('description');
  const counterPartyValue = getValue('counterParty');
  const transactionTypeValue = getValue('transactionType');
  const transactionIdValue = getValue('transactionId');
  const balanceValue = getValue('balance');
  const indicatorValue = getValue('indicator');

  let debit = parseMoney(getValue('debit')) || 0;
  let credit = parseMoney(getValue('credit')) || 0;
  let amount = parseMoney(getValue('amount')) || 0;
  let direction = 'unknown';

  if (format === 'debit_credit') {
    if (debit > 0 && credit === 0) {
      direction = 'debit';
      amount = debit;
    } else if (credit > 0 && debit === 0) {
      direction = 'credit';
      amount = credit;
    } else if (amount > 0) {
      direction = debit > credit ? 'debit' : credit > debit ? 'credit' : 'unknown';
    }
  } else if (format === 'amount_with_indicator') {
    direction = parseIndicatorDirection(indicatorValue);
    if (direction === 'debit') {
      debit = Math.abs(amount);
      credit = 0;
    } else if (direction === 'credit') {
      credit = Math.abs(amount);
      debit = 0;
    }
  } else if (format === 'signed_amount') {
    if (amount < 0) {
      direction = 'debit';
      debit = Math.abs(amount);
      amount = Math.abs(amount);
      credit = 0;
    } else if (amount > 0) {
      direction = 'credit';
      credit = amount;
      debit = 0;
    }
  }

  const populatedFields = [
    dateValue,
    descriptionValue,
    counterPartyValue,
    transactionTypeValue,
    transactionIdValue,
    balanceValue,
  ].filter((value) => cleanCell(value)).length;

  return buildRowOutcome({
    transactionDate: parseDateValue(dateValue),
    transactionTimeProvided: hasTimeComponent(dateValue),
    description: cleanCell(descriptionValue),
    counterParty: cleanCell(counterPartyValue) || null,
    transactionType: cleanCell(transactionTypeValue) || null,
    transactionId: cleanCell(transactionIdValue) || null,
    balance: parseMoney(balanceValue),
    amount,
    debit,
    credit,
    direction,
    rawDescription: [descriptionValue, counterPartyValue, transactionTypeValue].map(cleanCell).filter(Boolean).join(' '),
    confidence: Math.min(1, structure.confidence * 0.7 + Math.min(populatedFields / 6, 0.3)),
  });
};

const splitDelimitedText = (text, delimiter) =>
  String(text || '')
    .split(/\r?\n/)
    .map((line) => line.split(delimiter).map(cleanCell))
    .filter((parts) => parts.some(Boolean));

const parseStructuredRows = (rows) => {
  const structure = detectStructureFromTableRows(rows);
  if (structure.headerRowIndex === null || structure.confidence < 0.3) {
    return {
      rows: [],
      metrics: {
        candidateCount: 0,
        parsedCount: 0,
        failedCount: 0,
      },
      structure,
    };
  }

  const dataRows = rows.slice(structure.headerRowIndex + 1).filter((row) => Array.isArray(row) && row.some((cell) => cleanCell(cell)));
  const mergedRows = mergeContinuationRows(dataRows, structure);
  const parsedRows = mergedRows.map((row) => normalizeRowFromColumns(row, structure));

  return {
    rows: parsedRows,
    metrics: {
      candidateCount: mergedRows.length,
      parsedCount: parsedRows.filter((row) => row.validationErrors.length === 0).length,
      failedCount: parsedRows.filter((row) => row.validationErrors.length > 0).length,
    },
    structure,
  };
};

const splitIntoDateBlocks = (text) => {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(cleanCell)
    .filter(Boolean);

  const blocks = [];
  let current = [];

  for (const line of lines) {
    if (isDateLike(line)) {
      if (current.length) blocks.push(current);
      current = [line];
      continue;
    }

    if (!current.length) continue;
    current.push(line);
  }

  if (current.length) blocks.push(current);
  return blocks;
};

const inferAmountsFromLines = (lines) => {
  const amountLines = lines
    .map((line) => parseMoney(line))
    .filter((value) => value !== null);

  if (amountLines.length >= 3) {
    return {
      debit: Math.abs(Number(amountLines[0] || 0)),
      credit: Math.abs(Number(amountLines[1] || 0)),
      balance: Number(amountLines[2] || 0),
      amount: Math.abs(Number(amountLines[0] || amountLines[1] || 0)),
      direction:
        Number(amountLines[0] || 0) > 0 && Number(amountLines[1] || 0) === 0
          ? 'debit'
          : Number(amountLines[1] || 0) > 0 && Number(amountLines[0] || 0) === 0
            ? 'credit'
            : 'unknown',
    };
  }

  if (amountLines.length === 2) {
    const [first, second] = amountLines;
    if (first < 0 || second < 0) {
      return {
        amount: Math.abs(first < 0 ? first : second),
        debit: Math.abs(first < 0 ? first : second),
        credit: 0,
        balance: first < 0 ? second : first,
        direction: 'debit',
      };
    }

    return {
      amount: Math.abs(first || second || 0),
      debit: first > 0 && second === 0 ? first : 0,
      credit: second > 0 && first === 0 ? second : 0,
      balance: null,
      direction:
        first > 0 && second === 0
          ? 'debit'
          : second > 0 && first === 0
            ? 'credit'
            : 'unknown',
    };
  }

  if (amountLines.length === 1) {
    const amountValue = Number(amountLines[0] || 0);
    return {
      amount: Math.abs(amountValue),
      debit: amountValue < 0 ? Math.abs(amountValue) : 0,
      credit: amountValue > 0 ? amountValue : 0,
      balance: null,
      direction: amountValue < 0 ? 'debit' : amountValue > 0 ? 'credit' : 'unknown',
    };
  }

  return {
    amount: 0,
    debit: 0,
    credit: 0,
    balance: null,
    direction: 'unknown',
  };
};

const parseDateBlock = (lines, structure) => {
  const [firstLine, ...rest] = lines;
  const dateToken = extractDatePrefix(firstLine);
  const transactionDate = parseDateValue(dateToken);
  const remainder = cleanCell(String(firstLine || '').replace(dateToken || '', ''));
  const bodyLines = [...(remainder ? [remainder] : []), ...rest];

  const amountOnlyLines = [];
  const textLines = [];
  for (const line of bodyLines) {
    const money = parseMoney(line);
    const stripped = cleanCell(line).replace(/[-+]?((NGN|₦)\s*)?\d[\d,]*(?:\.\d{1,2})?/gi, '').replace(/[\s|:()-]/g, '');
    if (money !== null && stripped.length === 0) {
      amountOnlyLines.push(line);
    } else {
      textLines.push(line);
    }
  }

  const amountInfo = inferAmountsFromLines(amountOnlyLines);
  const transactionId =
    [...textLines].reverse().find((line) => REF_REGEX.test(line))
    || null;
  const descriptionLines = transactionId ? textLines.filter((line) => line !== transactionId) : textLines;
  const stackedHeaders = structure?.stackedHeaders || [];
  const transactionType = descriptionLines[0] || null;
  let counterParty = null;

  if (stackedHeaders.includes('counterParty') && descriptionLines.length > 1) {
    counterParty = descriptionLines.slice(1).join(' ');
  } else if (descriptionLines.length > 1) {
    counterParty = descriptionLines.slice(1).join(' ');
  } else {
    counterParty = transactionType;
  }

  const description = cleanCell(counterParty || transactionType || bodyLines.join(' '));

  return buildRowOutcome({
    transactionDate,
    transactionTimeProvided: hasTimeComponent(dateToken),
    transactionType,
    description,
    counterParty: cleanCell(counterParty) || null,
    transactionId,
    balance: amountInfo.balance,
    amount: amountInfo.amount,
    debit: amountInfo.debit,
    credit: amountInfo.credit,
    direction: amountInfo.direction,
    rawDescription: bodyLines.join(' '),
    confidence: Math.min(1, Math.max(structure?.confidence || 0.35, amountInfo.amount ? 0.62 : 0.35)),
  });
};

const parseTextDeterministically = (text) => {
  const structure = detectStructureFromText(text);

  if (structure.delimiter) {
    const rows = splitDelimitedText(text, structure.delimiter);
    const tableResult = parseStructuredRows(rows);
    if (tableResult.rows.length) {
      return tableResult;
    }
  }

  const blocks = splitIntoDateBlocks(text);
  const parsedRows = blocks.map((block) => parseDateBlock(block, structure));

  return {
    rows: parsedRows,
    metrics: {
      candidateCount: blocks.length,
      parsedCount: parsedRows.filter((row) => row.validationErrors.length === 0).length,
      failedCount: parsedRows.filter((row) => row.validationErrors.length > 0).length,
      blockCount: blocks.length,
    },
    structure,
  };
};

const parseAiRows = (rows = []) =>
  rows.map((row) =>
    buildRowOutcome({
      transactionDate: row.transactionDate ? parseDateValue(row.transactionDate) || new Date(row.transactionDate) : null,
      transactionTimeProvided: hasTimeComponent(row.transactionDate),
      description: cleanCell(row.description),
      counterParty: cleanCell(row.counterParty) || null,
      transactionType: cleanCell(row.transactionType) || null,
      debit: parseMoney(row.debit) || Number(row.debit || 0),
      credit: parseMoney(row.credit) || Number(row.credit || 0),
      amount: parseMoney(row.amount) || Number(row.amount || 0),
      direction: row.direction || 'unknown',
      classification: row.classification || 'unknown',
      balance: parseMoney(row.balance) || Number(row.balance || 0) || null,
      transactionId: cleanCell(row.transactionId) || null,
      confidence: Number(row.confidence || 0.35),
      status: row.status || 'needs_review',
      validationErrors: row.validationErrors || [],
      rawDescription: cleanCell(row.rawDescription || row.description || ''),
    }),
  );

const shouldUseAiFallback = (result) => {
  const candidateCount = result.metrics?.candidateCount ?? result.metrics?.blockCount ?? 0;
  const parsedCount = result.metrics?.parsedCount || 0;
  const parsedRatio = candidateCount > 0 ? parsedCount / candidateCount : 0;
  const confidence = result.structure?.confidence || 0;

  return candidateCount > 0 && (confidence < LOW_CONFIDENCE_THRESHOLD || parsedRatio < 0.4);
};

const parseStatementSource = async ({
  text = '',
  tableRows = null,
  fileType = null,
  allowAiFallback = true,
  filePath = null,
  fileName = '',
  mimeType = '',
} = {}) => {
  if (!allowAiFallback) {
    const deterministicResult = Array.isArray(tableRows) && tableRows.length
      ? parseStructuredRows(tableRows)
      : parseTextDeterministically(text);
    return { ...deterministicResult, usedAiFallback: false };
  }

  const llmResult = await extractStatementTransactions({
    filePath,
    fileName,
    mimeType,
    fileType,
  });

  const parsedRows = parseAiRows(llmResult?.rows || []);

  return {
    rows: parsedRows,
    metrics: {
      candidateCount: parsedRows.length,
      parsedCount: parsedRows.filter((row) => row.validationErrors.length === 0).length,
      failedCount: parsedRows.filter((row) => row.validationErrors.length > 0).length,
    },
    structure: {
      headerRowIndex: null,
      detectedFormat: 'llm_normalized',
      columnMap: {},
      confidence: Number(llmResult?.metadata?.confidenceSummary?.averageConfidence || 0),
    },
    usedAiFallback: true,
    extractionMetadata: llmResult?.metadata || null,
  };
};

const parseStatementText = (text) => {
  const result = parseTextDeterministically(text);
  return {
    rows: result.rows,
    metrics: {
      blockCount: result.metrics.blockCount ?? result.metrics.candidateCount ?? 0,
      candidateCount: result.metrics.candidateCount ?? result.metrics.blockCount ?? 0,
      parsedCount: result.metrics.parsedCount,
      failedCount: result.metrics.failedCount,
    },
    structure: result.structure,
  };
};

module.exports = {
  LOW_CONFIDENCE_THRESHOLD,
  parseStatementSource,
  parseStatementText,
  parseStructuredRows,
  splitIntoDateBlocks,
};
