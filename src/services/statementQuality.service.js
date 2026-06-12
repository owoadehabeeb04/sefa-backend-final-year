const { parseStatementText } = require('./statementParser.service');
const { DATE_PREFIX_REGEX } = require('./statementStructure.service');

const KEYWORDS = [
  'debit',
  'credit',
  'balance',
  'transaction',
  'date',
  'amount',
  'trans.date',
  'trans.type',
  'counter party',
  'trans.id',
];

const MONEY_REGEX = /(?:NGN|₦)?\s*[-+]?\d[\d,]*(?:\.\d{1,2})?/gi;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const scoreStatementTextQuality = (text) => {
  const safeText = String(text || '').trim();
  const lowered = safeText.toLowerCase();
  const lines = safeText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const parseResult = parseStatementText(safeText);

  const dateHits = (safeText.match(new RegExp(DATE_PREFIX_REGEX, 'gm')) || []).length;
  const moneyHits = (safeText.match(MONEY_REGEX) || []).length;
  const keywordHits = KEYWORDS.filter((keyword) => lowered.includes(keyword)).length;
  const parsedRatio =
    (parseResult.metrics.candidateCount || parseResult.metrics.blockCount || 0) > 0
      ? parseResult.metrics.parsedCount / (parseResult.metrics.candidateCount || parseResult.metrics.blockCount || 1)
      : 0;

  let score = 0;
  const issues = [];

  if (safeText.length >= 120) score += 0.15;
  else issues.push('Extracted text is too short');

  if (dateHits > 0) score += 0.25;
  else issues.push('No valid transaction dates found');

  if (moneyHits >= 2) score += 0.2;
  else issues.push('No reliable money amounts found');

  if ((parseResult.metrics.candidateCount || parseResult.metrics.blockCount || 0) > 0) score += 0.15;
  else issues.push('No transaction-like rows found');

  if (keywordHits >= 2) score += 0.1;
  else issues.push('Statement structure keywords are missing');

  score += clamp(parsedRatio, 0, 1) * 0.15;
  if (parsedRatio < 0.4) {
    issues.push('Too few rows could be parsed confidently');
  }

  if (lines.length < 5) {
    issues.push('Extracted content is too sparse');
  }

  return {
    score: Number(clamp(score, 0, 1).toFixed(2)),
    issues,
    signals: {
      dateHits,
      moneyHits,
      keywordHits,
      lineCount: lines.length,
      blockCount: parseResult.metrics.candidateCount || parseResult.metrics.blockCount || 0,
      parsedRatio: Number(parsedRatio.toFixed(2)),
    },
  };
};

module.exports = {
  scoreStatementTextQuality,
};
