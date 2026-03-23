const csvParser = require('csv-parser');
const pdfParse = require('pdf-parse');
const { Readable } = require('stream');

const { findBankProfile, resolveBankProfile } = require('./bankProfiles');
const {
  classifyDocumentIdentity,
  scoreDeterministicIdentity,
} = require('./documentIdentity.service');

const normalizeHeader = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const buildNormalizedRow = (row) =>
  Object.entries(row).reduce((accumulator, [key, value]) => {
    accumulator[normalizeHeader(key)] = value;
    return accumulator;
  }, {});

const getValue = (row, keys) => {
  const normalizedRow = buildNormalizedRow(row);
  for (const key of keys) {
    const value = normalizedRow[normalizeHeader(key)];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return null;
};

const buildParserResult = (base = {}) => ({
  transactions: [],
  sourceRecordCount: 0,
  validRecordCount: 0,
  skippedCount: 0,
  warnings: [],
  detectedBank: 'unknown',
  detectedBankDisplayName: 'Unknown bank',
  bankDetectionConfidence: 'unknown',
  bankDetectionSource: 'unknown',
  bankHint: null,
  parser: null,
  ocrProvider: null,
  qualityFlags: [],
  needsReview: false,
  statementDateRange: null,
  dateRange: null,
  headerText: '',
  rawText: '',
  tableHeaders: [],
  documentIdentityReasons: [],
  parserDiagnostics: {
    ocr: {
      attempted: false,
      selected: false,
      reason: null,
      providerTried: null,
    },
  },
  ...base,
});

const BANK_CONFIDENCE_SCORE = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
};

const parseDate = (dateValue) => {
  if (dateValue === null || dateValue === undefined || dateValue === '') {
    return null;
  }

  const raw = String(dateValue).trim().replace(/,\s*/g, ' ').replace(/\s+/g, ' ');
  if (!raw) return null;

  const sanitized = raw.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1');

  const ddmmyyyy = sanitized.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:\s|$)/);
  if (ddmmyyyy) {
    const year = ddmmyyyy[3].length === 2 ? Number(`20${ddmmyyyy[3]}`) : Number(ddmmyyyy[3]);
    return new Date(year, Number(ddmmyyyy[2]) - 1, Number(ddmmyyyy[1]));
  }

  const yyyymmdd = sanitized.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s|$)/);
  if (yyyymmdd) {
    return new Date(Number(yyyymmdd[1]), Number(yyyymmdd[2]) - 1, Number(yyyymmdd[3]));
  }

  const dayMonthName = sanitized.match(/^(\d{1,2})[\s-]+([a-z]{3,9})[\s-]+(\d{2,4})(?:\s|$)/i);
  if (dayMonthName) {
    const parsed = new Date(`${dayMonthName[1]} ${dayMonthName[2]} ${dayMonthName[3]}`);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const monthNameDay = sanitized.match(/^([a-z]{3,9})\s+(\d{1,2})\s+(\d{2,4})(?:\s|$)/i);
  if (monthNameDay) {
    const parsed = new Date(`${monthNameDay[1]} ${monthNameDay[2]} ${monthNameDay[3]}`);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const direct = new Date(sanitized);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  return null;
};

const parseAmount = (amountValue) => {
  if (amountValue === null || amountValue === undefined || amountValue === '') {
    return null;
  }

  const raw = String(amountValue).trim();
  if (!raw) return null;

  const cleaned = raw
    .replace(/[A-Z]{2}$/i, '')
    .replace(/[₦$£€,]/g, '')
    .replace(/\s+/g, '')
    .replace(/\(([^)]+)\)/, '-$1');

  const amount = Number(cleaned);
  return Number.isFinite(amount) ? amount : null;
};

const toDayKey = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
};

const buildTransactionDateRange = (transactions = []) => {
  const dates = transactions
    .map((transaction) => transaction.date || transaction.postedAt)
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((left, right) => left - right);

  if (!dates.length) {
    return null;
  }

  return {
    from: dates[0],
    to: dates[dates.length - 1],
  };
};

const daySpan = (dateRange) => {
  if (!dateRange?.from || !dateRange?.to) return 0;
  const start = new Date(dateRange.from);
  const end = new Date(dateRange.to);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  return Math.round((end - start) / 86400000);
};

const getHeaderText = (text, lineLimit = 24) =>
  String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, lineLimit)
    .join('\n');

