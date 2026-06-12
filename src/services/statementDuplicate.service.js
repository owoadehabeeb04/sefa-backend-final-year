const crypto = require('crypto');

const Expense = require('../models/Expense');
const ImportedTransactionMap = require('../models/ImportedTransactionMap');
const Income = require('../models/Income');
const { isSimilar, normalizeDescription } = require('../utils/stringMatch');

const buildDuplicateHash = (userId, row) => {
  const hash = crypto.createHash('sha256');
  hash.update(
    [
      String(userId),
      new Date(row.transactionDate || Date.now()).toISOString().slice(0, 10),
      Number(row.amount || 0).toFixed(2),
      normalizeDescription(row.description || row.rawDescription || ''),
      row.balance !== null && row.balance !== undefined ? Number(row.balance || 0).toFixed(2) : '',
      normalizeDescription(row.counterParty || ''),
    ].join('|'),
  );
  return hash.digest('hex').slice(0, 24);
};

const isExistingTransactionDuplicate = async (userId, row, normalizedDescription) => {
  const start = new Date(row.transactionDate || Date.now());
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);

  const [expenses, incomes] = await Promise.all([
    Expense.find({
      userId,
      amount: row.amount,
      date: { $gte: start, $lte: end },
    }).select('description'),
    Income.find({
      userId,
      amount: row.amount,
      date: { $gte: start, $lte: end },
    }).select('description'),
  ]);

  const candidates = [...expenses, ...incomes];
  return candidates.some((candidate) =>
    isSimilar(normalizeDescription(candidate.description || ''), normalizedDescription, 90),
  );
};

const detectDuplicateForRow = async (userId, row) => {
  const duplicateHash = row.duplicateHash || buildDuplicateHash(userId, row);
  const normalizedDescription = normalizeDescription(row.description || row.rawDescription || '');

  if (row.transactionId) {
    const mapping = await ImportedTransactionMap.findOne({
      userId,
      externalId: row.transactionId,
    }).select('_id');

    if (mapping) {
      return { duplicateHash, isDuplicate: true, reason: 'matching_transaction_id' };
    }
  }

  const existingRow = await ImportedTransactionMap.findOne({
    userId,
    externalId: duplicateHash,
  }).select('_id');

  if (existingRow) {
    return { duplicateHash, isDuplicate: true, reason: 'matching_duplicate_hash' };
  }

  const existsInTransactions = await isExistingTransactionDuplicate(userId, row, normalizedDescription);
  if (existsInTransactions) {
    return { duplicateHash, isDuplicate: true, reason: 'matching_existing_transaction' };
  }

  return { duplicateHash, isDuplicate: false, reason: null };
};

module.exports = {
  buildDuplicateHash,
  detectDuplicateForRow,
};
