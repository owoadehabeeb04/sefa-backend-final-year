const DATE_PREFIX_REGEX = /^\s*(\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?)?|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/;
const MONEY_VALUE_REGEX = /[-+]?(?:NGN|₦)?\s*\d[\d,]*(?:\.\d{1,2})?/i;

const COLUMN_ALIASES = {
  date: ['date', 'trans date', 'transaction date', 'posting date', 'value date', 'txn date'],
  description: [
    'description',
    'narration',
    'transaction details',
    'details',
    'counter party',
    'particulars',
    'remarks',
    'beneficiary',
    'sender',
    'merchant',
  ],
  counterParty: ['counter party', 'beneficiary', 'sender', 'merchant', 'receiver'],
  transactionType: ['trans type', 'transaction type', 'type', 'channel'],
  debit: ['debit', 'withdrawal', 'money out', 'paid out', 'debit amount', 'dr', 'outflow'],
  credit: ['credit', 'deposit', 'money in', 'paid in', 'credit amount', 'cr', 'inflow'],
  amount: ['amount', 'transaction amount', 'value', 'amt'],
  indicator: ['dr/cr', 'cr/dr', 'direction', 'type indicator', 'entry type', 'indicator'],
  balance: ['balance', 'available balance', 'closing balance', 'running balance'],
  transactionId: ['reference', 'reference no', 'trans id', 'transaction id', 'session id', 'payment reference'],
};

const HEADER_FIELDS = Object.keys(COLUMN_ALIASES);