const DATE_TOKEN_PATTERN =
  /(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2}\s+\d{2,4})/g;

const extractDateStrings = (text) => String(text || '').match(DATE_TOKEN_PATTERN) || [];

const collectMentionedDays = (text) =>
  Array.from(
    new Set(
      extractDateStrings(text)
        .map((dateString) => parseDate(dateString))
        .map(toDayKey)
        .filter(Boolean),
    ),
  );

const extractStatementDateRange = (text) => {
  const headerLines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 30);

  for (const line of headerLines) {
    if (!/(statement|period|range|from|to)/i.test(line)) {
      continue;
    }

    const matches = extractDateStrings(line);
    if (matches.length < 2) {
      continue;
    }

    const parsedDates = matches
      .slice(0, 2)
      .map((match) => parseDate(match))
      .filter((date) => date && !Number.isNaN(date.getTime()))
      .sort((left, right) => left - right);

    if (parsedDates.length === 2) {
      return {
        from: parsedDates[0],
        to: parsedDates[1],
      };
    }
  }

  return null;
};

const attachIdentity = (result, identity) => {
  const merged = {
    ...result,
    detectedBank: identity.bankSlug || 'unknown',
    detectedBankDisplayName: identity.displayName || 'Unknown bank',
    bankDetectionConfidence: identity.confidence || 'unknown',
    bankDetectionSource: identity.source || 'unknown',
    parser: result.parser || identity.parserHint || null,
    documentIdentityReasons: identity.reasons || [],
  };

  if (
    merged.detectedBank === 'unknown' ||
    merged.bankDetectionConfidence === 'low' ||
    merged.bankDetectionConfidence === 'unknown'
  ) {
    merged.needsReview = true;
    merged.qualityFlags = Array.from(
      new Set([
        ...(merged.qualityFlags || []),
        merged.detectedBank === 'unknown' ? 'unknown_bank' : 'low_bank_confidence',
      ]),
    );
  }

  return merged;
};

const assessDateQuality = (result, sourceText = '') => {
  const qualityFlags = [...(result.qualityFlags || [])];
  const warnings = [...(result.warnings || [])];
  let needsReview = !!result.needsReview;

  const dayCounts = result.transactions.reduce((accumulator, transaction) => {
    const dayKey = toDayKey(transaction.date || transaction.postedAt);
    if (!dayKey) return accumulator;
    accumulator[dayKey] = (accumulator[dayKey] || 0) + 1;
    return accumulator;
  }, {});

  const counts = Object.values(dayCounts);
  const highestDayCount = counts.length ? Math.max(...counts) : 0;
  const sameDayRatio =
    result.validRecordCount > 0 ? highestDayCount / result.validRecordCount : 0;
  const mentionedDays = collectMentionedDays(sourceText);
  const statedRangeSpan = daySpan(result.statementDateRange);

  if (
    result.validRecordCount >= 4 &&
    sameDayRatio >= 0.8 &&
    (statedRangeSpan > 1 || mentionedDays.length >= 3)
  ) {
    qualityFlags.push('suspicious_date_collapse');
    warnings.push(
      'Most parsed transactions resolved to one date even though the statement appears to span multiple days. Review this import before trusting the dates.',
    );
    needsReview = true;
  }

  if (result.statementDateRange?.from && result.statementDateRange?.to && result.transactions.length) {
    const start = new Date(result.statementDateRange.from);
    const end = new Date(result.statementDateRange.to);
    const outOfRangeCount = result.transactions.filter((transaction) => {
      const date = new Date(transaction.date || transaction.postedAt);
      return !Number.isNaN(date.getTime()) && (date < start || date > end);
    }).length;

    if (outOfRangeCount > 0) {
      qualityFlags.push('date_out_of_statement_range');
      warnings.push(
        `${outOfRangeCount} parsed row(s) fell outside the detected statement period and should be reviewed.`,
      );
      needsReview = true;
    }
  }

  return {
    ...result,
    qualityFlags: Array.from(new Set(qualityFlags)),
    warnings: Array.from(new Set(warnings)).slice(0, 50),
    needsReview,
  };
};

const getPdfExtractionMetrics = (result) => {
  const validRatio =
    result.sourceRecordCount > 0 ? result.validRecordCount / result.sourceRecordCount : 0;

  return {
    validRatio,
    hasLowCoverage: result.sourceRecordCount >= 3 && validRatio < 0.75,
    hasHeavySkips: result.skippedCount >= 3,
    hasSuspiciousDates: result.qualityFlags.includes('suspicious_date_collapse'),
    hasUnknownBank: ['unknown', 'low'].includes(result.bankDetectionConfidence),
  };
};

