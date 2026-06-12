const { containsTransferKeywords } = require('../utils/stringMatch');

const normalizeLower = (value) => String(value || '').trim().toLowerCase();

const INCOMING_TRANSFER_KEYWORDS = [
  'transfer from',
  'received from',
  'tfr from',
  'trf from',
  'from wallet',
];

const OUTGOING_TRANSFER_KEYWORDS = [
  'transfer to',
  'sent to',
  'tfr to',
  'trf to',
  'wallet topup',
  'wallet top up',
  'fund transfer',
];

const resolveTransferClassification = (description, direction) => {
  const lowered = normalizeLower(description);

  if (INCOMING_TRANSFER_KEYWORDS.some((keyword) => lowered.includes(keyword))) {
    return {
      direction: direction === 'unknown' ? 'credit' : direction,
      classification: 'income',
    };
  }

  if (OUTGOING_TRANSFER_KEYWORDS.some((keyword) => lowered.includes(keyword))) {
    return {
      direction: direction === 'unknown' ? 'debit' : direction,
      classification: 'expense',
    };
  }

  if (direction === 'credit') {
    return {
      direction,
      classification: 'income',
    };
  }

  if (direction === 'debit') {
    return {
      direction,
      classification: 'expense',
    };
  }

  return {
    direction,
    classification: 'unknown',
  };
};

const classifyStatementRow = (row) => {
  const rawAmount = Number(row.amount || 0);
  const debit = Number(row.debit || 0);
  const credit = Number(row.credit || 0);
  const description = `${row.description || ''} ${row.transactionType || ''}`.trim();

  let direction = 'unknown';
  let classification = 'unknown';
  const validationErrors = [];

  if (rawAmount < 0) {
    direction = 'debit';
    classification = 'expense';
  } else if (rawAmount > 0 && debit === 0 && credit === 0) {
    direction = 'credit';
    classification = 'income';
  }

  if (debit > 0 && credit === 0) {
    direction = 'debit';
    classification = 'expense';
  } else if (credit > 0 && debit === 0) {
    direction = 'credit';
    classification = 'income';
  } else if (debit > 0 && credit > 0) {
    validationErrors.push('Row contains both debit and credit values');
  }

  const lowered = normalizeLower(description);
  if (
    containsTransferKeywords(lowered)
    || lowered.includes('internal transfer')
    || lowered.includes('wallet topup')
  ) {
    const transferResolution = resolveTransferClassification(lowered, direction);
    direction = transferResolution.direction;
    classification = transferResolution.classification;
  }

  if (!row.transactionDate || Number.isNaN(new Date(row.transactionDate).getTime())) {
    validationErrors.push('Missing transaction date');
  }

  if (!Number(row.amount || 0)) {
    validationErrors.push('Missing amount');
  }

  if (direction === 'unknown') {
    validationErrors.push('Could not determine whether this row is debit or credit');
  }

  return {
    direction,
    classification,
    validationErrors,
  };
};

module.exports = {
  classifyStatementRow,
};