const cleanCell = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const normalizeHeader = (value) =>
  cleanCell(value)
    .toLowerCase()
    .replace(/[._-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getHeaderMatchStrength = (headerValue, field) => {
  const normalized = normalizeHeader(headerValue);
  let strongest = 0;

  COLUMN_ALIASES[field].forEach((alias) => {
    if (normalized === alias) {
      strongest = Math.max(strongest, 3);
      return;
    }

    if (alias.length <= 3) {
      const exactTokenRegex = new RegExp(`(?:^|\\b)${escapeRegex(alias)}(?:\\b|$)`, 'i');
      if (exactTokenRegex.test(normalized)) {
        strongest = Math.max(strongest, 2);
      }
      return;
    }

    const wordBoundaryRegex = new RegExp(`(?:^|\\b)${escapeRegex(alias)}(?:\\b|$)`, 'i');
    if (wordBoundaryRegex.test(normalized)) {
      strongest = Math.max(strongest, 2);
      return;
    }

    if (normalized.includes(alias)) {
      strongest = Math.max(strongest, 1);
    }
  });

  return strongest;
};

const getHeaderMatchScore = (row) => {
  const cells = Array.isArray(row) ? row.map(cleanCell).filter(Boolean) : [];
  if (!cells.length) {
    return { score: 0, columnMap: {} };
  }

  const columnMap = {};
  let hits = 0;
  const usedIndexes = new Set();

  cells.forEach((cell, index) => {
    if (usedIndexes.has(index)) return;

    let bestField = null;
    let bestStrength = 0;

    HEADER_FIELDS.forEach((field) => {
      if (columnMap[field] !== undefined) return;
      const strength = getHeaderMatchStrength(cell, field);
      if (strength > bestStrength) {
        bestField = field;
        bestStrength = strength;
      }
    });

    if (bestField) {
      columnMap[bestField] = index;
      usedIndexes.add(index);
      hits += 1;
    }
  });

  return {
    score: hits / Math.max(Math.min(cells.length, 6), 1),
    columnMap,
  };
};

const detectFormatFromColumnMap = (columnMap = {}) => {
  if (columnMap.debit !== undefined || columnMap.credit !== undefined) {
    return 'debit_credit';
  }

  if (columnMap.amount !== undefined && columnMap.indicator !== undefined) {
    return 'amount_with_indicator';
  }

  if (columnMap.amount !== undefined) {
    return 'signed_amount';
  }

  return 'unknown';
};

const rowsLookStructured = (rows = []) => {
  const candidates = rows.slice(0, 8).filter((row) => Array.isArray(row) && row.length > 1);
  return candidates.length >= 2;
};

const detectStructureFromTableRows = (rows = []) => {
  if (!Array.isArray(rows) || rows.length === 0 || !rowsLookStructured(rows)) {
    return {
      headerRowIndex: null,
      detectedFormat: 'unknown',
      columnMap: {},
      confidence: 0,
      reasons: ['No structured rows found'],
      candidateRowCount: 0,
    };
  }

  let best = {
    headerRowIndex: null,
    score: 0,
    columnMap: {},
  };

  rows.slice(0, 10).forEach((row, index) => {
    const match = getHeaderMatchScore(row);
    if (match.score > best.score) {
      best = {
        headerRowIndex: index,
        score: match.score,
        columnMap: match.columnMap,
      };
    }
  });

  const detectedFormat = detectFormatFromColumnMap(best.columnMap);
  const confidenceBoost = detectedFormat !== 'unknown' ? 0.2 : 0;

  return {
    headerRowIndex: best.headerRowIndex,
    detectedFormat,
    columnMap: best.columnMap,
    confidence: Number(Math.min(best.score + confidenceBoost, 1).toFixed(2)),
    reasons:
      best.headerRowIndex === null || best.score < 0.3
        ? ['Could not confidently detect a table header row']
        : [],
    candidateRowCount: Math.max(rows.length - (best.headerRowIndex ?? 0) - 1, 0),
  };
};

const extractDatePrefix = (line) => {
  const match = String(line || '').match(DATE_PREFIX_REGEX);
  return match ? match[1] : null;
};

const isDateLike = (value) => !!extractDatePrefix(value);

const hasTimeComponent = (value) => /\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(cleanCell(value));

const parseDateValue = (value) => {
  const safeValue = cleanCell(value);
  if (!safeValue) return null;

  const yyyyMmDd = safeValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (yyyyMmDd) {
    const [, year, month, day] = yyyyMmDd;
    const parsed = new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const yyyyMmDdWithTime = safeValue.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (yyyyMmDdWithTime) {
    const [, year, month, day, hh = '0', mm = '0', ss = '0'] = yyyyMmDdWithTime;
    const parsed = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hh),
      Number(mm),
      Number(ss),
      0,
    );
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const ddmmyyyy = safeValue.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (ddmmyyyy) {
    const [, day, month, year, hh = '0', mm = '0', ss = '0'] = ddmmyyyy;
    const fullYear = Number(year.length === 2 ? `20${year}` : year);
    const parsed = new Date(
      fullYear,
      Number(month) - 1,
      Number(day),
      Number(hh),
      Number(mm),
      Number(ss),
      0,
    );
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const direct = new Date(safeValue);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  return null;
};

const detectStructureFromText = (text = '') => {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(cleanCell)
    .filter(Boolean);

  const stackedHeaders = [];
  const dateLineIndexes = [];

  lines.forEach((line, index) => {
    if (isDateLike(line)) {
      dateLineIndexes.push(index);
      return;
    }

    const normalized = normalizeHeader(line);
    HEADER_FIELDS.forEach((field) => {
      if (stackedHeaders.includes(field)) return;
      if (COLUMN_ALIASES[field].includes(normalized)) {
        stackedHeaders.push(field);
      }
    });
  });

  let tableDelimiter = null;
  const delimiterCandidates = ['\t', ',', '|', ';'];
  for (const delimiter of delimiterCandidates) {
    const splitLines = lines
      .map((line) => line.split(delimiter).map(cleanCell).filter(Boolean))
      .filter((parts) => parts.length > 1);
    if (splitLines.length >= 2) {
      const structure = detectStructureFromTableRows(splitLines);
      if (structure.confidence >= 0.45) {
        tableDelimiter = delimiter;
        return {
          headerRowIndex: structure.headerRowIndex,
          detectedFormat: structure.detectedFormat,
          columnMap: structure.columnMap,
          confidence: structure.confidence,
          reasons: structure.reasons,
          candidateRowCount: structure.candidateRowCount,
          delimiter,
          stackedHeaders: [],
          dateLineCount: dateLineIndexes.length,
        };
      }
    }
  }

  const stackedConfidence = stackedHeaders.length >= 2 && dateLineIndexes.length >= 1
    ? Math.min(0.45 + stackedHeaders.length * 0.08 + Math.min(dateLineIndexes.length, 6) * 0.04, 0.92)
    : dateLineIndexes.length >= 2
      ? 0.42
      : 0;

  return {
    headerRowIndex: null,
    detectedFormat:
      stackedHeaders.includes('debit') || stackedHeaders.includes('credit')
        ? 'debit_credit'
        : stackedHeaders.includes('amount') && stackedHeaders.includes('indicator')
          ? 'amount_with_indicator'
          : stackedHeaders.includes('amount')
            ? 'signed_amount'
            : 'unknown',
    columnMap: {},
    confidence: Number(stackedConfidence.toFixed(2)),
    reasons: stackedConfidence >= 0.4 ? [] : ['Text structure is weak or ambiguous'],
    candidateRowCount: dateLineIndexes.length,
    delimiter: tableDelimiter,
    stackedHeaders,
    dateLineCount: dateLineIndexes.length,
  };
};

const parseMoney = (value) => {
  if (value === null || value === undefined) return null;
  const safeValue = cleanCell(value);
  if (!safeValue || !MONEY_VALUE_REGEX.test(safeValue)) return null;
  const normalized = safeValue.replace(/,/g, '').replace(/[^0-9.+-]/g, '');
  if (!normalized || normalized === '+' || normalized === '-') return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

module.exports = {
  COLUMN_ALIASES,
  DATE_PREFIX_REGEX,
  MONEY_VALUE_REGEX,
  cleanCell,
  detectFormatFromColumnMap,
  detectStructureFromTableRows,
  detectStructureFromText,
  extractDatePrefix,
  headerMatchesField: (headerValue, field) => getHeaderMatchStrength(headerValue, field) > 0,
  hasTimeComponent,
  isDateLike,
  normalizeHeader,
  parseDateValue,
  parseMoney,
};