const shouldRunOcrForPdf = (result) => {
  const metrics = getPdfExtractionMetrics(result);
  const reasons = [];

  if (result.validRecordCount === 0) reasons.push('no_valid_rows');
  if (metrics.hasLowCoverage) reasons.push('low_text_coverage');
  if (metrics.hasHeavySkips && metrics.validRatio < 0.9) reasons.push('many_text_rows_skipped');
  if (metrics.hasSuspiciousDates) reasons.push('suspicious_date_collapse');
  if (metrics.hasUnknownBank && metrics.validRatio < 0.85) reasons.push('weak_bank_identity');

  return {
    shouldUseOcr: reasons.length > 0,
    reason: reasons[0] || null,
    reasons,
    metrics,
  };
};

const detectDirection = (row, amountValue) => {
  const debitValue = getValue(row, ['debit', 'debit amount', 'withdrawal', 'withdrawals']);
  const creditValue = getValue(row, ['credit', 'credit amount', 'deposit', 'deposits']);

  if (parseAmount(debitValue)) return 'debit';
  if (parseAmount(creditValue)) return 'credit';

  const explicitDirection = getValue(row, ['direction', 'type', 'dr/cr', 'dr cr', 'status']);
  const normalizedDirection = String(explicitDirection || '').trim().toLowerCase();
  if (['dr', 'debit', 'withdrawal', 'expense'].includes(normalizedDirection)) return 'debit';
  if (['cr', 'credit', 'deposit', 'income'].includes(normalizedDirection)) return 'credit';

  const raw = String(amountValue || '');
  if (raw.includes('(') || /^\s*-/.test(raw) || /\bdr\b/i.test(raw)) return 'debit';
  if (/\bcr\b/i.test(raw) || /^\s*\+/.test(raw)) return 'credit';

  return null;
};

const parseStructuredRow = (row, config = {}) => {
  const dateRaw = getValue(row, config.date || ['date']);
  const description = String(
    getValue(row, config.description || ['description', 'narration', 'details']) || '',
  ).trim();
  const debitRaw = getValue(row, config.debit || ['debit', 'withdrawal']);
  const creditRaw = getValue(row, config.credit || ['credit', 'deposit']);
  const amountRaw = getValue(row, config.amount || ['amount']);
  const balanceRaw = getValue(row, config.balance || ['balance']);
  const reference = String(
    getValue(row, config.reference || ['reference', 'ref', 'tranid', 'trans ref']) || '',
  ).trim();

  const date = parseDate(dateRaw);
  const debit = parseAmount(debitRaw);
  const credit = parseAmount(creditRaw);
  const amount = debit || credit || parseAmount(amountRaw);
  const direction =
    debit ? 'debit' : credit ? 'credit' : detectDirection(row, amountRaw || debitRaw || creditRaw);

  if (!date || !amount || !direction) {
    return null;
  }

  return {
    date,
    description,
    amount: Math.abs(amount),
    type: direction,
    direction,
    reference,
    balance: parseAmount(balanceRaw),
  };
};

const CSV_PARSERS = [
  {
    key: 'access_csv',
    bank: 'access',
    match: (headers) => headers.includes('transaction date') && headers.includes('value date'),
    parseRow: (row) =>
      parseStructuredRow(row, {
        date: ['transaction date', 'value date'],
        description: ['narration', 'description'],
        debit: ['debit', 'debit amount'],
        credit: ['credit', 'credit amount'],
        reference: ['reference', 'ref'],
        balance: ['balance'],
      }),
  },
  {
    key: 'gtbank_csv',
    bank: 'gtbank',
    match: (headers) => headers.includes('posting date') && headers.includes('tranid'),
    parseRow: (row) =>
      parseStructuredRow(row, {
        date: ['posting date', 'trans date'],
        description: ['remarks', 'narration', 'description'],
        debit: ['debit'],
        credit: ['credit'],
        reference: ['tranid', 'reference'],
        balance: ['balance'],
      }),
  },
  {
    key: 'zenith_csv',
    bank: 'zenith',
    match: (headers) => headers.includes('tran date') && headers.includes('reference'),
    parseRow: (row) =>
      parseStructuredRow(row, {
        date: ['tran date', 'transaction date'],
        description: ['narration', 'description'],
        debit: ['debit'],
        credit: ['credit'],
        reference: ['reference', 'ref no'],
        balance: ['balance'],
      }),
  },
  {
    key: 'uba_csv',
    bank: 'uba',
    match: (headers) => headers.includes('trans date') && headers.includes('trans ref'),
    parseRow: (row) =>
      parseStructuredRow(row, {
        date: ['trans date', 'transaction date'],
        description: ['transaction details', 'narration', 'description'],
        debit: ['debit'],
        credit: ['credit'],
        reference: ['trans ref', 'reference'],
        balance: ['balance'],
      }),
  },
  {
    key: 'firstbank_csv',
    bank: 'firstbank',
    match: (headers) => headers.includes('transaction date') && headers.includes('narration'),
    parseRow: (row) =>
      parseStructuredRow(row, {
        date: ['transaction date', 'date'],
        description: ['narration', 'description'],
        debit: ['debit'],
        credit: ['credit'],
        reference: ['reference', 'trans ref'],
        balance: ['balance'],
      }),
  },
  {
    key: 'opay_csv',
    bank: 'opay',
    match: (headers) =>
      headers.includes('transaction type') &&
      (headers.includes('balance after transaction') || headers.includes('balance')),
    parseRow: (row) =>
      parseStructuredRow(row, {
        date: ['transaction date', 'date', 'time'],
        description: ['description', 'remark', 'narration', 'transaction type'],
        debit: ['debit'],
        credit: ['credit'],
        amount: ['amount', 'transaction amount'],
        reference: ['reference', 'transaction reference', 'order no', 'session id'],
        balance: ['balance after transaction', 'balance'],
      }),
  },
  {
    key: 'generic_csv',
    bank: 'generic',
    match: (headers) =>
      headers.some((header) => header.includes('date')) &&
      headers.some((header) =>
        ['description', 'narration', 'details'].some((value) => header.includes(value)),
      ) &&
      headers.some((header) =>
        ['amount', 'debit', 'credit', 'withdrawal', 'deposit'].some((value) =>
          header.includes(value),
        ),
      ),
    parseRow: (row) =>
      parseStructuredRow(row, {
        date: ['date', 'transaction date', 'value date', 'posting date', 'trans date', 'tran date'],
        description: ['description', 'narration', 'details', 'transaction details'],
        debit: ['debit', 'withdrawal'],
        credit: ['credit', 'deposit'],
        amount: ['amount'],
        reference: ['reference', 'ref', 'tranid', 'trans ref'],
        balance: ['balance'],
      }),
  },
];

const resolveCsvParser = (headers, bankHint) => {
  const normalizedHeaders = headers.map(normalizeHeader);
  const hintedProfile = resolveBankProfile(bankHint);

  if (hintedProfile?.parserKey) {
    const hintedParser = CSV_PARSERS.find((parser) => parser.key === hintedProfile.parserKey);
    if (hintedParser?.match(normalizedHeaders)) {
      return hintedParser;
    }
  }

  return CSV_PARSERS.find((parser) => parser.match(normalizedHeaders)) || CSV_PARSERS[CSV_PARSERS.length - 1];
};

const detectBankFromHeaders = (headers) => {
  const matchedParser = resolveCsvParser(headers);
  return matchedParser ? matchedParser.bank : 'unknown';
};

const parseCSVWithMetadata = (fileBuffer, options = {}) =>
  new Promise((resolve, reject) => {
    const result = buildParserResult({
      bankHint: options.bankHint || null,
      headerText: '',
    });
    let parser = CSV_PARSERS[CSV_PARSERS.length - 1];
    let headers = [];

    Readable.from(fileBuffer.toString('utf8'))
      .pipe(csvParser())
      .on('headers', (incomingHeaders) => {
        headers = incomingHeaders;
        parser = resolveCsvParser(headers, options.bankHint);
        result.headerText = headers.join(', ');
        result.tableHeaders = headers;

        if (parser.bank !== 'generic') {
          const profile = findBankProfile(parser.bank);
          result.detectedBank = parser.bank;
          result.detectedBankDisplayName = profile?.displayName || parser.bank;
          result.bankDetectionConfidence = 'high';
          result.bankDetectionSource = 'csv_headers';
          result.parser = parser.key;
        } else {
          result.parser = parser.key;
        }
      })
      .on('data', (row) => {
        result.sourceRecordCount += 1;

        try {
          const transaction = parser.parseRow(row);
          if (!transaction) {
            result.skippedCount += 1;
            if (result.warnings.length < 20) {
              result.warnings.push(
                `Row ${result.sourceRecordCount} could not be parsed safely and was skipped.`,
              );
            }
            return;
          }

          result.validRecordCount += 1;
          result.transactions.push(transaction);
        } catch (error) {
          result.skippedCount += 1;
          if (result.warnings.length < 20) {
            result.warnings.push(`Row ${result.sourceRecordCount} failed to parse: ${error.message}`);
          }
        }
      })
      .on('end', async () => {
        try {
          if (result.detectedBank === 'unknown') {
            const identity = await classifyDocumentIdentity({
              bankHint: options.bankHint,
              fileName: options.fileName,
              headerText: headers.join(', '),
              rawText: fileBuffer.toString('utf8'),
              tableHeaders: headers,
            });
            Object.assign(result, attachIdentity(result, identity));
          }

          result.statementDateRange = buildTransactionDateRange(result.transactions);
          result.dateRange = result.statementDateRange;
          resolve(result);
        } catch (error) {
          reject(new Error(`CSV metadata classification failed: ${error.message}`));
        }
      })
      .on('error', (error) => reject(new Error(`CSV parsing failed: ${error.message}`)));
  });

const parsePDF = async (fileBuffer) => {
  try {
    const data = await pdfParse(fileBuffer);
    return data.text;
  } catch (error) {
    throw new Error(`PDF parsing failed: ${error.message}`);
  }
};

const matchLeadingDate = (value) =>
  String(value || '').match(
    /^(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2}\s+\d{2,4})\b/,
  );

const buildPdfRowBlocks = (text) => {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const blocks = [];
  let current = [];

  for (const line of lines) {
    if (matchLeadingDate(line)) {
      if (current.length) {
        blocks.push(current.join(' '));
      }
      current = [line];
      continue;
    }

    if (current.length) {
      current.push(line);
    }
  }

  if (current.length) {
    blocks.push(current.join(' '));
  }

  return blocks;
};

const AMOUNT_TOKEN_PATTERN = /([+-]?\(?[0-9,]+\.\d{2}\)?(?:\s?(?:CR|DR))?)/gi;

const inferDirectionFromLine = (line, amountToken) => {
  const normalized = line.toLowerCase();
  if (/\bdr\b/.test(normalized) || normalized.includes(' debit')) return 'debit';
  if (/\bcr\b/.test(normalized) || normalized.includes(' credit')) return 'credit';
  if (/^\s*-/.test(amountToken) || amountToken.includes('(')) return 'debit';
  if (/^\s*\+/.test(amountToken)) return 'credit';
  return null;
};

const parseRowAmounts = (rowBlock, amountMatches) => {
  const parsedAmounts = amountMatches
    .map((match) => ({
      token: match[0],
      index: match.index,
      amount: parseAmount(match[0]),
    }))
    .filter((match) => match.amount !== null);

  if (!parsedAmounts.length) {
    return null;
  }

  const annotated = parsedAmounts.find((match) => /\b(?:CR|DR)\b/i.test(match.token));
  if (annotated) {
    return {
      amount: Math.abs(annotated.amount),
      direction: inferDirectionFromLine(rowBlock, annotated.token),
      balance: parsedAmounts.length > 1 ? parsedAmounts[parsedAmounts.length - 1].amount : null,
      descriptionEndIndex: parsedAmounts[Math.max(0, parsedAmounts.length - 3)].index,
    };
  }

  if (parsedAmounts.length >= 3) {
    const debitCandidate = parsedAmounts[parsedAmounts.length - 3];
    const creditCandidate = parsedAmounts[parsedAmounts.length - 2];
    const balanceCandidate = parsedAmounts[parsedAmounts.length - 1];

    if (debitCandidate.amount > 0 && (!creditCandidate.amount || creditCandidate.amount === 0)) {
      return {
        amount: Math.abs(debitCandidate.amount),
        direction: 'debit',
        balance: balanceCandidate.amount,
        descriptionEndIndex: debitCandidate.index,
      };
    }

    if (creditCandidate.amount > 0 && (!debitCandidate.amount || debitCandidate.amount === 0)) {
      return {
        amount: Math.abs(creditCandidate.amount),
        direction: 'credit',
        balance: balanceCandidate.amount,
        descriptionEndIndex: debitCandidate.index,
      };
    }
  }

  const last = parsedAmounts[parsedAmounts.length - 1];
  return {
    amount: Math.abs(last.amount),
    direction: inferDirectionFromLine(rowBlock, last.token),
    balance: parsedAmounts.length > 1 ? parsedAmounts[parsedAmounts.length - 1].amount : null,
    descriptionEndIndex: parsedAmounts[Math.max(0, parsedAmounts.length - Math.min(parsedAmounts.length, 3))].index,
  };
};

const parsePdfRowBlock = (rowBlock) => {
  const dateMatch = matchLeadingDate(rowBlock);
  if (!dateMatch) {
    return null;
  }

  const date = parseDate(dateMatch[1]);
  const amountMatches = Array.from(rowBlock.matchAll(AMOUNT_TOKEN_PATTERN));
  const parsedAmounts = parseRowAmounts(rowBlock, amountMatches);

  if (!date || !parsedAmounts?.amount || !parsedAmounts.direction) {
    return null;
  }

  const description = rowBlock
    .slice(dateMatch[0].length, parsedAmounts.descriptionEndIndex || rowBlock.length)
    .replace(/\s+/g, ' ')
    .trim();

  if (!description) {
    return null;
  }

  return {
    date,
    description,
    amount: parsedAmounts.amount,
    type: parsedAmounts.direction,
    direction: parsedAmounts.direction,
    reference: '',
    balance: parsedAmounts.balance,
  };
};

const extractTransactionsFromPDFTextDetailed = (text, options = {}) => {
  let result = buildParserResult({
    parser: 'pdf_text_generic',
    rawText: String(text || ''),
    headerText: getHeaderText(text),
    bankHint: options.bankHint || null,
    statementDateRange: extractStatementDateRange(text),
  });

  const rowBlocks = buildPdfRowBlocks(text);

  for (const rowBlock of rowBlocks) {
    result.sourceRecordCount += 1;

    const transaction = parsePdfRowBlock(rowBlock);
    if (!transaction) {
      result.skippedCount += 1;
      if (result.warnings.length < 20) {
        result.warnings.push(
          `PDF row ${result.sourceRecordCount} could not be parsed safely and was skipped.`,
        );
      }
      continue;
    }

    result.validRecordCount += 1;
    result.transactions.push(transaction);
  }

  result.dateRange = result.statementDateRange || buildTransactionDateRange(result.transactions);
  result = attachIdentity(
    result,
    scoreDeterministicIdentity({
      bankHint: options.bankHint,
      fileName: options.fileName,
      headerText: result.headerText,
      rawText: result.rawText,
      tableHeaders: result.tableHeaders,
    }),
  );

  return assessDateQuality(result, text);
};

const extractTransactionsFromPDFText = (text) =>
  extractTransactionsFromPDFTextDetailed(text).transactions;

const parseStatementFile = async (fileBuffer, fileType, options = {}) => {
  if (fileType === 'csv') {
    return parseCSVWithMetadata(fileBuffer, options);
  }

  const text = await parsePDF(fileBuffer);
  let textResult = extractTransactionsFromPDFTextDetailed(text, options);
  const ocrDecision = shouldRunOcrForPdf(textResult);

  if (!ocrDecision.shouldUseOcr) {
    const textIdentity = await classifyDocumentIdentity({
      bankHint: options.bankHint,
      accountNumberHint: options.accountNumberHint,
      fileName: options.fileName,
      headerText: textResult.headerText,
      rawText: textResult.rawText,
      tableHeaders: [],
    });

    return attachIdentity({
      ...textResult,
      parserDiagnostics: {
        ocr: {
          attempted: false,
          selected: false,
          reason: 'text_parse_sufficient',
          providerTried: null,
        },
      },
    }, textIdentity);
  }

  try {
    const { extractTransactionsFromScannedPDFDetailed, validateExtractedTransactions } = require('./ocr.service');
    const ocrResult = await extractTransactionsFromScannedPDFDetailed(fileBuffer);
    const validated = validateExtractedTransactions(ocrResult.transactions);

    let ocrParsed = assessDateQuality(
      buildParserResult({
        transactions: validated.valid,
        sourceRecordCount: validated.totalExtracted,
        validRecordCount: validated.validCount,
        skippedCount: validated.invalidCount,
        parser: `pdf_ocr_${ocrResult.provider}`,
        ocrProvider: ocrResult.provider,
        headerText: ocrResult.headerText || textResult.headerText,
        rawText: ocrResult.rawText || text,
        tableHeaders: ocrResult.tableHeaders || [],
        bankHint: options.bankHint || null,
        statementDateRange:
          ocrResult.statementDateRange || textResult.statementDateRange || buildTransactionDateRange(validated.valid),
        dateRange:
          ocrResult.statementDateRange || textResult.statementDateRange || buildTransactionDateRange(validated.valid),
        qualityFlags: ['ocr_used'],
        warnings: [
          ...textResult.warnings,
          ocrDecision.reason
            ? `OCR was triggered because ${ocrDecision.reason.replace(/_/g, ' ')}.`
            : null,
          validated.invalidCount > 0
            ? `${validated.invalidCount} OCR row(s) were skipped because they were incomplete.`
            : null,
        ].filter(Boolean),
        parserDiagnostics: {
          ocr: {
            attempted: true,
            selected: false,
            reason: ocrDecision.reason,
            providerTried: ocrResult.provider,
          },
        },
      }),
      ocrResult.rawText || text,
    );
    ocrParsed = attachIdentity(
      ocrParsed,
      scoreDeterministicIdentity({
        bankHint: options.bankHint,
        fileName: options.fileName,
        headerText: ocrParsed.headerText,
        rawText: ocrParsed.rawText || text,
        tableHeaders: ocrParsed.tableHeaders,
      }),
    );

    const ocrImprovedBankConfidence =
      (BANK_CONFIDENCE_SCORE[ocrParsed.bankDetectionConfidence] || 0) >
      (BANK_CONFIDENCE_SCORE[textResult.bankDetectionConfidence] || 0);

    const finalResult =
      ocrParsed.validRecordCount > textResult.validRecordCount ||
      (ocrParsed.validRecordCount === textResult.validRecordCount &&
        (textResult.qualityFlags.includes('suspicious_date_collapse') || ocrImprovedBankConfidence))
        ? {
            ...ocrParsed,
            parserDiagnostics: {
              ocr: {
                attempted: true,
                selected: true,
                reason: ocrDecision.reason,
                providerTried: ocrResult.provider,
              },
            },
          }
        : assessDateQuality(
            {
              ...textResult,
              warnings: Array.from(
                new Set([
                  ...textResult.warnings,
                  'OCR fallback did not improve extraction enough, so the best text-based result was kept for review.',
                ]),
              ),
              qualityFlags: Array.from(new Set([...textResult.qualityFlags, 'ocr_fallback_not_selected'])),
              needsReview: true,
              parserDiagnostics: {
                ocr: {
                  attempted: true,
                  selected: false,
                  reason: ocrDecision.reason,
                  providerTried: ocrResult.provider,
                },
              },
            },
            text,
          );

    const identityEvidence = {
      bankHint: options.bankHint,
      accountNumberHint: options.accountNumberHint,
      fileName: options.fileName,
      headerText: finalResult.headerText,
      rawText: finalResult.rawText || text,
      tableHeaders: finalResult.tableHeaders || [],
    };
    const finalIdentity = await classifyDocumentIdentity(identityEvidence);

    return attachIdentity(finalResult, finalIdentity);
  } catch (error) {
    return {
      ...textResult,
      warnings: [...textResult.warnings, `OCR fallback was unavailable: ${error.message}`].slice(0, 50),
      qualityFlags: Array.from(new Set([...textResult.qualityFlags, 'ocr_unavailable'])),
      needsReview: true,
      parserDiagnostics: {
        ocr: {
          attempted: true,
          selected: false,
          reason: ocrDecision.reason,
          providerTried: null,
        },
      },
    };
  }
};

const parseCSV = async (fileBuffer, options = {}) => {
  const result = await parseCSVWithMetadata(fileBuffer, options);
  return result.transactions;
};

module.exports = {
  CSV_PARSERS,
  detectBankFromHeaders,
  extractStatementDateRange,
  extractTransactionsFromPDFText,
  extractTransactionsFromPDFTextDetailed,
  getHeaderText,
  parseAmount,
  parseCSV,
  parseCSVWithMetadata,
  parseDate,
  parsePDF,
  parseStatementFile,
};
